/**
 * Run tasks with a fixed worker pool.
 *
 * Fetching 200 strangers' websites is the one place this project touches
 * machines it does not own, so the pool size is a politeness setting as much as
 * a performance one. Results come back in input order regardless of completion
 * order, so a run is reproducible.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`mapPool: limit must be a positive integer, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      // The bounds check above is the only end condition. Testing the element
      // for undefined instead would end the worker early on a legitimately
      // undefined item and silently abandon every item after it in that
      // worker's share — a missing lead that never reports itself.
      results[index] = await worker(items[index] as T, index);
      done += 1;
      onProgress?.(done, items.length);
    }
  });

  await Promise.all(runners);
  return results;
}

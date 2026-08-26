import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/lib/concurrency.ts';

/**
 * The pool used to end a worker on `items[index] === undefined`, conflating "we
 * ran off the end of the list" with "this element happens to be undefined". A
 * single undefined item silently retired a worker and abandoned every item
 * still in its share — leads that disappear without an error to explain them.
 */

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('mapPool', () => {
  it('processes an undefined item instead of stopping at it', async () => {
    const items: (string | undefined)[] = ['a', undefined, 'c'];
    const out = await mapPool(items, 2, async (item) => String(item));
    expect(out).toEqual(['a', 'undefined', 'c']);
  });

  it('does not abandon the tail after an undefined item', async () => {
    // One worker, so everything after the hole is in that worker's share. This
    // is the shape that lost whole runs of prospects.
    const items: (number | undefined)[] = [1, undefined, 3, 4, 5];
    const seen: unknown[] = [];
    await mapPool(items, 1, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen).toEqual([1, undefined, 3, 4, 5]);
  });

  it('returns results in input order however they finish', async () => {
    const delays = [30, 0, 15, 5];
    const out = await mapPool(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('never runs more than `limit` at once', async () => {
    let live = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await tick();
      live -= 1;
      return null;
    });
    expect(peak).toBe(3);
  });

  it('reports progress once per completed item', async () => {
    const progress: number[] = [];
    await mapPool([1, 2, 3, 4], 2, async (n) => n, (done) => progress.push(done));
    expect(progress.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('handles an empty list without spawning a worker', async () => {
    expect(await mapPool([], 4, async () => 'never')).toEqual([]);
  });

  it('refuses a nonsense limit rather than hanging', async () => {
    await expect(mapPool([1], 0, async (n) => n)).rejects.toThrow('positive integer');
    await expect(mapPool([1], 1.5, async (n) => n)).rejects.toThrow('positive integer');
  });
});

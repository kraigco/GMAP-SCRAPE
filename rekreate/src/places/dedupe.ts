/**
 * Tiles overlap at their shared edges, and the same business is routinely
 * returned by several keywords. Deduping on `place_id` is what turns a pile of
 * per-tile responses into a lead list (constraint 1).
 *
 * First occurrence wins, and insertion order is preserved so a run is
 * reproducible. PURE.
 */
export function dedupeById<T extends { id: string }>(
  batches: Iterable<readonly T[]>,
): { unique: T[]; duplicatesDropped: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicatesDropped = 0;

  for (const batch of batches) {
    for (const item of batch) {
      if (seen.has(item.id)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(item.id);
      unique.push(item);
    }
  }

  return { unique, duplicatesDropped };
}

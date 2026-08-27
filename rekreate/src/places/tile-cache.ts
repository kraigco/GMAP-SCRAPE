import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BBox } from '../lib/bbox.ts';
import type { RawPlace } from './schema.ts';

/**
 * What each tile of each sweep returned, kept on disk for a week.
 *
 * This is one mechanism doing two jobs, because they are the same job:
 *
 *   CACHE   — re-running a sweep over ground already covered costs nothing.
 *             The same (term, tile) inside the TTL replays from disk.
 *   RESUME  — a sweep stopped by the daily budget, an error or a closed tab
 *             leaves its finished tiles here. The next run walks the identical
 *             tree, replays those for free, and spends its budget only on the
 *             tiles nobody has paid for yet.
 *
 * Treating resume as a separate "which tiles are done" file would be a second
 * source of truth for the same fact, and the two would drift the first time a
 * run died between writing one and the other. A cached tile IS a done tile.
 *
 * The TTL exists because Google's terms cap how long their data may be held,
 * and because a month-old tile is a lie about a market that has moved. Seven
 * days is well inside the 30-day limit on cached Google fields.
 */

/** Where the cache lives. Under out/, which is gitignored — local state. */
export const TILE_CACHE_PATH = 'out/tile-cache.json';

export const CACHE_TTL_DAYS = 7;

export type CachedTile = {
  /** When this tile was fetched, ISO. */
  at: string;
  places: RawPlace[];
  /** Google held back results — the tile needs splitting, and that must survive a reload. */
  truncated: boolean;
};

export type TileCache = Record<string, CachedTile>;

/**
 * A stable key for one tile of one search term.
 *
 * Coordinates are rounded to six decimals (~11cm) before they reach the key.
 * The quadrant arithmetic is floating point, so the same logical tile can come
 * back as ...49999997 on one run and ...50000001 on the next; unrounded, every
 * resumed sweep would miss every cache entry and quietly pay full price while
 * appearing to work perfectly.
 */
export function tileKey(term: string, bbox: BBox): string {
  const r = (n: number): string => n.toFixed(6);
  return `${term.trim().toLowerCase()}|${r(bbox.swLat)},${r(bbox.swLng)},${r(bbox.neLat)},${r(bbox.neLng)}`;
}

/** True when an entry is still inside the TTL. */
export function isFresh(entry: CachedTile, now: Date, ttlDays: number = CACHE_TTL_DAYS): boolean {
  const at = new Date(entry.at).getTime();
  if (Number.isNaN(at)) return false;
  return now.getTime() - at < ttlDays * 24 * 60 * 60 * 1000;
}

/** Drop everything past the TTL. Pure, so the sweeping is testable without a disk. */
export function prune(cache: TileCache, now: Date, ttlDays: number = CACHE_TTL_DAYS): TileCache {
  const kept: TileCache = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (isFresh(entry, now, ttlDays)) kept[key] = entry;
  }
  return kept;
}

export async function load(path: string = TILE_CACHE_PATH): Promise<TileCache> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const cache: TileCache = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<CachedTile>;
      // A malformed entry is dropped rather than trusted. The cost of dropping
      // one is a single API call; the cost of trusting one is a sweep built on
      // whatever happened to be in the file.
      if (typeof entry?.at === 'string' && Array.isArray(entry.places)) {
        cache[key] = { at: entry.at, places: entry.places as RawPlace[], truncated: entry.truncated === true };
      }
    }
    return cache;
  } catch {
    // No cache yet, or an unreadable one. Starting empty costs calls; refusing
    // to run costs the whole sweep.
    return {};
  }
}

export async function save(cache: TileCache, path: string = TILE_CACHE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export type TileFetch = (bbox: BBox) => Promise<{ items: RawPlace[]; truncated: boolean }>;

export type CachingSweep = {
  /** Wraps a tile fetch so a cached tile never reaches the network. */
  fetcher(term: string, inner: TileFetch): TileFetch;
  /** Tiles served from disk this run — calls that were not paid for. */
  hits(): number;
  /** Tiles that went to Google this run. */
  misses(): number;
  /** Write everything back, pruned. */
  flush(): Promise<void>;
};

/**
 * Wrap a sweep's tile fetches in the cache.
 *
 * Deliberately NOT built into the Places client: the client's job is to speak
 * HTTP to Google correctly, and a client that sometimes does not call Google is
 * a client whose call counter means two different things. Keeping the cache
 * outside it means `callsUsed` stays exactly "requests issued", which is the
 * number the budget and the ledger are both counting.
 */
export function cachingSweep(
  cache: TileCache,
  opts: { path?: string; now?: Date; ttlDays?: number } = {},
): CachingSweep {
  const now = opts.now ?? new Date();
  const ttlDays = opts.ttlDays ?? CACHE_TTL_DAYS;
  const path = opts.path ?? TILE_CACHE_PATH;
  let hits = 0;
  let misses = 0;

  return {
    fetcher(term, inner) {
      return async (bbox) => {
        const key = tileKey(term, bbox);
        const cached = cache[key];
        if (cached && isFresh(cached, now, ttlDays)) {
          hits += 1;
          return { items: cached.places, truncated: cached.truncated };
        }
        const fresh = await inner(bbox);
        misses += 1;
        cache[key] = { at: now.toISOString(), places: fresh.items, truncated: fresh.truncated };
        return fresh;
      };
    },
    hits: () => hits,
    misses: () => misses,
    flush: () => save(prune(cache, now, ttlDays), path),
  };
}

/**
 * A cache that caches nothing.
 *
 * The default when no path is supplied. A library function that silently reads
 * and writes a file in the working directory is a trap: the test suite shared
 * one cache across every case, so tiles fetched by one test replayed in the
 * next and the assertions counting real requests all saw zero. Persistence is
 * now something a caller opts into by naming a file, which makes the two
 * production entry points the only things that touch disk.
 */
export function noCache(): CachingSweep {
  return {
    fetcher: (_term, inner) => inner,
    hits: () => 0,
    misses: () => 0,
    flush: async () => {},
  };
}

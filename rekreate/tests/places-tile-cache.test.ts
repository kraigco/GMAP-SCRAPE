import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachingSweep,
  isFresh,
  load,
  noCache,
  prune,
  save,
  tileKey,
  TILE_CACHE_PATH,
} from '../src/places/tile-cache.ts';
import type { BBox } from '../src/lib/bbox.ts';
import type { RawPlace } from '../src/places/schema.ts';

/**
 * The tile cache is the resume mechanism, so these tests are really about one
 * promise: ground already paid for is never paid for twice.
 */

let dir = '';
let path = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tiles-'));
  path = join(dir, 'tile-cache.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BOX: BBox = { swLat: 39.5, swLng: -75.5, neLat: 40.5, neLng: -74.5 };
const NOW = new Date('2026-08-27T12:00:00Z');

function places(n: number): RawPlace[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}` }) as RawPlace);
}

describe('tileKey', () => {
  it('is stable for the same term and box', () => {
    expect(tileKey('dentist', BOX)).toBe(tileKey('dentist', BOX));
  });

  it('rounds away floating-point drift from the quadrant arithmetic', () => {
    // The bug this prevents: quartering a box produces 39.499999999999996 on
    // one run and 39.5 on the next, so a resumed sweep misses every entry and
    // silently pays full price while looking like it worked.
    const drifted: BBox = { ...BOX, swLat: 39.5 + 1e-12 };
    expect(tileKey('dentist', drifted)).toBe(tileKey('dentist', BOX));
  });

  it('separates different terms over identical ground', () => {
    expect(tileKey('dentist', BOX)).not.toBe(tileKey('roofer', BOX));
  });

  it('separates different ground for the same term', () => {
    const other: BBox = { ...BOX, neLat: 41 };
    expect(tileKey('dentist', BOX)).not.toBe(tileKey('dentist', other));
  });

  it('ignores case and surrounding space in the term', () => {
    expect(tileKey('  Dentist ', BOX)).toBe(tileKey('dentist', BOX));
  });
});

describe('the TTL', () => {
  const entry = (at: string) => ({ at, places: [], truncated: false });

  it('keeps an entry inside seven days', () => {
    expect(isFresh(entry('2026-08-25T12:00:00Z'), NOW)).toBe(true);
  });

  it('drops one past seven days', () => {
    expect(isFresh(entry('2026-08-19T11:00:00Z'), NOW)).toBe(false);
  });

  it('treats an unparseable timestamp as stale rather than trusting it', () => {
    expect(isFresh(entry('not a date'), NOW)).toBe(false);
  });

  it('prune removes only the expired entries', () => {
    const pruned = prune(
      { fresh: entry('2026-08-26T12:00:00Z'), old: entry('2026-01-01T00:00:00Z') },
      NOW,
    );
    expect(Object.keys(pruned)).toEqual(['fresh']);
  });
});

describe('a cached tile is never fetched twice', () => {
  it('calls Google once and replays the second time', async () => {
    let fetched = 0;
    const inner = async () => {
      fetched += 1;
      return { items: places(3), truncated: false };
    };

    const cache = cachingSweep({}, { path, now: NOW });
    const first = await cache.fetcher('dentist', inner)(BOX);
    const second = await cache.fetcher('dentist', inner)(BOX);

    expect(fetched).toBe(1);
    expect(second.items).toHaveLength(3);
    expect(first.items).toEqual(second.items);
    expect(cache.hits()).toBe(1);
    expect(cache.misses()).toBe(1);
  });

  it('preserves `truncated`, so a resumed sweep still knows to split', async () => {
    // Losing this would make a resumed sweep treat a full tile as a finished
    // one and silently under-cover the densest part of the market.
    const inner = async () => ({ items: places(20), truncated: true });
    const cache = cachingSweep({}, { path, now: NOW });

    await cache.fetcher('dentist', inner)(BOX);
    const replayed = await cache.fetcher('dentist', inner)(BOX);

    expect(replayed.truncated).toBe(true);
  });

  it('refetches once the entry is stale', async () => {
    let fetched = 0;
    const inner = async () => {
      fetched += 1;
      return { items: places(1), truncated: false };
    };
    const stale = { [tileKey('dentist', BOX)]: { at: '2026-01-01T00:00:00Z', places: places(9), truncated: false } };

    const cache = cachingSweep(stale, { path, now: NOW });
    const out = await cache.fetcher('dentist', inner)(BOX);

    expect(fetched).toBe(1);
    expect(out.items).toHaveLength(1);
  });
});

describe('a halted sweep resumes instead of restarting', () => {
  it('replays every tile the first run finished, at zero cost', async () => {
    const inner = async () => ({ items: places(2), truncated: false });
    const boxes: BBox[] = [
      BOX,
      { swLat: 39.5, swLng: -75.5, neLat: 40, neLng: -75 },
      { swLat: 40, swLng: -75, neLat: 40.5, neLng: -74.5 },
    ];

    // Run one: covers three tiles, then "stops" — the budget ran out.
    const first = cachingSweep(await load(path), { path, now: NOW });
    for (const b of boxes) await first.fetcher('dentist', inner)(b);
    await first.flush();
    expect(first.misses()).toBe(3);

    // Run two, next day: the same ground, and not one call for it.
    let fetchedAgain = 0;
    const countingInner = async () => {
      fetchedAgain += 1;
      return { items: places(2), truncated: false };
    };
    const second = cachingSweep(await load(path), { path, now: NOW });
    for (const b of boxes) await second.fetcher('dentist', countingInner)(b);

    expect(fetchedAgain).toBe(0);
    expect(second.hits()).toBe(3);
  });

  it('pays only for the tiles the first run never reached', async () => {
    const inner = async () => ({ items: places(2), truncated: false });
    const done: BBox = BOX;
    const pending: BBox = { swLat: 41, swLng: -76, neLat: 42, neLng: -75 };

    const first = cachingSweep(await load(path), { path, now: NOW });
    await first.fetcher('dentist', inner)(done);
    await first.flush();

    const second = cachingSweep(await load(path), { path, now: NOW });
    await second.fetcher('dentist', inner)(done);
    await second.fetcher('dentist', inner)(pending);

    expect(second.hits()).toBe(1);
    expect(second.misses()).toBe(1);
  });

  it('prunes expired tiles when it writes', async () => {
    await save(
      { old: { at: '2026-01-01T00:00:00Z', places: [], truncated: false } },
      path,
    );
    const cache = cachingSweep(await load(path), { path, now: NOW });
    await cache.flush();

    expect(Object.keys(JSON.parse(await readFile(path, 'utf8')))).toEqual([]);
  });
});

describe('the cache fails safe', () => {
  it('starts empty rather than throwing on an unreadable file', async () => {
    await writeFile(path, 'not json', 'utf8');
    expect(await load(path)).toEqual({});
  });

  it('drops a malformed entry rather than trusting it', async () => {
    await writeFile(path, JSON.stringify({ good: { at: NOW.toISOString(), places: [] }, bad: { at: 5 } }), 'utf8');
    expect(Object.keys(await load(path))).toEqual(['good']);
  });

  it('noCache touches no disk and reports nothing cached', async () => {
    let fetched = 0;
    const inner = async () => {
      fetched += 1;
      return { items: places(1), truncated: false };
    };
    const cache = noCache();

    await cache.fetcher('dentist', inner)(BOX);
    await cache.fetcher('dentist', inner)(BOX);
    await cache.flush();

    // Twice, because nothing is remembered — that is the point of the default.
    expect(fetched).toBe(2);
    expect(cache.hits()).toBe(0);
  });

  it('lives under out/, which is gitignored', () => {
    expect(TILE_CACHE_PATH.startsWith('out/')).toBe(true);
  });
});

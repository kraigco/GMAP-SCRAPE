import { describe, expect, it } from 'vitest';
import type { BBox } from '../src/lib/bbox.ts';
import { isSplittable, quadrants } from '../src/lib/bbox.ts';
import { sweepTiles } from '../src/places/tiling.ts';
import { dedupeById } from '../src/places/dedupe.ts';

/** Greater Philadelphia core — the first target market. */
const PHILLY: BBox = { swLat: 39.867, swLng: -75.28, neLat: 40.138, neLng: -74.956 };

/** The next representable float above x — one ULP, whatever the magnitude. */
function nextUp(x: number): number {
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const u = new BigUint64Array(buf);
  f[0] = x;
  u[0] = x >= 0 ? u[0]! + 1n : u[0]! - 1n;
  return f[0]!;
}

/** A searcher that always reports the same truncation verdict. */
const always = (truncated: boolean, items: { id: string }[] = []) =>
  async (): Promise<{ items: { id: string }[]; truncated: boolean }> => ({ items, truncated });

describe('sweepTiles — splitting', () => {
  it('splits a truncated tile into exactly four children', async () => {
    // Root is truncated; children are not, so recursion stops at depth 1.
    const search = async (b: BBox) => ({
      items: [{ id: `p${b.swLat}` }],
      truncated: b.swLat === PHILLY.swLat && b.neLat === PHILLY.neLat,
    });
    const sweep = await sweepTiles(PHILLY, search, { maxDepth: 4 });

    expect(sweep.tilesSplit).toBe(1);
    expect(sweep.nodes.filter((n) => n.depth === 1)).toHaveLength(4);
    expect(sweep.nodes).toHaveLength(5);
    expect(sweep.truncatedLeaves).toBe(0);
  });

  it('does not split a tile that came back complete', async () => {
    const sweep = await sweepTiles(PHILLY, always(false, [{ id: 'a' }]), { maxDepth: 4 });

    expect(sweep.tilesSearched).toBe(1);
    expect(sweep.tilesSplit).toBe(0);
    expect(sweep.nodes[0]?.bbox).toEqual(PHILLY);
    expect(sweep.items.map((i) => i.id)).toEqual(['a']);
  });

  it('keeps results from every tile it visited, parents included', async () => {
    const search = async (b: BBox) => ({
      items: [{ id: `${b.swLat},${b.swLng}` }],
      truncated: b.neLat - b.swLat > 0.2,
    });
    const sweep = await sweepTiles(PHILLY, search, { maxDepth: 1 });

    // Nothing paid for is thrown away — the parent's 1 plus four children.
    expect(sweep.items).toHaveLength(5);
  });
});

describe('sweepTiles — bounded recursion (constraint 6)', () => {
  it('stops at maxDepth even when every tile stays truncated', async () => {
    const sweep = await sweepTiles(PHILLY, always(true), { maxDepth: 2 });

    // 1 root + 4 + 16
    expect(sweep.tilesSearched).toBe(21);
    expect(sweep.tilesSplit).toBe(5);
    expect(sweep.maxDepthHit).toBe(2);
    expect(sweep.nodes.filter((n) => !n.split)).toHaveLength(16);
  });

  it('never splits at maxDepth 0', async () => {
    const sweep = await sweepTiles(PHILLY, always(true), { maxDepth: 0 });

    expect(sweep.tilesSearched).toBe(1);
    expect(sweep.tilesSplit).toBe(0);
    expect(sweep.nodes[0]?.splitBlockedBy).toBe('maxDepth');
  });

  it('reports truncated leaves so blind spots are never silent', async () => {
    const sweep = await sweepTiles(PHILLY, always(true), { maxDepth: 2 });

    expect(sweep.truncatedLeaves).toBe(16);
    expect(sweep.nodes.filter((n) => !n.split).every((n) => n.splitBlockedBy === 'maxDepth')).toBe(
      true,
    );
  });

  it('halts the whole sweep the moment the budget is spent', async () => {
    let calls = 0;
    const search = async (): Promise<{ items: never[]; truncated: boolean }> => {
      calls += 1;
      return { items: [], truncated: true };
    };
    // Budget of 3 against a tree that would otherwise visit 21 tiles.
    const sweep = await sweepTiles(PHILLY, search, {
      maxDepth: 2,
      shouldHalt: () => calls >= 3,
    });

    expect(calls).toBe(3);
    expect(sweep.halted).toBe(true);
    expect(sweep.tilesSearched).toBeLessThan(21);
  });

  it('rejects a nonsense maxDepth rather than looping', async () => {
    await expect(sweepTiles(PHILLY, always(true), { maxDepth: -1 })).rejects.toThrow(/maxDepth/);
  });

  it('rejects an inverted bbox instead of tiling it backwards', async () => {
    const inverted: BBox = { swLat: 40.138, swLng: -74.956, neLat: 39.867, neLng: -75.28 };
    await expect(sweepTiles(inverted, always(false), { maxDepth: 2 })).rejects.toThrow(
      /Invalid root bbox/,
    );
  });
});

describe('quadrants', () => {
  it('tiles the parent exactly — no gap, no overlap', () => {
    const [sw, se, nw, ne] = quadrants(PHILLY);
    const midLat = (PHILLY.swLat + PHILLY.neLat) / 2;
    const midLng = (PHILLY.swLng + PHILLY.neLng) / 2;

    expect(sw).toEqual({ swLat: PHILLY.swLat, swLng: PHILLY.swLng, neLat: midLat, neLng: midLng });
    expect(se).toEqual({ swLat: PHILLY.swLat, swLng: midLng, neLat: midLat, neLng: PHILLY.neLng });
    expect(nw).toEqual({ swLat: midLat, swLng: PHILLY.swLng, neLat: PHILLY.neLat, neLng: midLng });
    expect(ne).toEqual({ swLat: midLat, swLng: midLng, neLat: PHILLY.neLat, neLng: PHILLY.neLng });
  });

  it('refuses to split a box already collapsed to float precision', async () => {
    const hair: BBox = {
      swLat: 39.867,
      swLng: -75.28,
      neLat: nextUp(39.867),
      neLng: nextUp(-75.28),
    };
    expect(isSplittable(hair)).toBe(false);

    const sweep = await sweepTiles(hair, always(true), { maxDepth: 40 });
    expect(sweep.tilesSearched).toBe(1);
    expect(sweep.nodes[0]?.splitBlockedBy).toBe('precision');
  });
});

describe('dedupeById', () => {
  it('counts a place found in two overlapping tiles once', () => {
    const tileA = [{ id: 'ChIJ_aaa' }, { id: 'ChIJ_bbb' }];
    const tileB = [{ id: 'ChIJ_bbb' }, { id: 'ChIJ_ccc' }];

    const { unique, duplicatesDropped } = dedupeById([tileA, tileB]);

    expect(unique.map((p) => p.id)).toEqual(['ChIJ_aaa', 'ChIJ_bbb', 'ChIJ_ccc']);
    expect(duplicatesDropped).toBe(1);
  });

  it('keeps the first occurrence and preserves order', () => {
    const first = [{ id: 'x', keyword: 'property management' }];
    const second = [{ id: 'x', keyword: 'apartment rental' }];

    const { unique } = dedupeById([first, second]);

    expect(unique).toHaveLength(1);
    expect(unique[0]?.keyword).toBe('property management');
  });

  it('handles an empty sweep', () => {
    expect(dedupeById([])).toEqual({ unique: [], duplicatesDropped: 0 });
  });
});

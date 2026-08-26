import type { BBox } from '../lib/bbox.ts';
import { assertValidBBox, isSplittable, quadrants } from '../lib/bbox.ts';

/**
 * Recursive rectangle tiling (constraint 1).
 *
 * Text Search returns at most 60 results for any query, so a tile that comes
 * back saturated is not a complete answer — it is a truncated one. The fix is
 * to split it into quadrants and ask again, until every tile comes back
 * complete or we run out of depth.
 *
 * Splitting is driven by the searcher reporting `truncated`, not by counting
 * results and re-querying. Counting first would mean paying for every tile
 * twice, and the searcher already knows the answer: it saw whether a
 * `nextPageToken` was still outstanding when Google's 3-page ceiling hit.
 *
 * The searcher is injected, so in production it is the API-backed client and in
 * tests it is a fixture. That is what makes "a saturated tile splits into
 * exactly 4" verifiable without spending a call.
 */

/** Why a truncated tile was left unsplit. `null` means it was not truncated. */
export type SplitBlocker = 'maxDepth' | 'precision' | 'halted' | null;

export type TileNode = {
  bbox: BBox;
  depth: number;
  itemCount: number;
  truncated: boolean;
  /** True when this node was subdivided. */
  split: boolean;
  splitBlockedBy: SplitBlocker;
};

export type TileSearchResult<T> = {
  items: T[];
  /** The searcher could not see everything in this box. */
  truncated: boolean;
};

export type TileSearch<T> = (bbox: BBox) => Promise<TileSearchResult<T>>;

export type SweepOptions = {
  /** Recursion floor. 0 means never split. */
  maxDepth: number;
  /**
   * Checked before each tile. Returning true halts the whole sweep — used to
   * stop the moment the call budget is spent, rather than splitting further
   * and burning the remainder on tiles we cannot finish (constraint 6).
   */
  shouldHalt?: () => boolean;
};

export type SweepResult<T> = {
  /** Every tile visited, parents included, in traversal order. */
  nodes: TileNode[];
  /** Everything found, in traversal order. NOT deduped — see dedupeById. */
  items: T[];
  tilesSearched: number;
  tilesSplit: number;
  maxDepthHit: number;
  /**
   * Leaves still truncated — boxes we KNOW hold more than we retrieved and
   * could not subdivide. Non-zero means the sweep has blind spots, and the
   * caller must report that rather than present a clean total.
   */
  truncatedLeaves: number;
  /** The sweep stopped early because shouldHalt fired. */
  halted: boolean;
};

export async function sweepTiles<T>(
  root: BBox,
  search: TileSearch<T>,
  opts: SweepOptions,
): Promise<SweepResult<T>> {
  assertValidBBox(root, 'root bbox');
  if (!Number.isInteger(opts.maxDepth) || opts.maxDepth < 0) {
    throw new Error(`maxDepth must be a non-negative integer, got ${opts.maxDepth}`);
  }
  const shouldHalt = opts.shouldHalt ?? ((): boolean => false);

  const nodes: TileNode[] = [];
  const items: T[] = [];
  let halted = false;

  const visit = async (bbox: BBox, depth: number): Promise<void> => {
    if (halted || shouldHalt()) {
      halted = true;
      return;
    }

    const result = await search(bbox);
    items.push(...result.items);

    let splitBlockedBy: SplitBlocker = null;
    if (result.truncated) {
      if (depth >= opts.maxDepth) splitBlockedBy = 'maxDepth';
      else if (!isSplittable(bbox)) splitBlockedBy = 'precision';
      else if (shouldHalt()) splitBlockedBy = 'halted';
    }
    const split = result.truncated && splitBlockedBy === null;

    nodes.push({
      bbox,
      depth,
      itemCount: result.items.length,
      truncated: result.truncated,
      split,
      splitBlockedBy,
    });

    if (split) {
      for (const quadrant of quadrants(bbox)) await visit(quadrant, depth + 1);
    }
  };

  await visit(root, 0);

  const leaves = nodes.filter((n) => !n.split);
  return {
    nodes,
    items,
    tilesSearched: nodes.length,
    tilesSplit: nodes.length - leaves.length,
    maxDepthHit: nodes.reduce((max, n) => Math.max(max, n.depth), 0),
    truncatedLeaves: leaves.filter((n) => n.truncated).length,
    halted,
  };
}

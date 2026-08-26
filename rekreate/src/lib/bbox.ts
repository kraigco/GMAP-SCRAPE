/**
 * Geographic rectangles, in the corner form the Places API expects.
 *
 * Deliberately not antimeridian-aware: `swLng < neLng` is required, so a box
 * spanning ±180 is rejected rather than silently mis-tiled. No target market
 * needs one, and a wrong answer there would be invisible.
 */
export type BBox = {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
};

export function isValidBBox(b: BBox): boolean {
  return (
    Number.isFinite(b.swLat) &&
    Number.isFinite(b.swLng) &&
    Number.isFinite(b.neLat) &&
    Number.isFinite(b.neLng) &&
    b.swLat >= -90 &&
    b.neLat <= 90 &&
    b.swLng >= -180 &&
    b.neLng <= 180 &&
    b.swLat < b.neLat &&
    b.swLng < b.neLng
  );
}

export function assertValidBBox(b: BBox, label = 'bbox'): void {
  if (!isValidBBox(b)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(b)} — need swLat<neLat, swLng<neLng, within ±90/±180.`,
    );
  }
}

/**
 * True when the box is still wide enough to halve in both axes.
 *
 * At extreme depth the midpoint can round to a corner in float64, which would
 * make a "split" produce a child identical to its parent and recurse forever.
 * `maxDepth` normally stops us first; this is the floor that holds even if it
 * does not (constraint 6: impossible, not unlikely).
 */
export function isSplittable(b: BBox): boolean {
  const midLat = (b.swLat + b.neLat) / 2;
  const midLng = (b.swLng + b.neLng) / 2;
  return midLat > b.swLat && midLat < b.neLat && midLng > b.swLng && midLng < b.neLng;
}

/** The four children of a box, in a fixed SW, SE, NW, NE order so runs are reproducible. */
export function quadrants(b: BBox): [BBox, BBox, BBox, BBox] {
  const midLat = (b.swLat + b.neLat) / 2;
  const midLng = (b.swLng + b.neLng) / 2;
  return [
    { swLat: b.swLat, swLng: b.swLng, neLat: midLat, neLng: midLng },
    { swLat: b.swLat, swLng: midLng, neLat: midLat, neLng: b.neLng },
    { swLat: midLat, swLng: b.swLng, neLat: b.neLat, neLng: midLng },
    { swLat: midLat, swLng: midLng, neLat: b.neLat, neLng: b.neLng },
  ];
}

/** `locationRestriction.rectangle` as the Text Search (New) body wants it. */
export function toRectangle(b: BBox): {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
} {
  return {
    low: { latitude: b.swLat, longitude: b.swLng },
    high: { latitude: b.neLat, longitude: b.neLng },
  };
}

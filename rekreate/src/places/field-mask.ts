/**
 * The field mask, frozen (constraint 3).
 *
 * Places API (New) bills at the HIGHEST tier among the fields requested, so the
 * mask is a pricing decision disguised as a list of strings. `websiteUri`,
 * `rating` and `userRatingCount` are Enterprise-tier, which puts every call in
 * this project at the Enterprise SKU. Adding `places.reviews` or
 * `places.photos` would move every call to Enterprise + Atmosphere for data the
 * pipeline does not use.
 *
 * Do not add to this without an explicit instruction.
 */
export const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.primaryType',
  'places.types',
  'places.location',
  'nextPageToken',
] as const;

/** The mask as the `X-Goog-FieldMask` HTTP header wants it — comma-separated, no spaces. */
export const PLACES_FIELD_MASK_HEADER = PLACES_FIELD_MASK.join(',');

/**
 * Enterprise Text Search, USD per 1,000 calls, above the free monthly cap.
 * Google grants 1,000 free Enterprise calls per month (they do not pool across
 * SKUs and do not roll over), so a typical sweep of this size bills nothing.
 * Estimates are still reported per run — a cost you cannot see is a cost you
 * cannot control (constraint 6).
 */
export const ENTERPRISE_USD_PER_1K = 35;
export const ENTERPRISE_FREE_CALLS_PER_MONTH = 1000;

export function estimateCostUsd(calls: number): number {
  return (calls * ENTERPRISE_USD_PER_1K) / 1000;
}

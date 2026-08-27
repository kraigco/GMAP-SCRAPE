/**
 * THE field mask for Text Search harvesting. Defined once, used by every
 * harvest call, and never written inline anywhere else.
 *
 * THIS MASK BILLS AT TEXT SEARCH ENTERPRISE. Places API (New) charges by the
 * HIGHEST-tier field requested, so this list is a pricing decision wearing the
 * costume of a string array. `websiteUri`, `nationalPhoneNumber`, `rating` and
 * `userRatingCount` are each Enterprise-tier on their own; the rest ride along
 * for free once one of them is present.
 *
 * ADDING `places.reviews` OR `places.photos` MOVES EVERY CALL INTO A MORE
 * EXPENSIVE BRACKET (Enterprise + Atmosphere) for data this pipeline does not
 * use. CHANGING THIS CONSTANT CHANGES THE BILL.
 *
 * Never use the wildcard `*` mask, in development or anywhere else: it requests
 * every field, which prices every call at the top bracket.
 *
 * Two other masks exist in this codebase, and both are deliberate:
 *
 *   GEOCODE_FIELD_MASK (places/geocode.ts) - resolves a place name to a box.
 *   PROBE_FIELD_MASK   (below)             - the one-call health check.
 *
 * Both request only Essentials-tier fields, so they bill against a SEPARATE
 * 10,000/month free allowance instead of the 1,000/month Enterprise one. Making
 * them share this mask would move them onto the Enterprise SKU and spend the
 * scarce allowance on location lookups. That would cost money, not save it.
 */
export const PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.types',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
  // Below here: requested because the pipeline reads them, and free given the
  // Enterprise fields above. `primaryType` and `location` fill the
  // primary_type / latitude / longitude columns; `nextPageToken` is what makes
  // pagination possible at all - omit it and every sweep silently stops at 20
  // results per tile.
  'places.primaryType',
  'places.location',
  'nextPageToken',
] as const;

/**
 * The health check's mask: two Essentials-tier fields and nothing else.
 *
 * Named rather than inlined so the "one mask per purpose, none inline" rule has
 * no exceptions to argue about. It asks for the least Google will return, since
 * its only question is whether the key works.
 */
export const PROBE_FIELD_MASK = 'places.id,places.displayName';

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

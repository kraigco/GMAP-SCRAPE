import type { BBox } from '../lib/bbox.ts';
import { isValidBBox } from '../lib/bbox.ts';
import { quotaErrorFor } from './quota.ts';

/**
 * Turn "Camden, NJ" into a bounding box the tiler can sweep.
 *
 * Deliberately NOT the Geocoding API. That is a separate product needing a
 * separate enablement and a key restriction change, and this project's key is
 * scoped to Places API (New) alone. Text Search already returns a `viewport`
 * for a locality, which is the same rectangle for our purposes.
 *
 * This uses its own field mask — a much CHEAPER one. `id`, `displayName`,
 * `formattedAddress`, `location` and `viewport` are Essentials-tier fields,
 * billed against a separate 10,000/month free allowance rather than the
 * Enterprise bucket the harvest spends. Constraint 3 freezes the HARVEST mask;
 * this is a different call for a different job, and it adds nothing to it.
 */
const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

export const GEOCODE_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.viewport',
].join(',');

export type ResolvedLocation = {
  label: string;
  formattedAddress: string;
  bbox: BBox;
  /** How many degrees across — a sanity signal for how big a sweep will be. */
  spanLat: number;
  spanLng: number;
};

type ViewportResponse = {
  places?: {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    viewport?: {
      low?: { latitude?: number; longitude?: number };
      high?: { latitude?: number; longitude?: number };
    };
  }[];
};

export type GeocodeOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
};

/**
 * Below this, a "location" is a building, not a market.
 *
 * Text Search happily answers a business name — type "Starbucks" in the
 * location box and it resolves to one shop, whose viewport is roughly 150m
 * across. The sweep then runs, costs calls, and returns nearly nothing, with
 * no hint that the question was the problem. Every real locality, county and
 * postal district is far wider than this, so the two cases separate cleanly.
 *
 * ~0.004 degrees is about 440m of latitude.
 */
export const MIN_SWEEPABLE_SPAN_DEG = 0.004;

export function isTooSmallToSweep(spanLat: number, spanLng: number): boolean {
  return spanLat < MIN_SWEEPABLE_SPAN_DEG && spanLng < MIN_SWEEPABLE_SPAN_DEG;
}

export async function resolveLocation(
  query: string,
  opts: GeocodeOptions,
): Promise<ResolvedLocation> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('resolveLocation: a location is required');

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(SEARCH_TEXT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': opts.apiKey,
      'X-Goog-FieldMask': GEOCODE_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: trimmed,
      pageSize: 1,
      languageCode: 'en',
      // No regionCode. Setting one biases every lookup toward that country,
      // so "Manchester" would resolve to New Hampshire rather than England.
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // The location lookup shares the project's Places quota, so it hits the
    // daily wall first — it is the very first call a search makes.
    const daily = quotaErrorFor(res.status, text);
    if (daily) throw daily;
    throw new Error(`Location lookup failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const first = (JSON.parse(text) as ViewportResponse).places?.[0];
  if (!first) throw new Error(`No location found for "${trimmed}".`);

  const vp = first.viewport;
  const low = vp?.low;
  const high = vp?.high;
  if (
    low?.latitude === undefined || low.longitude === undefined ||
    high?.latitude === undefined || high.longitude === undefined
  ) {
    throw new Error(
      `"${trimmed}" resolved to ${first.formattedAddress ?? 'a place'} with no viewport. ` +
        `Try a town, city or county rather than a street address.`,
    );
  }

  const bbox: BBox = {
    swLat: low.latitude,
    swLng: low.longitude,
    neLat: high.latitude,
    neLng: high.longitude,
  };
  if (!isValidBBox(bbox)) {
    throw new Error(`"${trimmed}" produced an unusable box: ${JSON.stringify(bbox)}`);
  }

  const spanLat = bbox.neLat - bbox.swLat;
  const spanLng = bbox.neLng - bbox.swLng;
  if (isTooSmallToSweep(spanLat, spanLng)) {
    throw new Error(
      `"${trimmed}" resolved to ${first.formattedAddress ?? 'a single point'}, which is one ` +
        `building rather than an area — a sweep of it would return almost nothing. ` +
        `Try a town, city, county or postcode.`,
    );
  }

  return {
    label: first.displayName?.text ?? trimmed,
    formattedAddress: first.formattedAddress ?? trimmed,
    bbox,
    spanLat: bbox.neLat - bbox.swLat,
    spanLng: bbox.neLng - bbox.swLng,
  };
}

/**
 * Keywords for an arbitrary niche.
 *
 * A saved niche config is better — it carries disqualifiers and a curated term
 * list. This is the fallback when someone types something the config has never
 * heard of, and it deliberately stays small: each term is a full sweep of the
 * box, so five loose guesses cost five times one good one.
 */
export function termsForNiche(niche: string): string[] {
  const base = niche.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!base) throw new Error('termsForNiche: a niche is required');

  const singular = base.endsWith('s') ? base.slice(0, -1) : base;
  return [...new Set([base, `${singular} company`, `${singular} services`, `local ${base}`])];
}

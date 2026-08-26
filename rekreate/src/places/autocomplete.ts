/**
 * Location suggestions as you type.
 *
 * Places Autocomplete (New) is a separate SKU from Text Search with its own
 * free monthly allowance, so suggestions do not eat into the harvest budget.
 * It is still a billed call per keystroke-batch, which is why the caller
 * debounces and refuses anything under three characters.
 *
 * Restricted to region types — a street address makes a useless search box,
 * because a single building has no area to tile.
 */
import { quotaErrorFor } from './quota.ts';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

const REGION_TYPES = [
  'locality',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'postal_code',
  'neighborhood',
];

export type LocationSuggestion = {
  /** What goes in the input when picked. */
  text: string;
  /** State or county, shown as the hint beside it. */
  secondary: string;
};

type AutocompleteResponse = {
  suggestions?: {
    placePrediction?: {
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
};

export type AutocompleteOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /**
   * ISO country codes to restrict to. Omit for worldwide, which is the
   * default — Rekreate operates from Manila and sells into the US, so a
   * US-only box would hide its own home market.
   */
  regionCodes?: string[];
};

export const MIN_QUERY_LENGTH = 3;

export async function suggestLocations(
  input: string,
  opts: AutocompleteOptions,
): Promise<LocationSuggestion[]> {
  const query = input.trim();
  if (query.length < MIN_QUERY_LENGTH) return [];

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(AUTOCOMPLETE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': opts.apiKey,
    },
    body: JSON.stringify({
      input: query,
      includedPrimaryTypes: REGION_TYPES,
      // Sent only when the caller asks for it. Absent means worldwide.
      ...(opts.regionCodes?.length ? { includedRegionCodes: opts.regionCodes } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // A dead suggestion box must never break the search box under it, but a
    // spent daily quota is worth naming precisely — it explains why the search
    // itself is about to fail too.
    const daily = quotaErrorFor(res.status, body);
    if (daily) throw daily;
    throw new Error(`Autocomplete failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }

  const body = JSON.parse(await res.text()) as AutocompleteResponse;
  return (body.suggestions ?? [])
    .map((s) => {
      const p = s.placePrediction;
      const main = p?.structuredFormat?.mainText?.text ?? p?.text?.text ?? '';
      const secondary = p?.structuredFormat?.secondaryText?.text ?? '';
      return { text: main, secondary };
    })
    .filter((s) => s.text.length > 0);
}

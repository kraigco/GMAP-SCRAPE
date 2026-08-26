import type { BBox } from '../lib/bbox.ts';
import { toRectangle } from '../lib/bbox.ts';
import { PLACES_FIELD_MASK_HEADER } from './field-mask.ts';
import { parsePlaces, searchTextResponseSchema } from './schema.ts';
import { PlacesQuotaError, quotaErrorFor, quotaLimitName, rateLimitMessage } from './quota.ts';
import type { RawPlace, RejectedPlace } from './schema.ts';

export { PlacesQuotaError, classifyQuotaError, quotaLimitName } from './quota.ts';
export type { QuotaKind } from './quota.ts';

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Google's ceiling: 20 results per page, 3 pages, 60 results per query. */
const PAGE_SIZE = 20;
const MAX_PAGES = 3;

/**
 * The point at which a query's answer stops being trustworthy.
 *
 * Google does not tell you it truncated. At 60 results it stops issuing page
 * tokens, so "exactly 60 businesses exist here" and "hundreds exist here" come
 * back byte-identical. Any tile that reaches this number must therefore be
 * treated as incomplete and split (constraint 1) — waiting for a token that
 * will never arrive means the tiling engine never fires at all.
 */
export const SEARCH_RESULT_CEILING = PAGE_SIZE * MAX_PAGES;

export type TileResult = {
  places: RawPlace[];
  rejected: RejectedPlace[];
  pagesFetched: number;
  /** Raw entries Google returned, before validation dropped any. */
  rawReturned: number;
  /**
   * This tile's answer is incomplete: it hit the 60-result ceiling, had a page
   * token outstanding, or ran out of budget mid-pagination.
   */
  truncated: boolean;
};

export type PlacesClientOptions = {
  apiKey: string;
  /** Hard ceiling. Decremented BEFORE each request is issued (constraint 6). */
  maxCalls: number;
  /** Injected for tests — no live calls in the suite. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /**
   * Checked immediately before each request is issued. Returning true stops the
   * client cold — used when the caller has gone away and every further call
   * would be money spent on an answer nobody will read.
   *
   * Deliberately checked BEFORE the request rather than aborting one in flight:
   * a request already sent is already billable, so cancelling it would pay for
   * the call and throw away the results.
   */
  shouldStop?: () => boolean;
};

export type PlacesClient = {
  searchTile(textQuery: string, bbox: BBox): Promise<TileResult>;
  callsUsed(): number;
  budgetRemaining(): number;
  budgetExhausted(): boolean;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createPlacesClient(opts: PlacesClientOptions): PlacesClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 3;
  const shouldStop = opts.shouldStop ?? ((): boolean => false);

  if (!opts.apiKey) throw new Error('createPlacesClient: apiKey is required');
  if (!Number.isInteger(opts.maxCalls) || opts.maxCalls < 0) {
    throw new Error(
      `createPlacesClient: maxCalls must be a non-negative integer, got ${opts.maxCalls}`,
    );
  }

  let callsUsed = 0;

  /**
   * Every issued request counts, retries included. Google does not bill failed
   * requests, so this over-counts slightly — which is the direction we want a
   * spending cap to err in.
   */
  const claimCall = (): boolean => {
    if (callsUsed >= opts.maxCalls) return false;
    callsUsed += 1;
    return true;
  };

  async function requestPage(body: Record<string, unknown>): Promise<unknown | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (shouldStop()) return null;
      if (!claimCall()) return null;

      const res = await doFetch(SEARCH_TEXT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': opts.apiKey,
          // The mask is a HEADER, not a body field. Sending it in the body
          // silently returns the default field set instead of erroring.
          'X-Goog-FieldMask': PLACES_FIELD_MASK_HEADER,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return JSON.parse(await res.text());

      const text = await res.text();

      // Checked before anything else: a spent daily allowance must end the run
      // on the first response, not after three more requests against it.
      const daily = quotaErrorFor(res.status, text);
      if (daily) throw daily;

      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        // A page token used faster than Google propagates it. The New API
        // documents no warm-up delay, so retry rather than sleeping before
        // every page and paying that cost on every tile.
        (res.status === 400 && text.includes('INVALID_ARGUMENT') && 'pageToken' in body);

      if (!retryable || attempt === maxRetries) {
        // A per-minute limit that survived every retry is still a quota
        // problem, and the caller should be told which kind.
        if (res.status === 429) {
          const limitName = quotaLimitName(text);
          throw new PlacesQuotaError('rate', 429, rateLimitMessage(limitName, attempt + 1), limitName, text);
        }
        throw new Error(
          `Places searchText failed (HTTP ${res.status}) after ${attempt + 1} attempt(s): ${text.slice(0, 500)}`,
        );
      }

      await sleep(500 * 2 ** attempt);
    }
    return null;
  }

  async function searchTile(textQuery: string, bbox: BBox): Promise<TileResult> {
    const places: RawPlace[] = [];
    const rejected: RejectedPlace[] = [];
    let pageToken: string | undefined;
    let pagesFetched = 0;
    let rawReturned = 0;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        textQuery,
        locationRestriction: { rectangle: toRectangle(bbox) },
        pageSize: PAGE_SIZE,
        languageCode: 'en',
        // No regionCode: the rectangle already pins the search geographically,
        // and forcing a country biases results away from every other one. A
        // sweep of Metro Manila must not be nudged toward US businesses.
      };
      if (pageToken) body['pageToken'] = pageToken;

      const json = await requestPage(body);
      if (json === null) {
        // Budget ran out mid-tile. Keep what we have and say so.
        truncated = true;
        break;
      }

      pagesFetched += 1;
      const parsed = searchTextResponseSchema.parse(json);
      const raw = parsed.places ?? [];
      rawReturned += raw.length;

      const batch = parsePlaces(raw);
      places.push(...batch.places);
      rejected.push(...batch.rejected);

      pageToken = parsed.nextPageToken;
      // A token still outstanding when the pages run out means Google is
      // holding results back.
      if (!pageToken) break;
      if (page === MAX_PAGES - 1) truncated = true;
    }

    // The ceiling case: 60 results and no token. Indistinguishable from a
    // complete answer, so it must be assumed incomplete.
    if (rawReturned >= SEARCH_RESULT_CEILING) truncated = true;

    return { places, rejected, pagesFetched, rawReturned, truncated };
  }

  return {
    searchTile,
    callsUsed: () => callsUsed,
    budgetRemaining: () => Math.max(0, opts.maxCalls - callsUsed),
    budgetExhausted: () => callsUsed >= opts.maxCalls,
  };
}

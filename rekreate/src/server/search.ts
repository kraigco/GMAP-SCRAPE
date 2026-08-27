import { auditSite } from '../audit/site.ts';
import { mapPool } from '../lib/concurrency.ts';
import { createPlacesClient } from '../places/client.ts';
import { dedupeById } from '../places/dedupe.ts';
import { estimateCostUsd } from '../places/field-mask.ts';
import { release, reserve } from '../places/usage.ts';
import { cachingSweep, load as loadTileCache, noCache } from '../places/tile-cache.ts';
import { resolveLocation, termsForNiche } from '../places/geocode.ts';
import { resolveNiche } from '../config/niches/property-management.ts';
import type { RawPlace } from '../places/schema.ts';
import { sweepTiles } from '../places/tiling.ts';
import { summarise, toLead } from '../lead/signals.ts';
import { filterLeads, filterPlaces, mergeReports } from '../lead/filters.ts';
import type { FilterReport, LeadFilters } from '../lead/filters.ts';
import type { Lead } from '../lead/signals.ts';

/**
 * One search, end to end: geocode a place name, sweep it, visit every site.
 *
 * Deliberately knows nothing about HTTP. It takes plain parameters, reports
 * progress through a callback, and returns plain data — so the localhost server
 * and a future Kodex route can both call it without either owning it.
 */

export type SearchParams = {
  location: string;
  niche: string;
  maxCalls?: number;
  /**
   * Stop the sweep once this many distinct businesses have been collected.
   *
   * This is the control a person actually wants: you think in businesses, not
   * in API calls. It is a COVERAGE decision, not a tuning knob - hitting it
   * means the market was not exhausted, so `resultCapReached` reports it.
   */
  maxResults?: number;
  maxDepth?: number;
  /**
   * Use only the first N phrasings of the niche.
   *
   * Every term is a FULL sweep of the box, so this multiplies the cost of a
   * search directly: four terms is four times the calls of one. More terms find
   * genuinely different businesses, so this is a coverage decision rather than
   * a tuning knob — which is why the number actually used is reported back.
   */
  maxTerms?: number;
  audit?: boolean;
  concurrency?: number;
  filters?: LeadFilters;
  /**
   * Abort the sweep. Every Places call after this fires is money spent on an
   * answer nobody is waiting for, so the budget stops here.
   *
   * Cooperative on purpose. It stops the sweep ISSUING work rather than killing
   * work in flight: a Places request already sent is already billable, and an
   * audit fetch killed mid-flight would record a live site as unreachable. So
   * requests already out finish, nothing new starts, and what was paid for is
   * still returned and still written to disk.
   */
  signal?: AbortSignal;
};

export type SearchProgress = {
  stage: 'geocode' | 'sweep' | 'audit' | 'done';
  message: string;
  callsUsed: number;
  found: number;
  pct: number;
};

export type SearchResult = {
  run: {
    location: string;
    niche: string;
    terms: string[];
    /**
     * How many phrasings existed for this niche. When it exceeds `terms.length`
     * the sweep deliberately covered less than it could have, and the caller
     * must be able to say so rather than present a partial answer as a whole one.
     */
    termsAvailable: number;
    maxCalls: number;
    maxResults: number;
    /** The sweep stopped because it had collected `maxResults` businesses. */
    resultCapReached: boolean;
    /** Tiles replayed from the cache - calls this run did not have to spend. */
    tilesFromCache: number;
    maxDepth: number;
    callsUsed: number;
    tilesSearched: number;
    tilesSplit: number;
    truncatedLeaves: number;
    duplicatesDropped: number;
    estimatedCostUsd: number;
    halted: boolean;
    /** The caller went away and the sweep stopped short of the market. */
    aborted: boolean;
    audited: boolean;
    sitesFetched: number;
    finishedAt: string;
  };
  totals: Record<string, number | string>;
  leads: Lead[];
  /** What the quality filters removed, and why. Never silent. */
  filtered: FilterReport;
};

/**
 * `fetchImpl` is injected only by the tests — the server passes the real one.
 *
 * `usagePath` likewise. The free-tier ledger is real state on disk, and a test
 * suite that writes to the live one spends next month's allowance on assertions
 * — which it did, 27 calls' worth, before this was injectable.
 */
export type SearchDeps = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  usagePath?: string;
  /** Overridden by tests so the suite never touches the real tile cache. */
  tileCachePath?: string;
  /**
   * Places calls allowed per US/Pacific day. Passed in rather than read from
   * env here, because this module deliberately knows nothing about process
   * configuration - the server and the CLI each supply their own.
   */
  dailyCap?: number;
};

export async function runSearch(
  params: SearchParams,
  deps: SearchDeps,
  onProgress: (p: SearchProgress) => void = () => {},
): Promise<SearchResult> {
  const location = params.location.trim();
  const niche = params.niche.trim();
  if (!location) throw new Error('A location is required.');
  if (!niche) throw new Error('A niche is required.');

  // 45, matching env.MAX_CALLS: the monthly Enterprise free tier is 1,000
  // calls, which is ~45 a working day. The daily console cap is a separate,
  // looser wall — the monthly one is what decides whether a bill arrives.
  // 25, matching env.MAX_CALLS. The per-run ceiling is the small guard; the
  // daily and monthly ledgers are what keep the project free, because only
  // they can see the runs this one knows nothing about.
  const maxCalls = Math.max(1, Math.min(1000, params.maxCalls ?? 25));
  const maxResults = Math.max(1, Math.min(5000, params.maxResults ?? 100));
  // 1, matching env.MAX_TILE_DEPTH. This default said 3 while env.ts said 4
  // and the dashboard said 2 - one setting with three values depending on
  // which door you came through.
  const maxDepth = Math.max(0, Math.min(5, params.maxDepth ?? 1));
  const doAudit = params.audit !== false;
  const concurrency = params.concurrency ?? 8;

  const stopped = (): boolean => params.signal?.aborted === true;
  // Built once and spread, because `exactOptionalPropertyTypes` refuses an
  // explicit `fetchImpl: undefined` on an optional property.
  const net = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};

  // A saved config brings curated terms; anything else gets generated ones.
  let available: string[];
  try {
    available = resolveNiche(niche).keywords;
  } catch {
    available = termsForNiche(niche);
  }

  const requested = params.maxTerms;
  const terms =
    requested !== undefined && Number.isFinite(requested) && requested > 0
      ? available.slice(0, Math.floor(requested))
      : available;

  const report = (stage: SearchProgress['stage'], message: string, callsUsed: number, found: number, pct: number): void =>
    onProgress({ stage, message, callsUsed, found, pct });

  // Claim the run's calls BEFORE anything reaches Google, and that includes
  // resolving the location: resolveLocation is a places:searchText call like
  // any other and spends from the same metric. Reserving after it meant an
  // exhausted month still paid for a geocode before finding out.
  //
  // A per-run ceiling cannot make this guarantee by itself; only a figure that
  // survives between runs can.
  const ledger = {
    ...(deps.usagePath ? { path: deps.usagePath } : {}),
    ...(deps.dailyCap === undefined ? {} : { dayCap: deps.dailyCap }),
  };
  const budget = await reserve(maxCalls, ledger);
  if (budget.granted === 0) {
    throw new Error(
      `No free Places calls left this month — ${budget.used} of ${budget.cap} used. ` +
        `The allowance resets ${budget.resetsAt}. Auditing and pushing still work; ` +
        `they cost no Places quota.`,
    );
  }

  report('geocode', `Resolving "${location}"…`, 0, 0, 2);
  const place = await resolveLocation(location, { apiKey: deps.apiKey, ...net });
  // The client never sees the geocode call, and an uncounted call is exactly
  // the leak this ledger exists to close.
  const geocodeCalls = 1;

  const client = createPlacesClient({
    apiKey: deps.apiKey,
    maxCalls: Math.max(0, budget.granted - geocodeCalls),
    shouldStop: stopped,
    ...net,
  });
  // Tiles already paid for within the TTL replay from disk. This is what makes
  // a sweep resumable: a run stopped by the daily budget leaves its finished
  // tiles here, and tomorrow's run walks the same tree spending nothing on them.
  const cache = deps.tileCachePath
    ? cachingSweep(await loadTileCache(deps.tileCachePath), { path: deps.tileCachePath })
    : noCache();

  const batches: RawPlace[][] = [];
  let tilesSearched = 0;
  let tilesSplit = 0;
  let truncatedLeaves = 0;
  let halted = false;
  // A running dedupe, so the sweep can stop the moment it has enough. This only
  // decides WHEN to halt; dedupeById below remains the authority on the result.
  const seen = new Set<string>();
  let resultCapReached = false;

  for (const [i, term] of terms.entries()) {
    if (stopped()) break;
    if (client.budgetExhausted()) {
      halted = true;
      break;
    }
    if (seen.size >= maxResults) {
      resultCapReached = true;
      break;
    }
    report(
      'sweep',
      `Searching "${term}" in ${place.formattedAddress}…`,
      client.callsUsed(),
      batches.flat().length,
      5 + Math.round((i / terms.length) * (doAudit ? 45 : 90)),
    );

    const sweep = await sweepTiles<RawPlace>(
      place.bbox,
      cache.fetcher(term, async (bbox) => {
        const tile = await client.searchTile(term, bbox);
        return { items: tile.places, truncated: tile.truncated };
      }),
      { maxDepth, shouldHalt: () => client.budgetExhausted() || stopped() || seen.size >= maxResults },
    );

    // Counted here rather than inside the fetcher so cached tiles feed the cap
    // exactly as paid ones do. A resumed sweep that ignored its own replayed
    // results would keep collecting past the limit it was given.
    for (const found of sweep.items) seen.add(found.id);

    batches.push(sweep.items);
    tilesSearched += sweep.tilesSearched;
    tilesSplit += sweep.tilesSplit;
    truncatedLeaves += sweep.truncatedLeaves;
    halted = halted || sweep.halted;
  }

  const { unique, duplicatesDropped } = dedupeById(batches);

  // A tile returns up to 20 at once, so the sweep can cross the cap mid-tile.
  // Trim to what was asked for; `resultCapReached` keeps the fact that the
  // market was NOT exhausted visible, rather than passing a slice off as a whole.
  if (seen.size >= maxResults) resultCapReached = true;
  const collected = resultCapReached ? unique.slice(0, maxResults) : unique;

  const filters = params.filters ?? {};
  const pre = filterPlaces(collected, filters);
  const candidates = pre.kept;

  if (pre.report.dropped.length) {
    const removed = pre.report.considered - pre.report.kept;
    report(
      'audit',
      `Filtered out ${removed} of ${pre.report.considered} on rating and reviews…`,
      client.callsUsed(),
      candidates.length,
      50,
    );
  }

  let leads: Lead[];
  let sitesFetched = 0;

  if (doAudit && candidates.length) {
    const withSite = candidates.filter((p) => p.websiteUri).length;
    report('audit', `Visiting ${withSite} websites for contact details…`, client.callsUsed(), candidates.length, 52);

    const audits = await mapPool(
      candidates,
      concurrency,
      // A null audit means "not visited", which `toLead` reports as unaudited
      // rather than as a site with nothing on it. Skipping is honest; inventing
      // a failed audit for a site we never called would not be.
      async (p) => (stopped() ? null : auditSite(p.id, p.websiteUri ?? null, net)),
      (done, total) => {
        if (done % 5 === 0 || done === total) {
          report('audit', `Visited ${done} of ${total} sites…`, client.callsUsed(), candidates.length,
            52 + Math.round((done / total) * 45));
        }
      },
    );
    sitesFetched = audits.filter((a) => a !== null && a.pagesFetched > 0).length;
    leads = candidates.map((p, i) => toLead(p, audits[i] ?? null));
  } else {
    leads = candidates.map((p) => toLead(p, null));
  }

  // Only the audit knows whether a contact address exists, so this pass cannot
  // run any earlier than here.
  const post = filterLeads(leads, filters);
  leads = post.kept;

  const callsUsed = client.callsUsed();

  // Hand back what the sweep did not spend. Until this runs the month shows
  // the whole reservation, so an abandoned sweep forfeits its budget rather
  // than risking a bill.
  await release(budget.granted, callsUsed + geocodeCalls, ledger);

  // Written after the settle so a crash between the two forfeits budget rather
  // than banking tiles it may not have finished paying for.
  await cache.flush();

  report('done', `${leads.length} prospects found.`, callsUsed, leads.length, 100);

  return {
    run: {
      location: place.formattedAddress,
      niche,
      terms,
      termsAvailable: available.length,
      maxCalls,
      maxResults,
      resultCapReached,
      tilesFromCache: cache.hits(),
      maxDepth,
      callsUsed,
      tilesSearched,
      tilesSplit,
      truncatedLeaves,
      duplicatesDropped,
      estimatedCostUsd: estimateCostUsd(callsUsed),
      halted,
      aborted: stopped(),
      audited: doAudit,
      sitesFetched,
      finishedAt: new Date().toISOString(),
    },
    totals: summarise(leads),
    leads,
    filtered: mergeReports(pre.report, post.report),
  };
}

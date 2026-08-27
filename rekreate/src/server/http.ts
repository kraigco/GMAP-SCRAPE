import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { runSearch } from './search.ts';
import { suggestLocations, MIN_QUERY_LENGTH } from '../places/autocomplete.ts';
import { PlacesQuotaError } from '../places/quota.ts';
import { LOCATION_SEEDS, NICHE_SUGGESTIONS } from '../config/niche-suggestions.ts';
import { leadToEnrichedRow, parseEnrichedCsv, renderEnrichedCsv } from '../export/csv.ts';
import { parseSearchBaseName, searchBaseName, writeUnique } from '../export/search-file.ts';
import { SIGNAL_LABELS, SLOW_TTFB_MS, summarise, THIN_REVIEW_COUNT } from '../lead/signals.ts';
import { describeResult, fetchStoredLeads, isConfigured, pushLeads, toSheetLead } from '../export/sheets.ts';
import { peek } from '../places/usage.ts';
import { TILE_CACHE_PATH } from '../places/tile-cache.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import type { EnrichedRow } from '../export/csv.ts';
import type { IngestResult } from '../export/sheets.ts';
import type { SearchResult } from './search.ts';

/**
 * A localhost dashboard.
 *
 * Everything real lives in runSearch(); this file only moves bytes. The API key
 * is read from .env here and never leaves the process — which is precisely why
 * the search cannot run in a published page.
 *
 * Bound to 127.0.0.1 deliberately. There is no auth, so it must not be
 * reachable from the network.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';

// Must come first: DASHBOARD_PORT lives in .env, and .env is not loaded until
// this runs. Reading the port before it meant the setting never took effect.
const env = loadEnv();
const PORT = env.DASHBOARD_PORT;

/** Where every search lands. One file per run, never overwritten. */
const SEARCH_DIR = 'out/searches';

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send a finished search to the spreadsheet.
 *
 * Returns null when the ingest is not configured — that is an ordinary state,
 * not a failure, and the pipeline is expected to work without it. Anything that
 * does go wrong comes back as a result rather than an exception: the CSV is
 * already on disk by this point, and a sheet problem must not turn a completed
 * sweep into a failed one.
 */
async function pushToSheet(result: SearchResult, savedTo: string): Promise<IngestResult | null> {
  if (!isConfigured(env.SHEETS_WEBAPP_URL, env.SHEETS_INGEST_TOKEN)) return null;

  const context = {
    niche: result.run.niche,
    location: result.run.location,
    refreshedAt: result.run.finishedAt,
  };

  return pushLeads(
    result.leads.map((lead) => toSheetLead(lead, context)),
    {
      finishedAt: result.run.finishedAt,
      location: result.run.location,
      niche: result.run.niche,
      terms: result.run.terms,
      prospects: result.leads.length,
      withEmail: result.leads.filter((l) => l.email).length,
      tilesSearched: result.run.tilesSearched,
      tilesSplit: result.run.tilesSplit,
      callsUsed: result.run.callsUsed,
      maxCalls: result.run.maxCalls,
      estimatedCostUsd: result.run.estimatedCostUsd,
      duplicatesDropped: result.run.duplicatesDropped,
      halted: result.run.halted,
      aborted: result.run.aborted,
      file: savedTo,
    },
    { url: env.SHEETS_WEBAPP_URL ?? '', token: env.SHEETS_INGEST_TOKEN ?? '' },
  );
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const location = url.searchParams.get('location') ?? '';
  const niche = url.searchParams.get('niche') ?? '';
  // The call budget is no longer taken from the query string. It is a backstop
  // against Google's daily cap, not a per-search preference, so it comes from
  // .env where it can be raised once billing is attached. What the dashboard
  // sends is a business count, which is the limit a person actually reasons about.
  const maxCalls = env.MAX_CALLS;
  const maxResultsRaw = Number(url.searchParams.get('maxResults'));
  const maxResults = Number.isFinite(maxResultsRaw) && maxResultsRaw > 0 ? maxResultsRaw : env.MAX_RESULTS;
  const maxDepth = Number(url.searchParams.get('maxDepth') ?? 3);
  const audit = url.searchParams.get('audit') !== 'false';
  // Absent means every phrasing, which is what the pipeline did before this
  // existed — so an old link or a script that does not know about it is
  // unchanged.
  const rawTerms = url.searchParams.get('maxTerms');
  const maxTerms = rawTerms !== null && Number(rawTerms) > 0 ? Number(rawTerms) : undefined;

  // Quality filters. Absent means "no filter" — never a silent default, so a
  // blank box can never quietly discard prospects.
  const num = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (raw === null || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const filters = {
    minRating: num('minRating'),
    minReviews: num('minReviews'),
    requireEmail: url.searchParams.get('requireEmail') === 'true',
    requireWebsite: url.searchParams.get('requireWebsite') === 'true',
  };

  // A closed tab must stop the sweep — otherwise a refresh doubles the spend.
  //
  // The flag alone never did that: it silenced the progress events and let the
  // sweep run on, billing every remaining call to nobody. The controller is
  // what actually stops it. `finished` guards the handler because 'close' also
  // fires on a normal end, and aborting there would be aborting nothing.
  const control = new AbortController();
  let aborted = false;
  let finished = false;
  req.on('close', () => {
    if (finished) return;
    aborted = true;
    control.abort();
    console.log('  client disconnected — sweep stopped, partial results still saved');
  });

  try {
    const result = await runSearch(
      {
        location, niche, maxCalls, maxResults, maxDepth, audit, filters,
        signal: control.signal,
        ...(maxTerms === undefined ? {} : { maxTerms }),
      },
      {
        apiKey: env.GOOGLE_MAPS_API_KEY,
        dailyCap: env.PLACES_DAILY_LIMIT,
        // Naming the file is what turns the cache on. A sweep halted by the
        // daily budget leaves its finished tiles here and resumes tomorrow.
        tileCachePath: TILE_CACHE_PATH,
      },
      (p) => { if (!aborted) sseSend(res, 'progress', p); },
    );

    // Every search also lands on disk, so a browser crash never costs a sweep \u2014
    // and an abandoned one is still written, because the calls were paid for
    // whether or not anyone stayed to watch.
    const stamp = result.run.finishedAt;
    const rows: EnrichedRow[] = result.leads.map((l) => leadToEnrichedRow(l, stamp));
    // BOM so Excel reads UTF-8 business names rather than mojibake.
    const csv = '\ufeff' + renderEnrichedCsv(rows);

    // Its own file, which nothing will ever overwrite.
    const savedTo = await writeUnique(
      SEARCH_DIR,
      searchBaseName(stamp, result.run.location, result.run.niche),
      csv,
    );

    // A sidecar holding what the CSV cannot: calls used, cost, tiles, what the
    // filters removed. It is what lets a saved search be reopened later with
    // its run bar intact rather than as an anonymous list of rows.
    await writeFile(
      savedTo.replace(/\.csv$/, '.json'),
      JSON.stringify({ run: result.run, totals: result.totals, filtered: result.filtered }, null, 2),
      'utf8',
    );

    // A convenience copy at a fixed path. Named "latest" precisely so that
    // overwriting it is the expected behaviour rather than a silent loss.
    await mkdir('out', { recursive: true });
    await writeFile('out/latest.csv', csv, 'utf8');

    // Straight to the spreadsheet, on every scrape. The CSV is written FIRST
    // and unconditionally: the sheet is where the leads are worked, but the
    // file is what guarantees a paid sweep survives a bad token or a redeploy.
    const sheet = await pushToSheet(result, savedTo);
    if (sheet) console.log(`  sheet: ${describeResult(sheet)}`);

    // Nobody is listening on an aborted stream, so the path goes to the console
    // instead — a sweep that was paid for must always be findable.
    if (aborted) console.log(`  partial results written to ${savedTo}`);
    else sseSend(res, 'done', { ...result, savedTo, sheet });
  } catch (err) {
    // A quota failure gets its own shape so the page can explain it properly
    // rather than showing the caller a wall of Google JSON.
    if (err instanceof PlacesQuotaError) {
      sseSend(res, 'failed', {
        kind: err.kind,
        limitName: err.limitName,
        message: err.message,
      });
    } else {
      sseSend(res, 'failed', {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    finished = true;
    res.end();
  }
}

/**
 * Saved searches, newest first.
 *
 * The sidecar is the source of truth where one exists; the filename is the
 * fallback so runs saved before sidecars existed still show up.
 */
async function listSearches(): Promise<unknown[]> {
  let names: string[];
  try {
    names = await readdir(SEARCH_DIR);
  } catch {
    return []; // nothing has been searched yet
  }

  const entries = [];
  for (const name of names.filter((n) => n.endsWith('.csv')).sort().reverse().slice(0, 40)) {
    const fromName = parseSearchBaseName(name);
    let run: Record<string, unknown> | null = null;
    let totals: Record<string, unknown> | null = null;
    try {
      const raw = await readFile(join(SEARCH_DIR, name.replace(/\.csv$/, '.json')), 'utf8');
      const saved = JSON.parse(raw) as {
        run?: Record<string, unknown>;
        totals?: Record<string, unknown>;
      };
      run = saved.run ?? null;
      totals = saved.totals ?? null;
    } catch {
      /* no sidecar — fall back to the filename */
    }

    entries.push({
      file: name,
      location: (run?.['location'] as string) ?? fromName?.location ?? name,
      niche: (run?.['niche'] as string) ?? fromName?.niche ?? '',
      when: (run?.['finishedAt'] as string) ?? fromName?.when ?? null,
      // The count lives in `totals`, not `run` — `run` has never carried one.
      prospects: (totals?.['prospects'] as number) ?? null,
      callsUsed: (run?.['callsUsed'] as number) ?? null,
      estimatedCostUsd: (run?.['estimatedCostUsd'] as number) ?? null,
    });
  }
  return entries;
}

/** Reopen one saved search: its rows, its stats, and its run bar. */
async function readSearch(file: string): Promise<unknown> {
  // The name comes from the browser, so it is checked rather than trusted.
  if (!/^[A-Za-z0-9._-]+\.csv$/.test(file) || file.includes('..')) {
    throw new Error('bad file name');
  }

  const leads = parseEnrichedCsv(await readFile(join(SEARCH_DIR, file), 'utf8'));
  let saved: { run?: unknown; filtered?: unknown } = {};
  try {
    saved = JSON.parse(await readFile(join(SEARCH_DIR, file.replace(/\.csv$/, '.json')), 'utf8')) as typeof saved;
  } catch {
    /* older run with no sidecar */
  }

  const fromName = parseSearchBaseName(file);
  return {
    leads,
    totals: summarise(leads),
    filtered: saved.filtered ?? null,
    savedTo: join(SEARCH_DIR, file),
    reopened: true,
    // No sidecar: this file predates them, so the run's own numbers — terms,
    // tiles, calls, cost — are simply not recoverable. The flag tells the page
    // to say so rather than render a run bar full of confident zeroes.
    run: saved.run ?? {
      reopenedWithoutRun: true,
      location: fromName?.location ?? file,
      niche: fromName?.niche ?? '',
      finishedAt: fromName?.when ?? null,
      terms: [],
      callsUsed: 0,
      tilesSearched: 0,
      tilesSplit: 0,
      truncatedLeaves: 0,
      duplicatesDropped: 0,
      estimatedCostUsd: 0,
      maxCalls: 0,
      maxResults: 0,
      resultCapReached: false,
      tilesFromCache: 0,
      maxDepth: 0,
      halted: false,
      aborted: false,
      audited: leads.some((l) => l.audited),
      sitesFetched: 0,
    },
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/api/search') {
    void handleSearch(req, res, url);
    return;
  }

  if (url.pathname === '/api/locations') {
    const q = url.searchParams.get('q') ?? '';
    suggestLocations(q, { apiKey: env.GOOGLE_MAPS_API_KEY })
      .then((items) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      })
      .catch((err: unknown) => {
        // Suggestions are a convenience. A failure here returns an empty list
        // with the reason, never an error the search box has to handle.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          items: [],
          kind: err instanceof PlacesQuotaError ? err.kind : 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      });
    return;
  }

  if (url.pathname === '/api/suggestions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        niches: NICHE_SUGGESTIONS,
        locations: LOCATION_SEEDS,
        // Served rather than duplicated in the page. The signal vocabulary and
        // its thresholds have one definition; the dashboard renders whatever
        // it is told, so a new signal cannot silently vanish from the table.
        signals: SIGNAL_LABELS,
        thresholds: { slowTtfbMs: SLOW_TTFB_MS, thinReviews: THIN_REVIEW_COUNT },
        minQueryLength: MIN_QUERY_LENGTH,
        // Same reason as the signals above: the page must not hardcode a budget
        // that .env can change, or the sizing hint will describe a run you would
        // not actually get. maxCalls is the backstop, maxResults the default cap.
        budget: {
          maxCalls: env.MAX_CALLS,
          maxResults: env.MAX_RESULTS,
          // Served for the same reason as the other two: this default lived in
          // three places at once (env 4, search.ts 3, the page 2) and disagreed
          // with itself. env.MAX_TILE_DEPTH is now the only definition.
          maxDepth: env.MAX_TILE_DEPTH,
        },
      }),
    );
    return;
  }

  if (url.pathname === '/api/searches') {
    listSearches()
      .then((items) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      });
    return;
  }

  if (url.pathname === '/api/search-file') {
    readSearch(url.searchParams.get('file') ?? '')
      .then((body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        // An ENOENT from fs carries the absolute path it tried, which puts the
        // server's directory layout in a response body. The caller asked for a
        // file by name and either got it or did not; nothing else is its
        // business. The real reason still goes to the console for debugging.
        if (err instanceof Error) console.error(`search-file: ${err.message}`);
        const known = err instanceof Error && err.message === 'bad file name';
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: known ? 'bad file name' : 'no such search' }));
      });
    return;
  }

  // What the free allowance looks like right now, read straight from the same
  // ledger a sweep reserves against — not a second copy of the arithmetic. A
  // budget you cannot see before you spend it is one you find out about after.
  // What is already in the sheet. The table used to sit empty until someone
  // searched, which hid 326 collected prospects behind a form.
  if (url.pathname === '/api/leads') {
    const limit = Number(url.searchParams.get('limit')) || 500;
    const offset = Number(url.searchParams.get('offset')) || 0;
    fetchStoredLeads(
      { url: env.SHEETS_WEBAPP_URL ?? '', token: env.SHEETS_INGEST_TOKEN ?? '' },
      { limit, offset },
    )
      .then((result) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Always 200: fetchStoredLeads never throws, and the page needs to tell
        // "nothing collected yet" apart from "could not reach the sheet".
        res.end(JSON.stringify(result));
      })
      .catch((err: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            leads: [],
            total: 0,
            error: err instanceof Error ? err.message : 'unreadable',
          }),
        );
      });
    return;
  }

  if (url.pathname === '/api/quota') {
    // The request handler is not async, so this follows the same then/catch
    // shape the other asynchronous routes use.
    peek({ dayCap: env.PLACES_DAILY_LIMIT })
      .then((q) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            day: { used: q.dayUsed, cap: q.dayCap, remaining: q.dayRemaining, resetsAt: q.dayResetsAt },
            month: { used: q.used, cap: q.cap, remaining: q.remaining, resetsAt: q.resetsAt },
            // The tighter of the two is what stops the next sweep.
            canSearch: q.dayRemaining > 0 && q.remaining > 0,
          }),
        );
      })
      .catch((err: unknown) => {
        // A ledger that cannot be read must not take the dashboard down with
        // it — the page still works, it just cannot show a budget.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'unreadable' }));
      });
    return;
  }

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        keyLoaded: Boolean(env.GOOGLE_MAPS_API_KEY),
        // Whether a finished search will reach the spreadsheet. Worth being
        // able to see before a sweep rather than after one.
        sheetConfigured: isConfigured(env.SHEETS_WEBAPP_URL, env.SHEETS_INGEST_TOKEN),
      }),
    );
    return;
  }

  // Static, and only from the public folder — no path traversal.
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  if (name.includes('..')) {
    res.writeHead(400).end('bad path');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.'));
  readFile(join(HERE, 'public', name))
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(buf);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Rekreate dashboard  →  http://${HOST}:${PORT}`);
  console.log(`  API key loaded from .env. Press Ctrl+C to stop.\n`);
});

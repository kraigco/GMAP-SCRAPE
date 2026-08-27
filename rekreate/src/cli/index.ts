import { Command } from 'commander';
import { loadEnv } from '../config/env.ts';
import { resolveMarket, resolveNiche } from '../config/niches/property-management.ts';
import { resolveLocation, termsForNiche } from '../places/geocode.ts';
import { createPlacesClient } from '../places/client.ts';
import { dedupeById } from '../places/dedupe.ts';
import { estimateCostUsd, ENTERPRISE_FREE_CALLS_PER_MONTH } from '../places/field-mask.ts';
import { release, reserve } from '../places/usage.ts';
import { cachingSweep, load as loadTileCache, TILE_CACHE_PATH } from '../places/tile-cache.ts';
import { sweepTiles } from '../places/tiling.ts';
import type { RawPlace, RejectedPlace } from '../places/schema.ts';
import { parseCsv, writeCsv, writeEnrichedCsv, scoreEnrichedRow, LEAD_COLUMNS } from '../export/csv.ts';
import { filterPlaces } from '../lead/filters.ts';
import type { EnrichedRow } from '../export/csv.ts';
import { auditSite } from '../audit/site.ts';
import { mapPool } from '../lib/concurrency.ts';
import { guardSocketTeardown } from '../lib/fetch-guard.ts';
import { parseEnrichedCsv } from '../export/csv.ts';
import { parseSearchBaseName } from '../export/search-file.ts';
import { describeResult, isConfigured, pushLeads, toSheetLead } from '../export/sheets.ts';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Where the dashboard writes every search. */
const SEARCH_DIR = 'out/searches';

const program = new Command();

program
  .name('rekreate')
  .description('Rekreate Lead Intelligence Engine')
  .version('0.1.0');

program
  .command('harvest')
  .description('Sweep a market for prospects and write them to CSV')
  .option('-n, --niche <id-or-text>', 'saved niche config, or any free text', 'property-management')
  .option('-L, --location <text>', 'any place name — geocoded to a search box')
  .option('-m, --market <id>', 'saved market, used when --location is absent', 'philadelphia-core')
  .option('-T, --terms <a,b,c>', 'exact search terms, overriding the niche')
  .option('--max-calls <n>', 'hard ceiling on Places API calls', (v) => Number(v))
  .option('--max-results <n>', 'stop once this many businesses are found', (v) => Number(v))
  .option('--max-depth <n>', 'tiling recursion floor', (v) => Number(v))
  .option('-k, --keywords <n>', 'use only the first N keywords', (v) => Number(v))
  .option('--min-rating <n>', 'drop anything rated below this (Google scale, 0-5)', (v) => Number(v))
  .option('--min-reviews <n>', 'drop anything with fewer reviews — a size proxy', (v) => Number(v))
  .option('--require-website', 'drop prospects with no website listed', false)
  .option('--keep-unrated', 'keep businesses with no rating when --min-rating is set', false)
  .option('-o, --out <path>', 'CSV output path', 'out/leads.csv')
  .option('--dry-run', 'run the sweep but write no file', false)
  .action(async (opts: Record<string, unknown>) => {
    const env = loadEnv();
    const nicheArg = String(opts['niche']);

    // A saved niche brings curated terms and disqualifiers; free text falls
    // back to generated ones. Either way the location can be anywhere.
    let savedNiche: ReturnType<typeof resolveNiche> | null = null;
    try {
      savedNiche = resolveNiche(nicheArg);
    } catch {
      savedNiche = null;
    }

    let allTerms: string[];
    if (typeof opts['terms'] === 'string' && opts['terms'].trim()) {
      allTerms = opts['terms'].split(',').map((t) => t.trim()).filter(Boolean);
    } else if (savedNiche) {
      allTerms = savedNiche.keywords;
    } else {
      allTerms = termsForNiche(nicheArg);
    }

    const maxCalls = typeof opts['maxCalls'] === 'number' ? opts['maxCalls'] : env.MAX_CALLS;
    const maxResults = typeof opts['maxResults'] === 'number' ? opts['maxResults'] : env.MAX_RESULTS;
    const maxDepth = typeof opts['maxDepth'] === 'number' ? opts['maxDepth'] : env.MAX_TILE_DEPTH;
    const keywordLimit = typeof opts['keywords'] === 'number' ? opts['keywords'] : allTerms.length;
    const keywords = allTerms.slice(0, keywordLimit);
    const dryRun = opts['dryRun'] === true;

    // Claim this run's calls out of the month's free allowance BEFORE anything
    // reaches Google — and that includes resolving the location, which is a
    // places:searchText call like any other and spends from the same metric.
    // Reserving after it meant an exhausted month still paid for a geocode and
    // then reported a raw 429 instead of saying the allowance was gone.
    //
    // A per-run cap cannot make this guarantee alone: thirty runs of forty-five
    // is 1,350 against an allowance of 1,000. Only a figure that outlives the
    // process can.
    const budget = await reserve(maxCalls, { dayCap: env.PLACES_DAILY_LIMIT });
    if (budget.granted === 0) {
      console.log('\nNo free Places calls left this month.');
      console.log(`  used       ${budget.used} of ${budget.cap}`);
      console.log(`  resets     ${budget.resetsAt}`);
      console.log('  Auditing and pushing still work — they cost no Places quota.\n');
      return;
    }
    const granted = budget.granted;

    let bbox;
    let placeLabel: string;
    // Counted separately from the sweep because the client never sees it, and
    // an uncounted call is exactly the leak this ledger exists to close.
    let geocodeCalls = 0;
    if (typeof opts['location'] === 'string' && opts['location'].trim()) {
      process.stdout.write(`  resolving "${opts['location']}" …`);
      const resolved = await resolveLocation(opts['location'], { apiKey: env.GOOGLE_MAPS_API_KEY });
      geocodeCalls = 1;
      process.stdout.write('\r' + ' '.repeat(60) + '\r');
      bbox = resolved.bbox;
      placeLabel = resolved.formattedAddress;
      const km = Math.round(resolved.spanLat * 111);
      if (km > 120) {
        console.log(`  NOTE: that box is roughly ${km}km across. Expect a long sweep — raise --max-calls or narrow the location.\n`);
      }
    } else {
      if (!savedNiche) {
        throw new Error(`"${nicheArg}" is not a saved niche, so --location is required.`);
      }
      const market = resolveMarket(savedNiche, String(opts['market']));
      bbox = market.bbox;
      placeLabel = market.label;
    }

    const client = createPlacesClient({
      apiKey: env.GOOGLE_MAPS_API_KEY,
      maxCalls: Math.max(0, granted - geocodeCalls),
    });

    console.log(`\nHarvest — ${savedNiche ? savedNiche.label : nicheArg}`);
    console.log(`  location    ${placeLabel}`);
    console.log(`  terms       ${keywords.length} of ${allTerms.length}${savedNiche ? '' : ' (generated — no saved config)'}`);
    console.log(`  budget      ${maxResults} businesses, ${granted} calls, max depth ${maxDepth}`);
    console.log(
      `  free tier   ${budget.used} of ${budget.cap} calls reserved this month, ` +
        `${budget.remaining} left after this run`,
    );
    if (granted < maxCalls) {
      console.log(`  TRIMMED     asked for ${maxCalls}, the month can only afford ${granted}`);
    }
    console.log(`  output      ${dryRun ? '(dry run — no file written)' : opts['out']}\n`);

    const batches: RawPlace[][] = [];
    const rejected: RejectedPlace[] = [];
    let tilesSearched = 0;
    let tilesSplit = 0;
    let truncatedLeaves = 0;
    let maxDepthHit = 0;
    let halted = false;
    // A running dedupe, so the sweep can stop the moment it has enough. Only
    // decides WHEN to halt; dedupeById below stays the authority on the result.
    const seen = new Set<string>();
    let resultCapReached = false;
    // Tiles already paid for inside the TTL replay from disk, so a sweep cut
    // short by the daily budget resumes here tomorrow instead of restarting.
    const cache = cachingSweep(await loadTileCache(TILE_CACHE_PATH), { path: TILE_CACHE_PATH });

    for (const keyword of keywords) {
      if (client.budgetExhausted()) {
        halted = true;
        console.log(`  skipped "${keyword}" — budget spent`);
        continue;
      }
      if (seen.size >= maxResults) {
        resultCapReached = true;
        console.log(`  skipped "${keyword}" — ${maxResults}-business limit reached`);
        continue;
      }

      const sweep = await sweepTiles<RawPlace>(
        bbox,
        cache.fetcher(keyword, async (bbox) => {
          const tile = await client.searchTile(keyword, bbox);
          rejected.push(...tile.rejected);
          return { items: tile.places, truncated: tile.truncated };
        }),
        { maxDepth, shouldHalt: () => client.budgetExhausted() || seen.size >= maxResults },
      );

      // Counted here rather than in the fetcher so replayed tiles feed the
      // result cap exactly as freshly-fetched ones do.
      for (const found of sweep.items) seen.add(found.id);

      batches.push(sweep.items);
      tilesSearched += sweep.tilesSearched;
      tilesSplit += sweep.tilesSplit;
      truncatedLeaves += sweep.truncatedLeaves;
      maxDepthHit = Math.max(maxDepthHit, sweep.maxDepthHit);
      halted = halted || sweep.halted;

      console.log(
        `  "${keyword}" — ${sweep.items.length} found, ` +
          `${sweep.tilesSearched} tiles (${sweep.tilesSplit} split), ` +
          `${client.callsUsed()}/${maxCalls} calls used`,
      );
    }

    const filters = {
      minRating: typeof opts['minRating'] === 'number' ? opts['minRating'] : undefined,
      minReviews: typeof opts['minReviews'] === 'number' ? opts['minReviews'] : undefined,
      requireWebsite: opts['requireWebsite'] === true,
      keepUnrated: opts['keepUnrated'] === true,
    };

    const deduped = dedupeById(batches);
    // A tile returns up to 20 at once, so the sweep can cross the cap mid-tile.
    // Trim to what was asked for; the summary still says the market was not
    // exhausted, rather than passing a slice off as the whole of it.
    if (seen.size >= maxResults) resultCapReached = true;
    const collected = resultCapReached ? deduped.unique.slice(0, maxResults) : deduped.unique;
    const filterResult = filterPlaces(collected, filters);
    const unique = filterResult.kept;
    const duplicatesDropped = deduped.duplicatesDropped;
    const withWebsite = unique.filter((p) => p.websiteUri).length;
    const withPhone = unique.filter((p) => p.nationalPhoneNumber).length;
    const callsUsed = client.callsUsed();

    // Give back what the sweep did not spend. Until this runs the month shows
    // the full reservation, which is the right way round: an interrupted run
    // forfeits its unused budget rather than risking a bill.
    await release(granted, callsUsed + geocodeCalls);
    await cache.flush();

    if (!dryRun && unique.length > 0) {
      await writeCsv(String(opts['out']), unique, new Date().toISOString());
    }

    console.log('\nRun summary');
    console.log(`  unique prospects   ${unique.length}`);
    console.log(`  duplicates dropped ${duplicatesDropped}`);
    console.log(`  with a website     ${withWebsite}`);
    console.log(`  with a phone       ${withPhone}`);
    console.log(`  tiles searched     ${tilesSearched} (${tilesSplit} split, deepest ${maxDepthHit})`);
    console.log(`  calls used         ${callsUsed} of ${maxCalls}`);
    if (cache.hits() > 0) {
      console.log(`  from cache         ${cache.hits()} tile(s) replayed free — resumed, not re-paid`);
    }
    if (resultCapReached) {
      console.log(`  PARTIAL            stopped at the ${maxResults}-business limit — the market holds more.`);
      console.log('                     Raise --max-results to cover the rest.');
    }
    console.log(
      `  estimated cost     $${estimateCostUsd(callsUsed).toFixed(2)} ` +
        `(first ${ENTERPRISE_FREE_CALLS_PER_MONTH}/month are free)`,
    );

    for (const drop of filterResult.report.dropped) {
      console.log(`  filtered out       ${drop.count} — ${drop.reason}`);
    }

    if (rejected.length > 0) {
      console.log(`  malformed records  ${rejected.length} rejected (kept out of the file)`);
    }

    // Coverage honesty: never let an incomplete sweep look like a clean one.
    if (halted) {
      console.log('\n  HALTED — the call budget ran out before the sweep finished.');
      console.log('  Re-run with a higher --max-calls to cover the rest of this market.');
    }
    if (truncatedLeaves > 0) {
      console.log(`\n  ${truncatedLeaves} tile(s) still had more results than Google would return.`);
      console.log(`  Those areas are under-sampled. Raise --max-depth above ${maxDepth} to dig further.`);
    }

    if (!dryRun && unique.length > 0) console.log(`\n  Wrote ${opts['out']}\n`);
    else console.log('');
  });

program
  .command('audit')
  .description("Visit each prospect's site to find a contact email and infrastructure gaps")
  .option('-i, --in <path>', 'harvest CSV to read', 'out/leads.csv')
  .option('-o, --out <path>', 'enriched CSV to write', 'out/leads-audited.csv')
  .option('-c, --concurrency <n>', 'simultaneous site fetches', (v) => Number(v), 6)
  .option('-l, --limit <n>', 'audit only the first N prospects', (v) => Number(v))
  .option('-t, --timeout <ms>', 'per-request timeout', (v) => Number(v), 9000)
  .option('--require-email', 'write only rows where an address was found', false)
  .action(async (opts: Record<string, unknown>) => {
    const inPath = String(opts['in']);
    const rows = parseCsv(await readFile(inPath, 'utf8'));
    const header = rows[0] ?? [];
    const body = rows.slice(1);

    const idIdx = header.indexOf('place_id');
    const siteIdx = header.indexOf('website');
    if (idIdx === -1 || siteIdx === -1) {
      throw new Error(`${inPath} has no place_id/website columns — is it a harvest CSV?`);
    }

    // The input may already BE an enriched CSV. Re-auditing one is the normal
    // way to refresh a saved search, and it used to corrupt the output: `base`
    // carried the WHOLE input row, so renderEnrichedCsv appended the nine audit
    // columns a second time onto rows that already had them — 30 fields under a
    // 21-column header. parseEnrichedCsv reads by header position, so it then
    // returned the STALE values and silently discarded the audit just paid for.
    // Projecting the harvest columns by NAME makes the output the same shape
    // whether the input was a raw harvest or an already-enriched file.
    const harvestIdx = LEAD_COLUMNS.map((column) => header.indexOf(column));

    const limit = typeof opts['limit'] === 'number' ? opts['limit'] : body.length;
    const targets = body.slice(0, limit);
    const concurrency = Number(opts['concurrency']);
    const timeoutMs = Number(opts['timeout']);

    console.log(`\nAudit — ${targets.length} prospects from ${inPath}`);
    console.log(`  concurrency ${concurrency}, timeout ${timeoutMs}ms`);
    console.log('  fetching each site\'s homepage, then its contact page only if needed\n');

    // Counted rather than silenced, so a workaround cannot quietly become
    // permanent — the summary prints the number if it is not zero.
    let socketBugs = 0;
    guardSocketTeardown(() => { socketBugs += 1; });

    let lastPct = -1;
    const audits = await mapPool(
      targets,
      concurrency,
      async (row) => auditSite(row[idIdx] ?? '', row[siteIdx] || null, { timeoutMs }),
      (done, total) => {
        const pct = Math.floor((done / total) * 20) * 5;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`\r  ${pct}%  (${done}/${total})   `);
        }
      },
    );
    process.stdout.write('\r' + ' '.repeat(28) + '\r');

    const enriched: EnrichedRow[] = targets.map((row, i) => {
      const a = audits[i]!;
      const measured = {
        base: harvestIdx.map((idx) => (idx === -1 ? '' : row[idx] ?? '')),
        emails: a.emails,
        reachable: a.reachable,
        https: a.https,
        ttfbMs: a.ttfbMs,
        mobileViewport: a.mobileViewport,
        contactForm: a.contactForm,
        finalUrl: a.finalUrl,
        error: a.error,
      };
      return { ...measured, score: scoreEnrichedRow(measured) };
    });

    const gated = opts['requireEmail'] === true
      ? enriched.filter((r) => r.emails.length > 0)
      : enriched;
    await writeEnrichedCsv(String(opts['out']), gated);

    const n = (fn: (a: (typeof audits)[number]) => boolean): number => audits.filter(fn).length;
    const withEmail = n((a) => a.emails.length > 0);
    const reachable = n((a) => a.reachable === 'yes');
    const ttfbs = audits.map((a) => a.ttfbMs).filter((t): t is number => t !== null).sort((x, y) => x - y);

    console.log('Audit summary');
    console.log(`  emails found       ${withEmail} of ${targets.length}  (${((withEmail / targets.length) * 100).toFixed(0)}%)`);
    console.log(`  sites reachable    ${reachable}`);
    console.log(`  unreachable        ${n((a) => a.reachable === 'no')}`);
    console.log(`  robots disallowed  ${n((a) => a.robotsBlocked)}`);
    console.log(`  HTTPS after redirect ${n((a) => a.https === 'yes')}   still insecure: ${n((a) => a.https === 'no')}`);
    console.log(`  no mobile viewport ${n((a) => a.mobileViewport === 'no')}`);
    console.log(`  contact form found ${n((a) => a.contactForm === 'yes')}`);
    if (ttfbs.length) {
      console.log(`  median TTFB        ${ttfbs[Math.floor(ttfbs.length / 2)]}ms   slowest ${ttfbs[ttfbs.length - 1]}ms`);
    }
    if (opts['requireEmail'] === true) {
      console.log(`  withheld           ${enriched.length - gated.length} row(s) with no email`);
    }
    if (socketBugs > 0) {
      console.log(`  survived           ${socketBugs} client-level socket fault(s) — see src/lib/fetch-guard.ts`);
    }
    console.log(`\n  Wrote ${gated.length} row(s) to ${opts['out']}\n`);
  });

program
  .command('push')
  .description('Send saved searches to the Google Sheet (upserts on place_id — safe to re-run)')
  .option('-i, --in <path>', 'one CSV to push')
  .option('-a, --all', 'push every search in out/searches', false)
  .action(async (opts: Record<string, unknown>) => {
    const env = loadEnv();
    if (!isConfigured(env.SHEETS_WEBAPP_URL, env.SHEETS_INGEST_TOKEN)) {
      throw new Error(
        'SHEETS_WEBAPP_URL and SHEETS_INGEST_TOKEN must both be set in .env.\n' +
          'Deploy apps-script/Code.gs as a Web App and paste its URL into SHEETS_WEBAPP_URL.',
      );
    }
    const target = {
      url: env.SHEETS_WEBAPP_URL ?? '',
      token: env.SHEETS_INGEST_TOKEN ?? '',
    };

    let files: string[];
    if (typeof opts['in'] === 'string' && opts['in']) {
      files = [opts['in']];
    } else if (opts['all'] === true) {
      // Oldest first, so the first_listed date a prospect ends up with is the
      // earliest run that actually saw it — not whichever file went up last.
      files = (await readdir(SEARCH_DIR))
        .filter((n) => n.endsWith('.csv'))
        .sort()
        .map((n) => join(SEARCH_DIR, n));
    } else {
      throw new Error('Give --in <path> or --all.');
    }

    if (files.length === 0) {
      console.log('\nNothing to push — no CSVs in out/searches.\n');
      return;
    }

    console.log(`\nPush — ${files.length} file(s) to the Leads tab\n`);
    let added = 0;
    let refreshed = 0;
    let skipped = 0;

    for (const file of files) {
      const leads = parseEnrichedCsv(await readFile(file, 'utf8'));
      if (leads.length === 0) {
        console.log(`  ${basename(file)} — no rows, skipped`);
        continue;
      }

      // A file named off-convention parses to null, and every field derived
      // from the name then quietly defaults: blank niche, blank location, blank
      // refresh date — and, worst of the four, an empty niche sends every hook
      // in the file to the `general` fallback stakes line instead of the one
      // written for that trade. That is silent and it is wrong in the sheet, so
      // it is refused rather than warned about. Renaming the file fixes it and
      // costs nothing; a re-push is free.
      const parsed = parseSearchBaseName(basename(file));
      if (!parsed) {
        console.log(`  ${basename(file)} — SKIPPED, the name does not carry a date, location and niche`);
        console.log('       Expected YYYYMMDD-HHMMSS_location_niche.csv — without it the sheet');
        console.log('       gets a blank niche and every hook falls back to generic copy.');
        skipped += 1;
        continue;
      }

      const result = await pushLeads(
        leads.map((lead) =>
          toSheetLead(lead, {
            niche: parsed.niche,
            location: parsed.location,
            refreshedAt: parsed.when ?? '',
          }),
        ),
        null,
        target,
      );

      console.log(`  ${basename(file)} — ${describeResult(result)}`);
      if (!result.ok) {
        console.log('\n  Stopped. Nothing further was sent.\n');
        process.exitCode = 1;
        return;
      }
      added += result.inserted;
      refreshed += result.updated;
    }

    console.log(`\n  ${added} new prospect(s), ${refreshed} refreshed.`);
    if (skipped > 0) {
      console.log(`  ${skipped} file(s) skipped for an unreadable name — rename and re-run, it costs nothing.`);
      process.exitCode = 1;
    }
    console.log('');
  });

await program.parseAsync(process.argv);

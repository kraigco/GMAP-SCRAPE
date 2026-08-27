/**
 * Rekreate lead ingest — bound to the leads spreadsheet.
 *
 * Deployed as a Web App, this runs AS THE OWNER of the spreadsheet, so it needs
 * no service account, no OAuth client and no consent screen. The scraper POSTs
 * a batch of leads; this writes them.
 *
 * Rows are keyed on place_id and UPSERTED, so re-scraping the same area updates
 * the rows it already wrote instead of piling up duplicates. Three columns are
 * never overwritten once set:
 *
 *   first_listed   — the date a prospect first appeared in any scrape
 *   review_status  — yours
 *   notes          — yours
 *
 * That split is the whole point: the scraper owns the facts it collected, you
 * own your judgement about them, and neither can quietly destroy the other.
 */

/**
 * The shared secret, which must equal SHEETS_INGEST_TOKEN in the repo's .env.
 *
 * Set it in Project Settings > Script Properties, as a property named
 * INGEST_TOKEN. That is better than editing it here for two reasons: a
 * property is a plain value, so there are no quotes to get wrong, and changing
 * it takes effect immediately, whereas changing this file does nothing until
 * the Web App is deployed again.
 *
 * The constant below is only a fallback for when no property is set.
 */
const INGEST_TOKEN = 'PASTE_TOKEN_HERE';

function ingestToken() {
  const stored = PropertiesService.getScriptProperties().getProperty('INGEST_TOKEN');
  if (stored && stored.trim()) return stored.trim();
  return INGEST_TOKEN === 'PASTE_TOKEN_HERE' ? '' : String(INGEST_TOKEN).trim();
}

/**
 * The target spreadsheet.
 *
 * Only used when the script is NOT bound to a sheet — a project created from
 * script.google.com has no active spreadsheet, and `getActive()` quietly
 * returns null there, which surfaces later as an unhelpful error a long way
 * from its cause. With this set, the script works either way.
 */
const SPREADSHEET_ID = '1VFBHcbtfMmUu6p6mGw2bMExFdZ8iiwev3BAfEXaxgTE';

const LEADS_TAB = 'Leads';
const RUNS_TAB = 'Runs';

const COLUMNS = [
  'place_id',        // A  the key — never rewritten
  'first_listed',    // B  written once, on the first sighting
  'last_seen',       // C  ─┐
  'name',            // D   │
  'address',         // E   │
  'phone',           // F   │
  'email',           // G   │
  'email_alt',       // H   │
  'website',         // I   │
  'rating',          // J   │
  'reviews',         // K   │
  'signals',         // L   │  refreshed on every scrape
  'reachable',       // M   │
  'https',           // N   │
  'ttfb_ms',         // O   │
  'mobile_viewport', // P   │
  'contact_form',    // Q   │
  'business_status', // R   │
  'primary_type',    // S   │
  'latitude',        // T   │
  'longitude',       // U   │
  'final_url',       // V   │
  'audit_error',     // W   │
  'niche',           // X   │
  'search_location', // Y   │
  'google_refreshed_at', // Z ─┘
  'review_status',   // AA yours
  'notes',           // AB yours
  'hook',            // AC derived from the audit — refreshed
  'hook_basis',      // AD which finding the hook rests on
];

/**
 * The blocks a re-scrape may overwrite, as [from, to] index pairs.
 *
 * Two ranges rather than one because your columns sit in the middle: the
 * scraper owns C..Z and AC..AD, you own AA..AB, and nothing the scraper does
 * can reach across that gap.
 */
const REFRESH_RANGES = [[2, 25], [28, 29]];

const RUN_COLUMNS = [
  'finished_at', 'location', 'niche', 'terms', 'prospects', 'with_email',
  'tiles', 'tiles_split', 'calls_used', 'max_calls', 'estimated_cost_usd',
  'duplicates_dropped', 'halted', 'aborted', 'file',
];

/* ------------------------------------------------------------------ web app */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty request' });
    }
    const body = JSON.parse(e.postData.contents);
    const expected = ingestToken();

    if (!expected) {
      return json({
        ok: false,
        error: 'no INGEST_TOKEN is set — add it under Project Settings > Script Properties',
      });
    }
    if (body.token !== expected) {
      return json({ ok: false, error: 'bad token' });
    }

    const result = ingest(body.leads || [], body.run || null);
    result.ok = true;
    return json(result);
  } catch (err) {
    // Apps Script web apps always answer 200, so failures have to travel in the
    // body. The caller checks `ok`, never the status code.
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  const expected = ingestToken();
  const authorised = Boolean(expected) && e && e.parameter && e.parameter.token === expected;
  // Deliberately vague to an unauthorised caller, and specific enough to be a
  // health check for an authorised one.
  if (!authorised) {
    return json({ ok: true, service: 'rekreate-ingest', authorised: false });
  }

  // book() throws when the script is not bound to a sheet. Unhandled, that
  // returns an HTML error page, and an HTML body is indistinguishable from
  // Google's sign-in interstitial — so the health check would report a
  // permissions problem for what is actually a configuration one.
  try {
    const sheet = book().getSheetByName(LEADS_TAB);
    return json({
      ok: true,
      service: 'rekreate-ingest',
      leads: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0,
      // A deployment is a SNAPSHOT: saving the editor changes nothing until
      // you redeploy a new version. Reporting the column set this code knows
      // about makes "did the redeploy take?" a question you can answer by
      // reading a health check, instead of by pushing rows and squinting at
      // the sheet.
      columns: COLUMNS,
    });
  } catch (err) {
    return json({
      ok: false,
      service: 'rekreate-ingest',
      error: String(err && err.message ? err.message : err),
    });
  }
}

/* -------------------------------------------------------------------- write */

function ingest(leads, run) {
  // Two scrapes finishing together would otherwise read the same last row and
  // one would overwrite the other's appended block.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = tab(LEADS_TAB, COLUMNS);
    const width = COLUMNS.length;
    const lastRow = sheet.getLastRow();
    // Read the sheet's own width, then pad — rows written before a column was
    // added come back short, and setValues rejects a ragged block.
    const stored = Math.max(sheet.getLastColumn(), width);
    const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, stored).getValues() : [];
    for (let i = 0; i < existing.length; i++) {
      while (existing[i].length < width) existing[i].push('');
      existing[i].length = width;
    }

    const seen = {};
    for (let i = 0; i < existing.length; i++) {
      const id = String(existing[i][0] || '');
      if (id) seen[id] = i;
    }

    const now = new Date();
    const fresh = [];
    const freshSeen = {};
    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < leads.length; i++) {
      const row = toRow(leads[i], now);
      const id = row[0];
      if (!id) continue;

      if (Object.prototype.hasOwnProperty.call(seen, id)) {
        refresh(existing[seen[id]], row);
        updated++;
      } else if (Object.prototype.hasOwnProperty.call(freshSeen, id)) {
        // Same prospect twice in one batch — the later reading wins, and it
        // must not become a second row.
        refresh(fresh[freshSeen[id]], row);
      } else {
        freshSeen[id] = fresh.length;
        fresh.push(row);
        inserted++;
      }
    }

    if (updated > 0 && existing.length > 0) {
      sheet.getRange(2, 1, existing.length, width).setValues(existing);
    }
    if (fresh.length > 0) {
      sheet.getRange(Math.max(lastRow, 1) + 1, 1, fresh.length, width).setValues(fresh);
    }
    if (run) appendRun(run);

    const total = Math.max(0, sheet.getLastRow() - 1);
    return { inserted: inserted, updated: updated, total: total };
  } finally {
    lock.releaseLock();
  }
}

/** Copy only the columns a re-scrape owns. first_listed and your two stay put. */
function refresh(target, incoming) {
  for (let r = 0; r < REFRESH_RANGES.length; r++) {
    const range = REFRESH_RANGES[r];
    for (let i = range[0]; i <= range[1]; i++) target[i] = incoming[i];
  }
}

function toRow(lead, now) {
  const l = lead || {};
  return [
    str(l.id),
    now,                                   // first_listed — insert only
    now,                                   // last_seen
    str(l.name),
    str(l.address),
    str(l.phone),
    str(l.email),
    join(l.emailAlt),
    str(l.website),
    num(l.rating),
    num(l.reviews),
    join(l.signals),
    str(l.reachable),
    str(l.https),
    num(l.ttfb),
    str(l.viewport),
    str(l.contactForm),
    str(l.businessStatus),
    str(l.primaryType),
    num(l.lat),
    num(l.lng),
    str(l.finalUrl),
    str(l.auditError),
    str(l.niche),
    str(l.searchLocation),
    str(l.googleRefreshedAt),
    'unreviewed',
    '',
    str(l.hook),
    str(l.hookBasis),
  ];
}

function appendRun(run) {
  const sheet = tab(RUNS_TAB, RUN_COLUMNS);
  sheet.appendRow([
    str(run.finishedAt), str(run.location), str(run.niche),
    join(run.terms), num(run.prospects), num(run.withEmail),
    num(run.tilesSearched), num(run.tilesSplit), num(run.callsUsed), num(run.maxCalls),
    num(run.estimatedCostUsd), num(run.duplicatesDropped),
    run.halted ? 'yes' : 'no', run.aborted ? 'yes' : 'no', str(run.file),
  ]);
}

/* ------------------------------------------------------------------ helpers */

/**
 * The spreadsheet to write to, bound or not.
 *
 * `getActive()` returns null in a standalone project rather than complaining,
 * so every later call fails somewhere unrelated. This says what is wrong at the
 * point where it is knowable.
 */
function book() {
  const active = SpreadsheetApp.getActive();
  if (active) return active;

  if (!SPREADSHEET_ID) {
    throw new Error(
      'This script is not attached to a spreadsheet, and SPREADSHEET_ID is empty. ' +
        'Either open the sheet and use Extensions > Apps Script, or set SPREADSHEET_ID.',
    );
  }
  try {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (err) {
    throw new Error(
      'Cannot open the spreadsheet with id ' + SPREADSHEET_ID + '. ' +
        'Check the id, and that this account can edit it. (' + err + ')',
    );
  }
}

/**
 * Find a tab, or make one. A brand new spreadsheet arrives with an empty
 * "Sheet1"; that gets renamed rather than left behind as clutter.
 */
function tab(name, headers) {
  const target = book();
  let sheet = target.getSheetByName(name);

  if (!sheet) {
    const sheets = target.getSheets();
    const blank = sheets.length === 1 && sheets[0].getLastRow() === 0 ? sheets[0] : null;
    sheet = blank ? blank.setName(name) : target.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 60);   // place_id is a key, not something to read
    return sheet;
  }

  // A sheet written by an older version has fewer columns than this one now
  // defines. Appending the missing headers is safe — every existing column
  // keeps its position, so no row shifts and nothing already written moves out
  // from under the header it belongs to.
  const width = sheet.getLastColumn();
  if (width < headers.length) {
    const missing = headers.slice(width);
    const range = sheet.getRange(1, width + 1, 1, missing.length);
    range.setValues([missing]);
    range.setFontWeight('bold');
  }
  return sheet;
}

function str(v) { return v === null || v === undefined ? '' : String(v); }
function num(v) { return v === null || v === undefined || v === '' ? '' : Number(v); }
function join(v) { return Array.isArray(v) ? v.join(' ') : str(v); }

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* -------------------------------------------------------------------- setup */

/**
 * Run this once from the editor to create both tabs and their headers, before
 * deploying. It proves the script can write to the sheet, and it means the
 * first real scrape is not also the first time any of this has ever run.
 */
function setup() {
  tab(LEADS_TAB, COLUMNS);
  tab(RUNS_TAB, RUN_COLUMNS);
  book().toast('Leads and Runs are ready.', 'Rekreate', 5);
}

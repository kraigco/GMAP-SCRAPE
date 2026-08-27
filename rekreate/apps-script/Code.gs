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
  'score',           // AE 0-100, who to call first — refreshed
  'score_band',      // AF hot / warm / cool / cold
  'score_why',       // AG the reasons behind the number
];

/**
 * The blocks a re-scrape may overwrite, as [from, to] index pairs.
 *
 * Two ranges rather than one because your columns sit in the middle: the
 * scraper owns C..Z and AC..AG, you own AA..AB, and nothing the scraper does
 * can reach across that gap. The score columns were appended on the far side
 * of review_status and notes deliberately — a ranking that overwrote someone's
 * "contacted" mark would make the sheet unusable as a worklist.
 */
const REFRESH_RANGES = [[2, 25], [28, 32]];

/**
 * Columns a person is allowed to correct by hand, through ?action=patch.
 *
 * Deliberately short, and everything left out is left out for a reason.
 *
 *   place_id            the key. Changing it does not edit a row, it orphans one.
 *   first_listed        history. It records when we first saw them, once.
 *   last_seen           when a scrape last touched this row.
 *   google_refreshed_at when Google data was last actually fetched.
 *
 * Those last two are the reason this whole action exists. Clearing one email
 * through the normal upsert would have stamped both with the time of the edit,
 * recording a Google refresh that never happened — and google_refreshed_at is
 * what the 30-day cache rule is measured from. A timestamp records that a
 * machine did something; writing one by hand makes it a claim instead.
 *
 * hook, hook_basis, score, score_band and score_why are also absent. They are
 * derived from the audit, and a hand-written hook is exactly the invented
 * problem the engine refuses to produce.
 */
const PATCHABLE = [
  'name', 'address', 'phone', 'email', 'email_alt', 'website',
  'review_status', 'notes',
];

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

    // Absent action means ingest, so every existing caller keeps working
    // unchanged — this deployment must stay backward compatible with the
    // dashboard and CLI that are already pointed at it.
    if (body.action === 'patch') {
      return json(patchLeads(body.patches || []));
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

    // ?action=leads reads the sheet back out, so the dashboard can show what
    // has been collected instead of an empty table until someone searches.
    if (e && e.parameter && e.parameter.action === 'leads') {
      return json(readLeads(sheet, e.parameter));
    }

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


/**
 * Read the Leads tab back out, newest first.
 *
 * Returns rows as plain arrays alongside the header, rather than objects. The
 * caller maps them by column NAME, so inserting a column here cannot silently
 * shift a field into the wrong place on the dashboard — the failure would be a
 * missing column rather than a phone number rendered as a rating.
 *
 * Paged because a whole sheet is not something to move in one response, and
 * capped because a runaway `limit` should be the server's problem, not the
 * spreadsheet's.
 */
function readLeads(sheet, params) {
  if (!sheet) return { ok: true, columns: COLUMNS, rows: [], total: 0 };

  const total = Math.max(0, sheet.getLastRow() - 1);
  if (total === 0) return { ok: true, columns: COLUMNS, rows: [], total: 0 };

  const width = Math.max(sheet.getLastColumn(), COLUMNS.length);
  const limit = Math.max(1, Math.min(1000, Number(params.limit) || 500));
  const offset = Math.max(0, Math.min(total, Number(params.offset) || 0));

  // Newest first: the sheet appends, so the last rows are the recent ones and
  // those are what anyone opening the dashboard wants to see.
  const take = Math.min(limit, total - offset);
  if (take <= 0) return { ok: true, columns: COLUMNS, rows: [], total: total };
  const startRow = total - offset - take + 2; // +1 header, +1 to 1-based

  const values = sheet.getRange(startRow, 1, take, width).getValues();
  values.reverse();

  // Dates arrive as Date objects and JSON.stringify would render them in the
  // script's timezone. ISO keeps them unambiguous for whoever reads them.
  const rows = values.map(function (row) {
    return row.map(function (cell) {
      return cell instanceof Date ? cell.toISOString() : cell;
    });
  });

  return { ok: true, columns: COLUMNS, rows: rows, total: total, offset: offset };
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

/**
 * Write named columns on named rows, and nothing else.
 *
 * The upsert cannot do this. It rewrites every column a scrape owns, including
 * the two timestamps, so using it to correct one field records a refresh that
 * did not happen. This touches only the cells asked for.
 *
 * Every patch is checked before ANY cell is written: a batch with one bad
 * column name changes nothing at all. A partial write here would be the worst
 * outcome, because the caller would have to diff the sheet to find out what
 * actually landed.
 *
 * Returns what happened per patch rather than a bare count — "2 of 5 applied"
 * with no way to tell which three were missing is not a usable answer.
 */
function patchLeads(patches) {
  if (!patches.length) return { ok: false, error: 'no patches supplied' };
  if (patches.length > 500) return { ok: false, error: 'too many patches in one call (max 500)' };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = book().getSheetByName(LEADS_TAB);
    if (!sheet) return { ok: false, error: 'no ' + LEADS_TAB + ' tab' };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { ok: false, error: 'the sheet holds no leads' };

    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const rowOf = {};
    for (let i = 0; i < ids.length; i++) {
      const id = String(ids[i][0] || '');
      if (id) rowOf[id] = i + 2;               // 1-based, and row 1 is the header
    }

    // Validate the whole batch first. Nothing is written until all of it passes.
    const planned = [];
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i] || {};
      const id = String(p.placeId || '');
      const column = String(p.column || '');

      if (!id) return { ok: false, error: 'patch ' + i + ' has no placeId' };
      if (PATCHABLE.indexOf(column) === -1) {
        return {
          ok: false,
          error: 'patch ' + i + ': column "' + column + '" is not patchable. Allowed: ' +
            PATCHABLE.join(', '),
        };
      }
      if (!Object.prototype.hasOwnProperty.call(rowOf, id)) {
        return { ok: false, error: 'patch ' + i + ': no lead with place_id ' + id };
      }

      planned.push({
        row: rowOf[id],
        col: COLUMNS.indexOf(column) + 1,
        placeId: id,
        column: column,
        value: p.value === undefined || p.value === null ? '' : String(p.value),
      });
    }

    const applied = [];
    for (let i = 0; i < planned.length; i++) {
      const job = planned[i];
      const cell = sheet.getRange(job.row, job.col);
      const before = String(cell.getValue() || '');
      // Report a no-op as a no-op. "Applied" on a cell that already held the
      // value invites a caller to believe it changed something.
      cell.setValue(job.value);
      applied.push({
        placeId: job.placeId,
        column: job.column,
        before: before,
        after: job.value,
        changed: before !== job.value,
      });
    }

    return { ok: true, applied: applied, changed: applied.filter(function (a) { return a.changed; }).length };
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
    num(l.score),
    str(l.scoreBand),
    str(l.scoreWhy),
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

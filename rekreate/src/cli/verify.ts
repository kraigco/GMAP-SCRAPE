/**
 * `npm run verify` — checks every credential this project needs and says
 * exactly what is broken and how to fix it.
 *
 * Nothing else in the pipeline can run until this prints all green.
 */
import { existsSync, readFileSync } from 'node:fs';
import { getAccessToken, loadServiceAccount, SHEETS_SCOPE } from '../export/google-auth.ts';
import { PROBE_FIELD_MASK } from '../places/field-mask.ts';

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let failures = 0;

function pass(label: string, detail: string): void {
  console.log(`  \x1b[32mOK\x1b[0m   ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string, fix: string): void {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  for (const line of fix.split('\n')) console.log(`       ${line}`);
}

function skip(label: string, why: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${label} — ${why}`);
}

/**
 * The column names apps-script/Code.gs declares, read from the file itself.
 *
 * A Web App deployment is a snapshot of the code as it stood when it was
 * deployed, so the repo and the live app drift apart silently every time a
 * column is added and nobody redeploys. Reading the source here means this
 * check can never itself be the thing that is out of date.
 *
 * Returns [] rather than throwing if the shape ever changes — a check that
 * cannot read its own reference should skip, not fail the run.
 */
function declaredColumns(): string[] {
  try {
    const source = readFileSync('apps-script/Code.gs', 'utf8');
    const block = /const COLUMNS = \[([\s\S]*?)\];/.exec(source);
    if (!block?.[1]) return [];
    return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- env
console.log('\nEnvironment');

if (!existsSync('.env')) {
  fail('.env', 'not found', 'Copy .env.example to .env, then paste your key into GOOGLE_MAPS_API_KEY=');
} else {
  process.loadEnvFile('.env');
  pass('.env', 'loaded');
}

const mapsKey = process.env['GOOGLE_MAPS_API_KEY']?.trim() ?? '';
const sheetId = process.env['GOOGLE_SHEETS_SPREADSHEET_ID']?.trim() ?? '';
const keyFile = process.env['GOOGLE_SERVICE_ACCOUNT_KEY_FILE']?.trim() ?? './rekreate-service-account.json';

// ------------------------------------------------------------- places
console.log('\nGoogle Maps — Places API (New)');

if (!mapsKey) {
  fail('API key', 'GOOGLE_MAPS_API_KEY is empty', 'console.cloud.google.com > APIs & Services > Credentials > Create credentials > API key');
} else {
  pass('API key', `present (${mapsKey.slice(0, 10)}…)`);

  const res = await fetch(PLACES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': mapsKey,
      // Named, not inline: every field mask in this project lives in
      // field-mask.ts, because a mask written at its call site is a price
      // change nobody reviews. This one is Essentials-tier on purpose.
      'X-Goog-FieldMask': PROBE_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: 'property management company',
      locationRestriction: {
        rectangle: {
          low: { latitude: 39.867, longitude: -75.28 },
          high: { latitude: 40.138, longitude: -74.956 },
        },
      },
      pageSize: 1,
      regionCode: 'US',
      languageCode: 'en',
    }),
  });

  const text = await res.text();
  if (res.ok) {
    const found = (JSON.parse(text) as { places?: unknown[] }).places?.length ?? 0;
    pass('live search', `HTTP 200, ${found} result(s) returned`);
  } else if (text.includes('API_KEY_SERVICE_BLOCKED') || text.includes('SERVICE_DISABLED')) {
    fail('live search', `HTTP ${res.status} — the API is not enabled, or the key excludes it`,
      'Two separate things to check:\n' +
      '1. Enable it: console.cloud.google.com/apis/library/places.googleapis.com\n' +
      '2. Un-restrict it: Credentials > your key > API restrictions > add "Places API (New)"');
  } else if (text.includes('BILLING') || text.includes('billing')) {
    fail('live search', `HTTP ${res.status} — billing is not attached to this project`,
      'console.cloud.google.com/billing — link a billing account to THIS project.\n' +
      'You stay inside the free tier at our volume, but Google will not issue quota without a card on file.');
  } else if (res.status === 429) {
    // The 429 body names the exact limit and its value in details[].metadata.
    // Reading it turns "the sweep died early" into a number you can act on: a
    // cap in the low hundreds is what an unbilled project gets, not evidence
    // that the engine is misbehaving.
    let meta: Record<string, string> | undefined;
    try {
      const parsed = JSON.parse(text) as {
        error?: { details?: { metadata?: Record<string, string> }[] };
      };
      meta = parsed.error?.details?.find((d) => d.metadata?.['quota_limit_value'])?.metadata;
    } catch {
      meta = undefined;
    }
    const cap = meta?.['quota_limit_value'];
    const limitName = meta?.['quota_limit'];
    fail(
      'live search',
      `HTTP 429 — the daily Places quota is spent${cap ? `, and the cap is only ${cap}/day` : ''}`,
      `${limitName ? `Limit: ${limitName}\n` : ''}` +
        'It resets at midnight US Pacific. A cap in the low hundreds means no billing\n' +
        'account is attached — Google caps an unbilled project hard however little you use.\n' +
        'Fix: console.cloud.google.com/billing — link an account to THIS project, then\n' +
        'raise it at console.cloud.google.com/apis/api/places.googleapis.com/quotas',
    );
  } else if (res.status === 400 && text.includes('API key not valid')) {
    fail('live search', 'the key itself is rejected', 'It may have been deleted or regenerated. Copy the current value from Credentials.');
  } else {
    fail('live search', `HTTP ${res.status}`, text.slice(0, 300));
  }
}

// ------------------------------------------------------------- sheets
console.log('\nGoogle Sheets — service account (optional)');

if (!sheetId) {
  fail('spreadsheet id', 'GOOGLE_SHEETS_SPREADSHEET_ID is empty', 'It is the part of the sheet URL between /d/ and /edit');
} else if (!existsSync(keyFile)) {
  // Optional, and deliberately not a failure. Leads reach the sheet through the
  // Apps Script Web App checked below - that is the only writer in the pipeline,
  // and loadServiceAccount is called from nowhere else in src/. A red FAIL here
  // for an unused credential buries the blockers that actually stop work.
  skip('service account', `no key at ${keyFile} - the Apps Script Web App below is what writes leads`);
} else {
  let token = '';
  try {
    const account = await loadServiceAccount(keyFile);
    pass('key file', account.client_email);
    token = await getAccessToken(account, SHEETS_SCOPE);
    pass('token exchange', 'access token issued');
  } catch (err) {
    fail('token exchange', err instanceof Error ? err.message.slice(0, 300) : String(err),
      'If this mentions invalid_grant, the key was deleted in the console. Create a new JSON key.');
  }

  if (token) {
    const auth = { Authorization: `Bearer ${token}` };

    const read = await fetch(`${SHEETS_BASE}/${sheetId}?fields=properties.title`, { headers: auth });
    if (read.ok) {
      const title = (JSON.parse(await read.text()) as { properties?: { title?: string } }).properties?.title;
      pass('sheet visible', `"${title ?? 'untitled'}"`);
    } else {
      const account = await loadServiceAccount(keyFile);
      fail('sheet visible', `HTTP ${read.status} — the service account cannot see the sheet`,
        `Open the spreadsheet > Share > add this address as EDITOR:\n${account.client_email}`);
    }

    // Prove Editor, not just Viewer. Creating and removing a throwaway tab
    // cannot touch existing data, unlike writing into a cell.
    if (read.ok) {
      const add = await fetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: '_rekreate_verify' } } }] }),
      });

      if (add.ok) {
        const created = JSON.parse(await add.text()) as {
          replies?: { addSheet?: { properties?: { sheetId?: number } } }[];
        };
        const tabId = created.replies?.[0]?.addSheet?.properties?.sheetId;
        pass('write access', 'created and removed a test tab');
        if (typeof tabId === 'number') {
          await fetch(`${SHEETS_BASE}/${sheetId}:batchUpdate`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: tabId } }] }),
          });
        }
      } else {
        fail('write access', `HTTP ${add.status} — shared, but read-only`,
          'Re-share the sheet with the service account as EDITOR rather than Viewer.');
      }
    }
  }
}

// ------------------------------------------------- sheets, via the apps script
console.log('\nGoogle Sheets — Apps Script Web App (the path that writes leads)');

const webappUrl = process.env['SHEETS_WEBAPP_URL']?.trim() ?? '';
const webappToken = process.env['SHEETS_INGEST_TOKEN']?.trim() ?? '';

if (!webappUrl || !webappToken) {
  skip('web app', 'SHEETS_WEBAPP_URL and SHEETS_INGEST_TOKEN are not both set in .env');
} else {
  // Google serves an HTML sign-in interstitial here for two different reasons:
  // a deployment that genuinely requires sign-in, and a momentary hiccup under
  // back-to-back requests. They are indistinguishable from the body, so only a
  // failure that survives every attempt gets blamed on configuration — the same
  // rule pushLeads follows.
  type Health = { authorised?: boolean; leads?: number; columns?: string[] };
  const ATTEMPTS = 3;
  let health: Health | null = null;
  let lastBody = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const probe = await fetch(`${webappUrl}?token=${encodeURIComponent(webappToken)}`, {
      redirect: 'follow',
    });
    lastBody = await probe.text();

    // An Apps Script web app answers HTTP 200 for everything, thrown errors
    // included, so the verdict lives in the body and never in the status code.
    try {
      health = JSON.parse(lastBody) as Health;
      break;
    } catch {
      health = null;
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  if (!health) {
    fail('web app', `no JSON after ${ATTEMPTS} attempts — ${lastBody.slice(0, 80).replace(/\s+/g, ' ')}`,
      'A sign-in page on every attempt means the deployment is not public.\n' +
      'Deploy > Manage deployments > pencil > Who has access: Anyone > Deploy.');
  } else if (health.authorised === false) {
    fail('ingest token', 'the web app rejected SHEETS_INGEST_TOKEN',
      'Apps Script editor > Project Settings > Script Properties > INGEST_TOKEN\n' +
      'must match SHEETS_INGEST_TOKEN in .env exactly.');
  } else {
    pass('web app', `reachable — ${health.leads ?? 0} lead(s) in the Leads tab`);

    // A deployment is a SNAPSHOT of the code as it stood when you deployed it.
    // Asking the live app which columns it knows about is the only way to tell
    // a redeploy that took from an editor save that did nothing.
    const deployed = health.columns;
    if (!deployed) {
      fail('deployed version', 'the live deployment is older than this check — it cannot report its columns',
        'Re-paste apps-script/Code.gs into the Apps Script editor, then\n' +
        'Deploy > Manage deployments > pencil > Version: NEW VERSION > Deploy.\n' +
        'Use Manage deployments, never New deployment, or the /exec URL changes.');
    } else {
      // Compared against the columns apps-script/Code.gs declares RIGHT NOW,
      // rather than a list written out here. The hardcoded pair went stale the
      // first time a column was added: the check kept passing while the live
      // deployment sat three columns behind the repo, which is precisely the
      // drift it exists to catch.
      const expected = declaredColumns();
      const missing = expected.filter((c) => !deployed.includes(c));
      if (expected.length === 0) {
        skip('deployed version', 'could not read COLUMNS out of apps-script/Code.gs');
      } else if (missing.length > 0) {
        fail('deployed version', `live, but ${missing.length} column(s) behind the repo: ${missing.join(', ')}`,
          'A deployment is a SNAPSHOT of the code as it stood when you deployed it,\n' +
          'so saving in the editor changes nothing on its own.\n' +
          'Apps Script editor > paste apps-script/Code.gs over Code.gs > save, then\n' +
          'Deploy > Manage deployments > pencil > Version: NEW VERSION > Deploy.\n' +
          'Use Manage deployments, never New deployment, or the /exec URL changes.');
      } else {
        pass('deployed version', `${deployed.length} columns — up to date with apps-script/Code.gs`);
      }
    }
  }
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll checks passed.\x1b[0m The pipeline can run.\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m Fix the above, then run npm run verify again.\n`,
);

process.exitCode = failures === 0 ? 0 : 1;

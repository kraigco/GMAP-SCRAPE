/**
 * `npm run verify` — checks every credential this project needs and says
 * exactly what is broken and how to fix it.
 *
 * Nothing else in the pipeline can run until this prints all green.
 */
import { existsSync } from 'node:fs';
import { getAccessToken, loadServiceAccount, SHEETS_SCOPE } from '../export/google-auth.ts';

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
      'X-Goog-FieldMask': 'places.id,places.displayName',
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
  } else if (res.status === 400 && text.includes('API key not valid')) {
    fail('live search', 'the key itself is rejected', 'It may have been deleted or regenerated. Copy the current value from Credentials.');
  } else {
    fail('live search', `HTTP ${res.status}`, text.slice(0, 300));
  }
}

// ------------------------------------------------------------- sheets
console.log('\nGoogle Sheets — service account');

if (!sheetId) {
  fail('spreadsheet id', 'GOOGLE_SHEETS_SPREADSHEET_ID is empty', 'It is the part of the sheet URL between /d/ and /edit');
} else if (!existsSync(keyFile)) {
  fail('key file', `not found at ${keyFile}`,
    'IAM & Admin > Service Accounts > Create service account (skip the roles step)\n' +
    'then open it > Keys > Add key > Create new key > JSON, and save it to that path.');
  skip('sheet access', 'no key file');
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

console.log(
  failures === 0
    ? '\n\x1b[32mAll checks passed.\x1b[0m The pipeline can run.\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m Fix the above, then run npm run verify again.\n`,
);

process.exitCode = failures === 0 ? 0 : 1;

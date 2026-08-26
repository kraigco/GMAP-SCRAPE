import { describe, expect, it } from 'vitest';
import {
  describeResult,
  isConfigured,
  pushLeads,
  toSheetLead,
} from '../src/export/sheets.ts';
import { toLead } from '../src/lead/signals.ts';
import type { SheetLead, SheetRun } from '../src/export/sheets.ts';
import type { RawPlace } from '../src/places/schema.ts';
import type { SiteAudit } from '../src/audit/site.ts';

/**
 * The push to the spreadsheet. It must never throw: by the time it runs, the
 * sweep has already been paid for in API calls and written to disk, so a sheet
 * that cannot be reached is something to report, not something to fail over.
 */

const PLACE: RawPlace = {
  id: 'ChIJ_test',
  displayName: { text: 'Otter Property Management' },
  formattedAddress: '12 Main St, Philadelphia, PA',
  nationalPhoneNumber: '(215) 555-0100',
  websiteUri: 'https://otter.test',
  rating: 4.6,
  userRatingCount: 73,
  businessStatus: 'OPERATIONAL',
  primaryType: 'real_estate_agency',
  location: { latitude: 39.95, longitude: -75.16 },
};

const AUDIT: SiteAudit = {
  placeId: 'ChIJ_test',
  inputUrl: 'https://otter.test',
  finalUrl: 'https://otter.test/',
  reachable: 'yes',
  https: 'yes',
  ttfbMs: 412,
  mobileViewport: 'no',
  contactForm: 'yes',
  emails: ['info@otter.test', 'leasing@otter.test'],
  pagesFetched: 1,
  httpStatus: 200,
  error: null,
  robotsBlocked: false,
};

const CONTEXT = {
  niche: 'property management',
  location: 'Philadelphia, PA',
  refreshedAt: '2026-08-27T09:00:00.000Z',
};

const RUN: SheetRun = {
  finishedAt: CONTEXT.refreshedAt,
  location: CONTEXT.location,
  niche: CONTEXT.niche,
  terms: ['property management company'],
  prospects: 1,
  withEmail: 1,
  tilesSearched: 4,
  tilesSplit: 0,
  callsUsed: 4,
  maxCalls: 200,
  estimatedCostUsd: 0.14,
  duplicatesDropped: 3,
  halted: false,
  aborted: false,
  file: 'out/searches/x.csv',
};

/** Stands in for the deployed Apps Script. */
function fakeScript(reply: unknown, opts: { status?: number; raw?: string } = {}) {
  const bodies: { token: string; leads: SheetLead[]; run: SheetRun | null }[] = [];
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
    return new Response(opts.raw ?? JSON.stringify(reply), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl: impl as unknown as typeof fetch, bodies };
}

/** `sleep` is stubbed out so the retry tests do not actually wait. */
const target = (impl: typeof fetch) => ({
  url: 'https://script.google.com/macros/s/AKfy/exec',
  token: 'secret',
  fetchImpl: impl,
  sleep: async (): Promise<void> => {},
});

describe('toSheetLead', () => {
  it('carries every field the script writes, plus the run context', () => {
    const row = toSheetLead(toLead(PLACE, AUDIT), CONTEXT);

    expect(row.id).toBe('ChIJ_test');
    expect(row.name).toBe('Otter Property Management');
    expect(row.email).toBe('info@otter.test');
    expect(row.emailAlt).toEqual(['leasing@otter.test']);
    expect(row.rating).toBe(4.6);
    expect(row.reviews).toBe(73);
    expect(row.businessStatus).toBe('OPERATIONAL');
    expect(row.lat).toBe(39.95);
    expect(row.finalUrl).toBe('https://otter.test/');
    expect(row.signals).toContain('no-viewport');

    // A Lead knows none of these — they belong to the run, not the prospect.
    expect(row.niche).toBe('property management');
    expect(row.searchLocation).toBe('Philadelphia, PA');
    expect(row.googleRefreshedAt).toBe('2026-08-27T09:00:00.000Z');
  });

  it('sends blanks, never nulls-as-text, for a bare place', () => {
    const row = toSheetLead(toLead({ id: 'bare' }, null), CONTEXT);
    expect(row.name).toBe('(unnamed)');
    expect(row.rating).toBeNull();
    expect(row.email).toBe('');
    expect(row.emailAlt).toEqual([]);
  });
});

describe('pushLeads', () => {
  it('sends the token, the leads and the run', async () => {
    const { impl, bodies } = fakeScript({ ok: true, inserted: 1, updated: 0, total: 1 });
    const lead = toSheetLead(toLead(PLACE, AUDIT), CONTEXT);

    const result = await pushLeads([lead], RUN, target(impl));

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.token).toBe('secret');
    expect(bodies[0]!.leads[0]!.id).toBe('ChIJ_test');
    expect(bodies[0]!.run?.callsUsed).toBe(4);
  });

  it('splits a large sweep into batches and records the run only once', async () => {
    const { impl, bodies } = fakeScript({ ok: true, inserted: 5, updated: 0, total: 5 });
    const leads = Array.from({ length: 12 }, (_, i) =>
      toSheetLead(toLead({ ...PLACE, id: `p${i}` }, null), CONTEXT),
    );

    const result = await pushLeads(leads, RUN, { ...target(impl), batchSize: 5 });

    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => b.leads.length)).toEqual([5, 5, 2]);
    // Exactly one run row, and only after the leads it describes are in.
    expect(bodies.filter((b) => b.run !== null)).toHaveLength(1);
    expect(bodies[2]!.run).not.toBeNull();
    expect(result.inserted).toBe(15);
  });

  it('reports a rejected token instead of throwing', async () => {
    const { impl } = fakeScript({ ok: false, error: 'bad token' });
    const result = await pushLeads([], RUN, target(impl));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad token');
  });

  it('retries a momentary interstitial and succeeds', async () => {
    // Apps Script serves a sign-in page under back-to-back requests even when
    // the deployment is public. Giving up on the first one aborts a backfill
    // that was working a second earlier.
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('<!DOCTYPE html><html><body>Sign in</body></html>', { status: 200 })
        : new Response(JSON.stringify({ ok: true, inserted: 2, updated: 0, total: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushLeads([], RUN, target(impl));

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(2);
    expect(calls).toBe(2);
  });

  it('blames the configuration only once every attempt has failed', async () => {
    const { impl } = fakeScript(null, { raw: '<!DOCTYPE html><html><body>Sign in</body></html>' });
    const result = await pushLeads([], RUN, { ...target(impl), maxRetries: 2 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('on every attempt');
    expect(result.error).toContain('Who has access');
  });

  it('retries an unreachable script, then reports it', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      throw new Error('getaddrinfo ENOTFOUND script.google.com');
    }) as unknown as typeof fetch;

    const result = await pushLeads([], RUN, { ...target(impl), maxRetries: 2 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not reach the Web App');
    expect(calls).toBe(3); // the first attempt plus two retries
  });

  it('does not retry a rejected token — that will never clear', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'bad token' }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pushLeads([], RUN, target(impl));

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('stops at the first failed batch rather than hammering on', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 200 });
    }) as unknown as typeof fetch;

    const leads = Array.from({ length: 12 }, (_, i) =>
      toSheetLead(toLead({ ...PLACE, id: `p${i}` }, null), CONTEXT),
    );
    const result = await pushLeads(leads, null, { ...target(impl), batchSize: 5 });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('refuses politely when the ingest is not configured', async () => {
    const result = await pushLeads([], RUN, { url: '', token: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('SHEETS_WEBAPP_URL');
  });
});

describe('isConfigured', () => {
  it('needs both settings, non-blank', () => {
    expect(isConfigured('https://x', 'tok')).toBe(true);
    expect(isConfigured('https://x', '')).toBe(false);
    expect(isConfigured(undefined, 'tok')).toBe(false);
    expect(isConfigured('  ', 'tok')).toBe(false);
  });
});

describe('describeResult', () => {
  it('summarises a write', () => {
    expect(describeResult({ ok: true, inserted: 3, updated: 7, total: 216, error: null }))
      .toBe('3 added, 7 updated, 216 in the sheet');
  });

  it('leads with the reason when it failed', () => {
    expect(describeResult({ ok: false, inserted: 0, updated: 0, total: null, error: 'bad token' }))
      .toBe('sheet not updated — bad token');
  });
});

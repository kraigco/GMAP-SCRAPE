import { describe, expect, it } from 'vitest';
import { fetchStoredLeads, rowToStoredLead } from '../src/export/sheets.ts';

/**
 * Reading the sheet back is where a silent corruption would live: map a row by
 * position and one inserted column shifts every later field, turning a phone
 * number into a rating with nothing to notice. So the mapping is by NAME, and
 * these tests are mostly about proving that holds when the sheet moves.
 */

const COLUMNS = [
  'place_id', 'first_listed', 'last_seen', 'name', 'address', 'phone', 'email',
  'email_alt', 'website', 'rating', 'reviews', 'signals', 'reachable', 'https',
  'ttfb_ms', 'mobile_viewport', 'contact_form', 'business_status', 'primary_type',
  'latitude', 'longitude', 'final_url', 'audit_error', 'niche', 'search_location',
  'google_refreshed_at', 'review_status', 'notes', 'hook', 'hook_basis',
];

const row = (over: Record<string, unknown> = {}): unknown[] => {
  const base: Record<string, unknown> = {
    place_id: 'p1',
    first_listed: '2026-08-26T05:41:00.000Z',
    last_seen: '2026-08-27T01:00:00.000Z',
    name: 'Otter Property',
    address: '12 Main St',
    phone: '+1 215 555 0100',
    email: 'info@otter.test',
    email_alt: 'sales@otter.test hi@otter.test',
    website: 'https://otter.test/leads',
    rating: 4.5,
    reviews: 31,
    signals: 'slow no-viewport',
    reachable: 'yes',
    https: 'yes',
    ttfb_ms: 2600,
    mobile_viewport: 'no',
    contact_form: 'yes',
    business_status: 'OPERATIONAL',
    primary_type: 'real_estate_agency',
    latitude: 39.95,
    longitude: -75.16,
    final_url: 'https://otter.test/',
    audit_error: '',
    niche: 'property-management',
    search_location: 'philadelphia-pa',
    google_refreshed_at: '2026-08-26T05:41:00.000Z',
    review_status: 'unreviewed',
    notes: '',
    hook: 'Your site was slow to respond…',
    hook_basis: 'slow',
    ...over,
  };
  return COLUMNS.map((c) => base[c] ?? '');
};

describe('rowToStoredLead', () => {
  it('maps a full row', () => {
    const lead = rowToStoredLead(COLUMNS, row())!;
    expect(lead.id).toBe('p1');
    expect(lead.name).toBe('Otter Property');
    expect(lead.rating).toBe(4.5);
    expect(lead.reviews).toBe(31);
    expect(lead.emailAlt).toEqual(['sales@otter.test', 'hi@otter.test']);
    expect(lead.signals).toEqual(['slow', 'no-viewport']);
    expect(lead.host).toBe('otter.test');
    expect(lead.collectedAt).toBe('2026-08-26T05:41:00.000Z');
    expect(lead.hookBasis).toBe('slow');
  });

  it('follows the header when a column is inserted, not the position', () => {
    // The failure this prevents is silent: positionally, everything after the
    // new column shifts one place and a phone number renders as a rating.
    const shifted = ['place_id', 'inserted_by_hand', ...COLUMNS.slice(1)];
    const values = row();
    const withExtra = [values[0], 'junk', ...values.slice(1)];

    const lead = rowToStoredLead(shifted, withExtra)!;
    expect(lead.name).toBe('Otter Property');
    expect(lead.rating).toBe(4.5);
    expect(lead.phone).toBe('+1 215 555 0100');
  });

  it('leaves a missing column empty rather than guessing', () => {
    const without = COLUMNS.filter((c) => c !== 'hook');
    const values = without.map((c) => (c === 'place_id' ? 'p1' : c === 'name' ? 'Otter' : ''));
    const lead = rowToStoredLead(without, values)!;
    expect(lead.hook).toBe('');
    expect(lead.name).toBe('Otter');
  });

  it('drops a row with no place_id', () => {
    // Rendering it would put a line in the table that nothing could address.
    expect(rowToStoredLead(COLUMNS, row({ place_id: '' }))).toBeNull();
  });

  it('reads a blank number as null rather than zero', () => {
    // 0 stars is a claim; blank is an absence, and the table must show a dash.
    const lead = rowToStoredLead(COLUMNS, row({ rating: '', reviews: '', ttfb_ms: '' }))!;
    expect(lead.rating).toBeNull();
    expect(lead.reviews).toBeNull();
    expect(lead.ttfb).toBeNull();
  });

  it('treats a row the audit never touched as unaudited', () => {
    const lead = rowToStoredLead(COLUMNS, row({ reachable: '' }))!;
    expect(lead.audited).toBe(false);
  });

  it('counts a row as audited once reachability was measured', () => {
    expect(rowToStoredLead(COLUMNS, row({ reachable: 'no' }))!.audited).toBe(true);
  });

  it('handles an empty signals cell without inventing one', () => {
    expect(rowToStoredLead(COLUMNS, row({ signals: '' }))!.signals).toEqual([]);
  });
});

describe('fetchStoredLeads', () => {
  const target = (impl: typeof fetch) => ({ url: 'https://x.test/exec', token: 't', fetchImpl: impl });
  const respond = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it('returns mapped leads and the sheet total', async () => {
    const result = await fetchStoredLeads(
      target(respond({ ok: true, columns: COLUMNS, rows: [row(), row({ place_id: 'p2' })], total: 326 })),
    );
    expect(result.ok).toBe(true);
    expect(result.leads.map((l) => l.id)).toEqual(['p1', 'p2']);
    expect(result.total).toBe(326);
  });

  it('names the redeploy when the deployment predates this endpoint', async () => {
    // An older deployment answers the health shape and ignores action=leads.
    const result = await fetchStoredLeads(target(respond({ ok: true, leads: 326 })));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redeploy/i);
  });

  it('reports a rejected token rather than an empty sheet', async () => {
    const result = await fetchStoredLeads(target(respond({ ok: true, authorised: false })));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token/i);
  });

  it('recognises the sign-in page for what it is', async () => {
    const html = (async () =>
      new Response('<!DOCTYPE html><html>sign in</html>', { status: 200 })) as unknown as typeof fetch;
    const result = await fetchStoredLeads(target(html));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/page/i);
  });

  it('never throws when the network does', async () => {
    // The dashboard must still load; an empty table beats a dead page.
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await fetchStoredLeads(target(boom));
    expect(result.ok).toBe(false);
    expect(result.leads).toEqual([]);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('says so when it was never configured', async () => {
    const result = await fetchStoredLeads({ url: '', token: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SHEETS_WEBAPP_URL/);
  });
});

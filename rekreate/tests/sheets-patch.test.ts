import { describe, expect, it, vi } from 'vitest';
import { patchLeads } from '../src/export/sheets.ts';

/**
 * Patching exists because the upsert cannot correct one field without lying.
 *
 * `pushLeads` rewrites every column a scrape owns — `last_seen` and
 * `google_refreshed_at` included — so clearing a single dead email through it
 * would stamp both timestamps and record a Google refresh that never happened.
 * That timestamp is what the 30-day cache rule is measured from, so the
 * convenience would have quietly falsified a compliance field.
 *
 * The other thing under test is the Web App's oldest trap: it answers HTTP 200
 * to everything, a sign-in interstitial included. Status codes prove nothing
 * here; only the body does.
 */

const TARGET = { url: 'https://script.google.com/macros/s/x/exec', token: 'tok' };

const reply = (body: unknown, text?: string) =>
  vi.fn(async () => ({
    text: async () => text ?? JSON.stringify(body),
  })) as unknown as typeof fetch;

describe('patchLeads', () => {
  it('sends the patch action, so an old deployment cannot mistake it for an ingest', async () => {
    const calls: string[] = [];
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return { text: async () => JSON.stringify({ ok: true, applied: [], changed: 0 }) };
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', spy);

    await patchLeads([{ placeId: 'p1', column: 'email', value: '' }], TARGET);

    const sent = JSON.parse(calls[0]!);
    expect(sent.action).toBe('patch');
    expect(sent.token).toBe('tok');
    expect(sent.patches).toEqual([{ placeId: 'p1', column: 'email', value: '' }]);
    // Nothing resembling a lead payload: an ingest would rewrite the timestamps.
    expect(sent.leads).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('reports which cells actually changed, not just that the call worked', async () => {
    vi.stubGlobal('fetch', reply({
      ok: true,
      changed: 1,
      applied: [
        { placeId: 'p1', column: 'email', before: 'dead@x.com', after: '', changed: true },
        { placeId: 'p2', column: 'email', before: '', after: '', changed: false },
      ],
    }));
    const result = await patchLeads(
      [
        { placeId: 'p1', column: 'email', value: '' },
        { placeId: 'p2', column: 'email', value: '' },
      ],
      TARGET,
    );
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(1);
    expect(result.applied[1]?.changed).toBe(false);
    vi.unstubAllGlobals();
  });

  it('treats an HTML body as a failure even though the status is 200', async () => {
    // The sign-in interstitial and a stale deployment both look like this.
    vi.stubGlobal('fetch', reply(null, '<!DOCTYPE html><html>Sign in</html>'));
    const result = await patchLeads([{ placeId: 'p1', column: 'email', value: '' }], TARGET);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTML/i);
    vi.unstubAllGlobals();
  });

  it('surfaces the Web App’s own rejection rather than inventing one', async () => {
    vi.stubGlobal('fetch', reply({ ok: false, error: 'patch 0: no lead with place_id p9' }));
    const result = await patchLeads([{ placeId: 'p9', column: 'email', value: '' }], TARGET);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('p9');
    vi.unstubAllGlobals();
  });

  it('does not call the network for an empty batch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await patchLeads([], TARGET);
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refuses when the sheet is not configured', async () => {
    const result = await patchLeads([{ placeId: 'p1', column: 'email', value: '' }], {
      url: '',
      token: '',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SHEETS_WEBAPP_URL/);
  });
});

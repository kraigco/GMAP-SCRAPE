import { describe, expect, it, vi } from 'vitest';
import type { BBox } from '../src/lib/bbox.ts';
import { createPlacesClient } from '../src/places/client.ts';
import { PLACES_FIELD_MASK_HEADER, estimateCostUsd } from '../src/places/field-mask.ts';

const PHILLY: BBox = { swLat: 39.867, swLng: -75.28, neLat: 40.138, neLng: -74.956 };
const noSleep = async (): Promise<void> => {};

function place(id: string): Record<string, unknown> {
  return { id, displayName: { text: 'Firm ' + id } };
}

/** Responds with a scripted sequence, one entry per call. */
function scriptedFetch(pages: { status?: number; body: unknown }[]) {
  const calls: { headers: Headers; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const idx = calls.length;
    calls.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const page = pages[Math.min(idx, pages.length - 1)]!;
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('places client — request shape', () => {
  it('sends the frozen mask as a header, and the rectangle as SW/NE corners', async () => {
    const { impl, calls } = scriptedFetch([{ body: { places: [place('a')] } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 10, fetchImpl: impl, sleep: noSleep });

    await client.searchTile('property management company', PHILLY);

    const sent = calls[0]!;
    expect(sent.headers.get('X-Goog-FieldMask')).toBe(PLACES_FIELD_MASK_HEADER);
    expect(sent.headers.get('X-Goog-Api-Key')).toBe('k');
    expect(sent.body['locationRestriction']).toEqual({
      rectangle: {
        low: { latitude: 39.867, longitude: -75.28 },
        high: { latitude: 40.138, longitude: -74.956 },
      },
    });
    // The mask must never travel in the body — Google ignores it there and
    // quietly returns the default field set instead of erroring.
    expect(sent.body).not.toHaveProperty('fieldMask');
  });
});

describe('places client — budget (constraint 6)', () => {
  it('never issues more requests than maxCalls', async () => {
    const { impl, calls } = scriptedFetch([{ body: { places: [place('a')], nextPageToken: 't' } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 2, fetchImpl: impl, sleep: noSleep });

    await client.searchTile('q', PHILLY);
    await client.searchTile('q', PHILLY);
    await client.searchTile('q', PHILLY);

    expect(calls).toHaveLength(2);
    expect(client.callsUsed()).toBe(2);
    expect(client.budgetExhausted()).toBe(true);
    expect(client.budgetRemaining()).toBe(0);
  });

  it('marks a tile truncated when the budget runs out mid-pagination', async () => {
    const { impl } = scriptedFetch([{ body: { places: [place('a')], nextPageToken: 't' } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 1, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.pagesFetched).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.places.map((p) => p.id)).toEqual(['a']);
  });

  it('issues nothing at all with a zero budget', async () => {
    const { impl, calls } = scriptedFetch([{ body: { places: [] } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 0, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(calls).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });
});

describe('places client — pagination', () => {
  it('stops at three pages and flags the tile as truncated', async () => {
    const { impl, calls } = scriptedFetch([
      { body: { places: [place('a')], nextPageToken: 't1' } },
      { body: { places: [place('b')], nextPageToken: 't2' } },
      { body: { places: [place('c')], nextPageToken: 't3' } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(calls).toHaveLength(3);
    expect(result.pagesFetched).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.places.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(calls[1]?.body['pageToken']).toBe('t1');
    expect(calls[2]?.body['pageToken']).toBe('t2');
  });

  it('stops early and reports complete when there is no next token', async () => {
    const { impl } = scriptedFetch([{ body: { places: [place('a'), place('b')] } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.pagesFetched).toBe(1);
    expect(result.truncated).toBe(false);
  });
});

describe('places client — failures', () => {
  it('retries a 429 and then succeeds', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 429, body: { error: { message: 'rate limited' } } },
      { body: { places: [place('a')] } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 10, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(calls).toHaveLength(2);
    expect(result.places.map((p) => p.id)).toEqual(['a']);
    expect(client.callsUsed()).toBe(2);
  });

  it('fails loudly on a permission error rather than returning nothing', async () => {
    const { impl } = scriptedFetch([
      { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'API_KEY_SERVICE_BLOCKED' } } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 10, fetchImpl: impl, sleep: noSleep });

    await expect(client.searchTile('q', PHILLY)).rejects.toThrow(/HTTP 403/);
  });

  it('gives up after maxRetries instead of looping forever', async () => {
    const { impl, calls } = scriptedFetch([{ status: 503, body: { error: 'unavailable' } }]);
    const client = createPlacesClient({
      apiKey: 'k',
      maxCalls: 50,
      fetchImpl: impl,
      sleep: noSleep,
      maxRetries: 2,
    });

    await expect(client.searchTile('q', PHILLY)).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(3);
  });

  it('keeps the good places in a page containing one malformed entry', async () => {
    const { impl } = scriptedFetch([
      { body: { places: [place('a'), { id: 'b', businessStatus: 'VAPORISED' }, place('c')] } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 10, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.places.map((p) => p.id)).toEqual(['a', 'c']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.error).toMatch(/businessStatus/);
  });

  it('accepts a place with none of the optional fields', async () => {
    const { impl } = scriptedFetch([{ body: { places: [{ id: 'bare' }] } }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 10, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.rejected).toHaveLength(0);
    expect(result.places[0]?.id).toBe('bare');
  });
});

describe('cost estimate', () => {
  it('prices a sweep at the Enterprise rate', () => {
    expect(estimateCostUsd(200)).toBeCloseTo(7.0);
    expect(estimateCostUsd(0)).toBe(0);
  });
});

describe('places client — the 60-result ceiling', () => {
  it('treats a full 60 with no token as truncated', async () => {
    const full = (n: number, token?: string) => ({
      body: {
        places: Array.from({ length: n }, (_, i) => place('p' + i)),
        ...(token ? { nextPageToken: token } : {}),
      },
    });
    const { impl } = scriptedFetch([full(20, 't1'), full(20, 't2'), full(20)]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.rawReturned).toBe(60);
    expect(result.truncated).toBe(true);
  });

  it('treats 59 as a complete answer', async () => {
    const { impl } = scriptedFetch([
      { body: { places: Array.from({ length: 20 }, (_, i) => place('a' + i)), nextPageToken: 't1' } },
      { body: { places: Array.from({ length: 20 }, (_, i) => place('b' + i)), nextPageToken: 't2' } },
      { body: { places: Array.from({ length: 19 }, (_, i) => place('c' + i)) } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);

    expect(result.rawReturned).toBe(59);
    expect(result.truncated).toBe(false);
  });
});

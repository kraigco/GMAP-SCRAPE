import { describe, expect, it, vi } from 'vitest';
import type { BBox } from '../src/lib/bbox.ts';
import {
  classifyQuotaError,
  createPlacesClient,
  PlacesQuotaError,
  quotaLimitName,
} from '../src/places/client.ts';

const PHILLY: BBox = { swLat: 39.867, swLng: -75.28, neLat: 40.138, neLng: -74.956 };
const noSleep = async (): Promise<void> => {};

/** The exact shape Google returned when the daily allowance ran out. */
const DAILY_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'SearchTextRequest' and limit 'SearchTextRequest per day' " +
      "of service 'places.googleapis.com' for consumer 'project_number:207856227040'.",
    status: 'RESOURCE_EXHAUSTED',
  },
});

const PER_MINUTE_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'SearchTextRequest' and limit 'SearchTextRequest per minute' " +
      "of service 'places.googleapis.com'.",
    status: 'RESOURCE_EXHAUSTED',
  },
});

function scripted(pages: { status?: number; body: string | object }[]) {
  const calls: number[] = [];
  const impl = vi.fn(async () => {
    const page = pages[Math.min(calls.length, pages.length - 1)]!;
    calls.push(1);
    const body = typeof page.body === 'string' ? page.body : JSON.stringify(page.body);
    return new Response(body, { status: page.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('classifyQuotaError', () => {
  it('recognises a per-day limit', () => {
    expect(classifyQuotaError(DAILY_BODY)).toBe('daily');
  });

  it('recognises a per-minute limit', () => {
    expect(classifyQuotaError(PER_MINUTE_BODY)).toBe('rate');
  });

  it('returns null for a body that is not about quota', () => {
    expect(classifyQuotaError('{"error":{"message":"API key not valid"}}')).toBeNull();
  });

  it('returns null for a quota error it cannot place, so the caller may retry', () => {
    expect(classifyQuotaError('{"error":{"status":"RESOURCE_EXHAUSTED"}}')).toBeNull();
  });

  it('extracts the limit name for the message', () => {
    expect(quotaLimitName(DAILY_BODY)).toBe('SearchTextRequest per day');
    expect(quotaLimitName('no limit here')).toBeNull();
  });
});

describe('daily quota — must not retry', () => {
  it('issues exactly one request and stops', async () => {
    const { impl, calls } = scripted([{ status: 429, body: DAILY_BODY }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    await expect(client.searchTile('q', PHILLY)).rejects.toThrow(PlacesQuotaError);
    expect(calls).toHaveLength(1);
    expect(client.callsUsed()).toBe(1);
  });

  it('carries kind "daily" and the limit name', async () => {
    const { impl } = scripted([{ status: 429, body: DAILY_BODY }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const err = await client.searchTile('q', PHILLY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesQuotaError);
    const quota = err as PlacesQuotaError;
    expect(quota.kind).toBe('daily');
    expect(quota.limitName).toBe('SearchTextRequest per day');
    expect(quota.status).toBe(429);
  });

  it('explains the situation instead of dumping Google JSON', async () => {
    const { impl } = scripted([{ status: 429, body: DAILY_BODY }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const err = (await client.searchTile('q', PHILLY).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/daily quota/i);
    expect(err.message).toMatch(/midnight US Pacific/);
    expect(err.message).toMatch(/Nothing was charged/);
    expect(err.message).not.toMatch(/RESOURCE_EXHAUSTED/);
  });

  it('never sleeps — there is nothing to wait for', async () => {
    const sleep = vi.fn(async () => {});
    const { impl } = scripted([{ status: 429, body: DAILY_BODY }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep });

    await client.searchTile('q', PHILLY).catch(() => {});
    expect(sleep).not.toHaveBeenCalled();
  });

  it('leaves the remaining budget unspent for the next day', async () => {
    const { impl } = scripted([{ status: 429, body: DAILY_BODY }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 200, fetchImpl: impl, sleep: noSleep });

    await client.searchTile('q', PHILLY).catch(() => {});
    expect(client.budgetRemaining()).toBe(199);
  });
});

describe('per-minute limit — still retries', () => {
  it('backs off and succeeds when the limit clears', async () => {
    const { impl, calls } = scripted([
      { status: 429, body: PER_MINUTE_BODY },
      { body: { places: [{ id: 'a' }] } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);
    expect(calls).toHaveLength(2);
    expect(result.places.map((p) => p.id)).toEqual(['a']);
  });

  it('reports kind "rate" once the retries are used up', async () => {
    const { impl, calls } = scripted([{ status: 429, body: PER_MINUTE_BODY }]);
    const client = createPlacesClient({
      apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep, maxRetries: 2,
    });

    const err = (await client.searchTile('q', PHILLY).catch((e: unknown) => e)) as PlacesQuotaError;
    expect(calls).toHaveLength(3);
    expect(err).toBeInstanceOf(PlacesQuotaError);
    expect(err.kind).toBe('rate');
    expect(err.message).toMatch(/rate-limiting/);
  });

  it('an unclassifiable 429 is still retried', async () => {
    const { impl, calls } = scripted([
      { status: 429, body: '{"error":{"message":"slow down"}}' },
      { body: { places: [{ id: 'b' }] } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const result = await client.searchTile('q', PHILLY);
    expect(calls).toHaveLength(2);
    expect(result.places.map((p) => p.id)).toEqual(['b']);
  });
});

describe('other failures are unchanged', () => {
  it('a 403 still throws a plain error, not a quota error', async () => {
    const { impl } = scripted([{ status: 403, body: '{"error":{"status":"PERMISSION_DENIED"}}' }]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    const err = (await client.searchTile('q', PHILLY).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(PlacesQuotaError);
    expect(err.message).toMatch(/HTTP 403/);
  });

  it('a 500 still retries', async () => {
    const { impl, calls } = scripted([
      { status: 500, body: 'boom' },
      { body: { places: [{ id: 'c' }] } },
    ]);
    const client = createPlacesClient({ apiKey: 'k', maxCalls: 50, fetchImpl: impl, sleep: noSleep });

    await client.searchTile('q', PHILLY);
    expect(calls).toHaveLength(2);
  });
});

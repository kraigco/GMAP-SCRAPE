import { describe, expect, it } from 'vitest';
import { runSearch } from '../src/server/search.ts';

/**
 * The term limit.
 *
 * Every phrasing of a niche is a separate full sweep of the box, so the term
 * count multiplies what a search costs more directly than anything else in the
 * UI. It is a coverage decision though, not a tuning knob, which is why the
 * result reports how many phrasings existed as well as how many were used —
 * a partial sweep must never be presentable as a whole one.
 */

const LOCATION = {
  places: [
    {
      id: 'loc1',
      displayName: { text: 'Testville' },
      formattedAddress: 'Testville, TS',
      viewport: {
        low: { latitude: 39.0, longitude: -75.0 },
        high: { latitude: 40.0, longitude: -74.0 },
      },
    },
  ],
};

function harness(): { impl: typeof fetch; tiles: string[] } {
  const tiles: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('places:searchText')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body['locationRestriction']) {
        return new Response(JSON.stringify(LOCATION), { status: 200 });
      }
      tiles.push(String(body['textQuery']));
      return new Response(
        JSON.stringify({ places: [{ id: `p${tiles.length}`, displayName: { text: 'Firm' } }] }),
        { status: 200 },
      );
    }
    return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return { impl: impl as unknown as typeof fetch, tiles };
}

const base = {
  location: 'Testville',
  niche: 'dentist',
  maxCalls: 50,
  maxDepth: 0,
  audit: false,
};

describe('maxTerms', () => {
  it('sweeps every phrasing when it is not set — the behaviour that came before', async () => {
    const h = harness();
    const result = await runSearch(base, { apiKey: 'k', fetchImpl: h.impl });

    expect(h.tiles).toHaveLength(4);
    expect(result.run.terms).toHaveLength(4);
    expect(result.run.termsAvailable).toBe(4);
  });

  it('cuts the calls in direct proportion', async () => {
    for (const [limit, expected] of [[1, 1], [2, 2], [3, 3]] as const) {
      const h = harness();
      const result = await runSearch({ ...base, maxTerms: limit }, { apiKey: 'k', fetchImpl: h.impl });

      expect(h.tiles).toHaveLength(expected);
      expect(result.run.callsUsed).toBe(expected);
      expect(result.run.terms).toHaveLength(expected);
    }
  });

  it('keeps the first phrasings, which are the most direct ones', async () => {
    const h = harness();
    await runSearch({ ...base, maxTerms: 2 }, { apiKey: 'k', fetchImpl: h.impl });
    expect(h.tiles).toEqual(['dentist', 'dentist company']);
  });

  it('always reports what it did NOT search', async () => {
    const h = harness();
    const result = await runSearch({ ...base, maxTerms: 1 }, { apiKey: 'k', fetchImpl: h.impl });

    // The pair is what makes an incomplete sweep legible: one used, four available.
    expect(result.run.terms).toHaveLength(1);
    expect(result.run.termsAvailable).toBe(4);
  });

  it('ignores a limit wider than the niche has phrasings', async () => {
    const h = harness();
    const result = await runSearch({ ...base, maxTerms: 99 }, { apiKey: 'k', fetchImpl: h.impl });

    expect(h.tiles).toHaveLength(4);
    expect(result.run.termsAvailable).toBe(4);
  });

  it('treats zero and nonsense as "no limit" rather than searching nothing', async () => {
    for (const limit of [0, -1, Number.NaN]) {
      const h = harness();
      const result = await runSearch({ ...base, maxTerms: limit }, { apiKey: 'k', fetchImpl: h.impl });
      expect(result.run.terms).toHaveLength(4);
    }
  });

  it('applies to a saved niche, which carries eight phrasings', async () => {
    const h = harness();
    const result = await runSearch(
      { ...base, niche: 'property-management', maxTerms: 2 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(h.tiles).toHaveLength(2);
    expect(result.run.termsAvailable).toBe(8);
    // The saving is the point: two calls instead of eight.
    expect(result.run.callsUsed).toBe(2);
  });
});

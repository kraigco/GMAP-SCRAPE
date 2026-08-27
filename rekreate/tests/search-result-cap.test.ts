import { describe, expect, it } from 'vitest';
import { runSearch } from '../src/server/search.ts';

/**
 * The sweep must stop at a business count, not just at a call budget.
 *
 * `maxCalls` was the only ceiling the engine had, and it is the wrong unit to
 * hand a person: nobody wants "90 API calls", they want "100 businesses". Worse,
 * its default was 200 while Google caps an unbilled project at 100 SearchText
 * calls a day — so the engine planned a sweep the API cut off partway, and the
 * run reported budget remaining while the wall it actually hit was invisible.
 *
 * These tests count the tile requests actually issued, because that is the thing
 * that costs money. A cap that trims the output but still pays for every call is
 * not a cap.
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Every tile returns `perTile` distinct businesses, so the collected count
 * climbs predictably and the cap has something to bite on. Ids are globally
 * unique across tiles: this measures the cap, not the deduper.
 */
function harness(perTile: number) {
  const tiles: string[] = [];
  let issued = 0;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes('places:searchText')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!body['locationRestriction']) return json(LOCATION);

      tiles.push(String(body['textQuery']));
      const places = Array.from({ length: perTile }, () => {
        issued += 1;
        return {
          id: `p${issued}`,
          displayName: { text: `Firm ${issued}` },
          formattedAddress: `${issued} Main St`,
        };
      });
      return json({ places });
    }

    return new Response('<html><body>hello</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  return { impl: impl as unknown as typeof fetch, tiles };
}

// audit: false keeps these tests about the sweep. maxDepth 0 means one tile per
// term, so tile count equals term count and the arithmetic stays checkable.
const base = { location: 'Testville', niche: 'dentist', maxCalls: 50, maxDepth: 0, audit: false };

describe('runSearch — the business cap', () => {
  it('stops issuing calls once the cap is reached', async () => {
    // 20 per tile, cap 25: the second tile crosses it, so a third must never go out.
    const h = harness(20);
    const result = await runSearch(
      { ...base, maxResults: 25 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(h.tiles).toHaveLength(2);
    expect(result.run.callsUsed).toBe(2);
    expect(result.run.resultCapReached).toBe(true);
  });

  it('returns exactly the number asked for, not the tile overshoot', async () => {
    // A tile is atomic — 40 were paid for, but 25 is what was requested.
    const h = harness(20);
    const result = await runSearch(
      { ...base, maxResults: 25 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(result.leads).toHaveLength(25);
    expect(result.run.maxResults).toBe(25);
  });

  it('reports the run as capped so a slice is never passed off as a whole market', async () => {
    const h = harness(20);
    const result = await runSearch(
      { ...base, maxResults: 25 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    // The distinction that matters: halted means the CALL ceiling stopped it,
    // capped means the business limit did. Conflating them would tell the user
    // to raise the wrong control.
    expect(result.run.resultCapReached).toBe(true);
    expect(result.run.halted).toBe(false);
  });

  it('leaves a market smaller than the cap untouched', async () => {
    // Four terms x 2 = 8 businesses, well under 100. Nothing to trim, nothing
    // to warn about — a clean sweep must not report itself as partial.
    const h = harness(2);
    const result = await runSearch(
      { ...base, maxResults: 100 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(result.leads).toHaveLength(8);
    expect(result.run.resultCapReached).toBe(false);
    expect(h.tiles).toHaveLength(4);
  });

  it('defaults to 100 businesses when no cap is given', async () => {
    const h = harness(2);
    const result = await runSearch(base, { apiKey: 'k', fetchImpl: h.impl });

    expect(result.run.maxResults).toBe(100);
  });

  it("defaults the call ceiling below Google's 100-a-day cap", async () => {
    // The regression this whole change exists for: a 200-call default against a
    // 100-call/day quota. The default must sit UNDER the external wall.
    const h = harness(2);
    const result = await runSearch(
      { location: 'Testville', niche: 'dentist', maxDepth: 0, audit: false },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(result.run.maxCalls).toBeLessThan(100);
  });

  it('still stops at the call ceiling when that is the tighter limit', async () => {
    // A huge business cap must not disable the budget guard.
    const h = harness(1);
    const result = await runSearch(
      { ...base, maxCalls: 2, maxResults: 5000 },
      { apiKey: 'k', fetchImpl: h.impl },
    );

    expect(result.run.callsUsed).toBe(2);
    expect(result.run.halted).toBe(true);
    expect(result.run.resultCapReached).toBe(false);
  });
});

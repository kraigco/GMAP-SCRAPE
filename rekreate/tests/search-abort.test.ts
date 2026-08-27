import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { runSearch } from '../src/server/search.ts';
import { createPlacesClient } from '../src/places/client.ts';
import type { BBox } from '../src/lib/bbox.ts';

/**
 * A throwaway ledger per test file.
 *
 * The free-tier ledger is real state on disk. Left at its default path the
 * suite spends the month's actual Places allowance on assertions — it did,
 * 27 calls' worth, the first time these tests ran against it.
 */
const LEDGER = join(tmpdir(), `rekreate-test-usage-${process.pid}-${'abort'}.json`);
afterEach(async () => {
  await rm(LEDGER, { force: true });
});

/**
 * A closed tab must stop the sweep.
 *
 * The server had a flag that only silenced the progress events — the sweep ran
 * on to the end, billing every remaining call to a browser that had gone. A
 * refresh really did double the spend. These tests count the requests actually
 * issued, because that is the thing that costs money; anything else is a claim
 * about intent.
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

type Harness = {
  impl: typeof fetch;
  /** One entry per tile search actually sent to Google — i.e. per billed call. */
  tiles: string[];
  /** Every prospect URL fetched by the audit stage. */
  sites: string[];
};

/** Optionally aborts the controller once `abortAfterTiles` tile calls have been issued. */
function harness(controller?: AbortController, abortAfterTiles = 0): Harness {
  const tiles: string[] = [];
  const sites: string[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.includes('places:searchText')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      // The location lookup carries no rectangle; a tile search always does.
      if (!body['locationRestriction']) return json(LOCATION);

      tiles.push(String(body['textQuery']));
      if (controller && abortAfterTiles > 0 && tiles.length >= abortAfterTiles) {
        controller.abort();
      }
      return json({
        places: [
          {
            id: `p${tiles.length}`,
            displayName: { text: `Firm ${tiles.length}` },
            websiteUri: `https://firm${tiles.length}.test`,
          },
        ],
      });
    }

    if (!url.endsWith('/robots.txt')) sites.push(url);
    return new Response('<html><body>hello</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  return { impl: impl as unknown as typeof fetch, tiles, sites };
}

const params = { location: 'Testville', niche: 'dentist', maxCalls: 50, maxDepth: 0 };

describe('runSearch — the control case', () => {
  it('sweeps every term and audits every prospect when nobody interrupts', async () => {
    const h = harness();
    const result = await runSearch(params, { apiKey: 'k', fetchImpl: h.impl, usagePath: LEDGER });

    expect(h.tiles).toHaveLength(4); // termsForNiche('dentist') produces four
    expect(result.leads).toHaveLength(4);
    expect(result.run.callsUsed).toBe(4);
    expect(result.run.aborted).toBe(false);
    expect(h.sites).toHaveLength(4);
    expect(result.run.sitesFetched).toBe(4);
  });
});

describe('runSearch — abort', () => {
  it('issues no further Places calls once the caller has gone', async () => {
    const controller = new AbortController();
    const h = harness(controller, 1);

    const result = await runSearch(
      { ...params, signal: controller.signal },
      { apiKey: 'k', fetchImpl: h.impl, usagePath: LEDGER },
    );

    // One call was in flight when the tab closed. Not a fifth, not a fourth.
    expect(h.tiles).toEqual(['dentist']);
    expect(result.run.callsUsed).toBe(1);
    expect(result.run.aborted).toBe(true);
  });

  it('keeps what was already paid for rather than discarding the run', async () => {
    const controller = new AbortController();
    const h = harness(controller, 1);

    const result = await runSearch(
      { ...params, signal: controller.signal },
      { apiKey: 'k', fetchImpl: h.impl, usagePath: LEDGER },
    );

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]?.id).toBe('p1');
    expect(result.run.estimatedCostUsd).toBeCloseTo(0.035, 5);
  });

  it('stops visiting prospect websites too', async () => {
    const controller = new AbortController();
    const h = harness(controller, 1);

    const result = await runSearch(
      { ...params, signal: controller.signal },
      { apiKey: 'k', fetchImpl: h.impl, usagePath: LEDGER },
    );

    expect(h.sites).toEqual([]);
    expect(result.run.sitesFetched).toBe(0);
    // Skipped, not failed: an unvisited site must not be reported as one with
    // no email or no HTTPS.
    expect(result.leads[0]?.audited).toBe(false);
    expect(result.leads[0]?.signals).not.toContain('no-email');
    expect(result.leads[0]?.reachable).toBe('unknown');
  });

  it('spends nothing on tiles when the caller is already gone', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(controller);

    const result = await runSearch(
      { ...params, signal: controller.signal },
      { apiKey: 'k', fetchImpl: h.impl, usagePath: LEDGER },
    );

    // The location lookup is already away by then — it is one Essentials-tier
    // call, and it is the only thing an already-dead search can cost.
    expect(h.tiles).toEqual([]);
    expect(result.run.callsUsed).toBe(0);
    expect(result.run.aborted).toBe(true);
    expect(result.leads).toEqual([]);
  });
});

describe('places client — shouldStop', () => {
  const BOX: BBox = { swLat: 39, swLng: -75, neLat: 40, neLng: -74 };

  it('issues no request at all once it is told to stop', async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return json({ places: [] });
    }) as unknown as typeof fetch;

    const client = createPlacesClient({
      apiKey: 'k',
      maxCalls: 10,
      fetchImpl: impl,
      shouldStop: () => true,
    });

    const tile = await client.searchTile('dentist', BOX);

    expect(calls).toBe(0);
    expect(client.callsUsed()).toBe(0);
    // Nothing was looked at, so nothing is known — the tile is not a clean zero.
    expect(tile.truncated).toBe(true);
    expect(tile.places).toEqual([]);
  });

  it('leaves the remaining budget unspent', async () => {
    let stop = false;
    const impl = (async () => json({ places: [{ id: 'a' }], nextPageToken: 't' })) as unknown as typeof fetch;

    const client = createPlacesClient({
      apiKey: 'k',
      maxCalls: 10,
      fetchImpl: impl,
      shouldStop: () => stop,
    });

    await client.searchTile('dentist', BOX);
    expect(client.callsUsed()).toBe(3); // paged to the ceiling

    stop = true;
    await client.searchTile('dentist', BOX);
    expect(client.callsUsed()).toBe(3); // and not one more
    expect(client.budgetRemaining()).toBe(7);
  });
});

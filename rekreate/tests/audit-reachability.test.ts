import { describe, expect, it } from 'vitest';
import { auditSite } from '../src/audit/site.ts';
import { deriveSignals } from '../src/lead/signals.ts';

/**
 * "Your website did not load when we checked" is the single most damaging thing
 * this engine can get wrong. The prospect can disprove it in one click, and
 * every other claim in the letter dies with it.
 *
 * Measured on the 216-lead Philadelphia list, 28 of the 39 sites recorded as
 * unreachable answered perfectly well — 13 with a 200, 11 with a 403, 2 with a
 * 404. Two causes, both regression-tested here:
 *
 *   1. a 4xx was collapsed into reachable: 'no', so a server that ANSWERED and
 *      refused the crawler was reported as a site that was down;
 *   2. a listed http:// URL that would not connect was never retried on https,
 *      though plenty of businesses stopped serving port 80 years ago.
 *
 * The module header always promised "a timeout, a 403 or a robots disallow
 * yields 'unknown' — never 'no'". These tests hold it to that.
 */

type Route = { status?: number; type?: string; body: string };

/** Anything not routed simply fails to connect, the way a dead host does. */
function routedFetch(routes: Record<string, Route>): { impl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? 'text/html; charset=utf-8' },
    });
  };
  return { impl: impl as unknown as typeof fetch, seen };
}

const PLAIN = 'text/plain; charset=utf-8';
const HOME =
  '<html><head><meta name="viewport" content="width=device-width"></head>' +
  '<body><a href="mailto:info@acme.test">Email us</a></body></html>';

/** A 403 splash: real markup, but not the site — and with no viewport meta. */
const BLOCKED = '<html><head><title>Forbidden</title></head><body>403</body></html>';

describe('a server that answers is not a server that is down', () => {
  it('records a 403 as unknown, never as unreachable', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { status: 403, body: BLOCKED },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('unknown');
    expect(audit.httpStatus).toBe(403);
  });

  it('does not raise a "down" gap from a 403', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { status: 403, body: BLOCKED },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });
    const signals = deriveSignals({
      website: 'https://acme.test/', reachable: audit.reachable, https: audit.https,
      viewport: audit.mobileViewport, ttfb: audit.ttfbMs, email: 'x@y.test',
      reviews: 50, audited: true,
    } as never);

    expect(signals).not.toContain('down');
  });

  it('does not judge the markup of an error page', async () => {
    // The 403 splash has no viewport meta. Reporting 'no-viewport' would be a
    // claim about a document the owner never serves to a customer.
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { status: 403, body: BLOCKED },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.mobileViewport).toBe('unknown');
    expect(audit.ttfbMs).toBeNull();
  });

  it('records a stale listed path (404) as unknown, not as a dead site', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/old-page': { status: 404, body: BLOCKED },
    });

    const audit = await auditSite('p1', 'https://acme.test/old-page', { fetchImpl: impl });

    expect(audit.reachable).toBe('unknown');
  });

  it('still reports a 5xx as genuinely down — the server IS failing', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { status: 503, body: 'unavailable' },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('no');
  });
});

describe('an http:// listing that will not connect is retried on https', () => {
  it('finds the site on https and reports it as reachable', async () => {
    // Port 80 is dead; 443 serves the real site. This is the common case:
    // Google keeps listing the http:// address it recorded years ago.
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'http://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('yes');
    expect(audit.finalUrl).toBe('https://acme.test/');
    expect(audit.error).toBeNull();
  });

  it('credits the site with HTTPS rather than calling it insecure', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: '' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'http://acme.test/', { fetchImpl: impl });

    expect(audit.https).toBe('yes');
  });

  it("reads the secure origin's robots.txt rather than reusing the failed one", async () => {
    // The http robots fetch failed, which getRobots reports as PERMISSIVE.
    // Carrying that over would crawl the https origin under rules never read.
    const { impl, seen } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: 'User-agent: *\nDisallow: /\n' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'http://acme.test/', { fetchImpl: impl });

    expect(seen).toContain('https://acme.test/robots.txt');
    expect(audit.robotsBlocked).toBe(false); // blocked on the retry, so never fetched
    expect(seen).not.toContain('https://acme.test/');
    expect(audit.reachable).toBe('no');
  });

  it('reports the original failure when https is dead too', async () => {
    const { impl } = routedFetch({});

    const audit = await auditSite('p1', 'http://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('no');
    expect(audit.error).toContain('fetch failed');
  });

  it('does not retry a URL that was already https', async () => {
    const { impl, seen } = routedFetch({});

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('no');
    // robots + the page itself, and nothing more: no second scheme to try.
    expect(seen.filter((u) => u === 'https://acme.test/')).toHaveLength(1);
  });
});

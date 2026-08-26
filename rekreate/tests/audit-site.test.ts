import { describe, expect, it, vi } from 'vitest';
import { auditSite } from '../src/audit/site.ts';
import { extractEmails } from '../src/audit/email.ts';

/**
 * The audit's network path, which is where three bugs lived that its unit tests
 * could not see: robots.txt parsed correctly but was never actually read,
 * wildcard rules locked us out of whole sites, and one malformed `mailto:` took
 * down every prospect in the batch alongside it.
 */

type Route = { status?: number; type?: string; body: string };

function routedFetch(routes: Record<string, Route>): { impl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) {
      return new Response('<html>not found</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
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

describe('robots.txt is actually honoured, not merely parsed', () => {
  it('respects a Disallow served as text/plain — the way every server sends it', async () => {
    const { impl, seen } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: 'User-agent: *\nDisallow: /\n' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.robotsBlocked).toBe(true);
    expect(audit.error).toBe('robots.txt disallows this path');
    // The real proof: we never touched the site that told us not to.
    expect(seen).toEqual(['https://acme.test/robots.txt']);
    expect(audit.emails).toEqual([]);
  });

  it('reads a rule regardless of header case', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { type: 'TEXT/PLAIN', body: 'User-agent: *\nDisallow: /\n' },
      'https://acme.test/': { body: HOME },
    });
    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });
    expect(audit.robotsBlocked).toBe(true);
  });

  it('audits normally when robots.txt permits it', async () => {
    const { impl, seen } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: 'User-agent: *\nDisallow: /wp-admin\n' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.robotsBlocked).toBe(false);
    expect(audit.reachable).toBe('yes');
    expect(audit.emails).toEqual(['info@acme.test']);
    expect(seen).toContain('https://acme.test/');
  });

  it('treats a missing robots.txt as permissive', async () => {
    const { impl } = routedFetch({ 'https://acme.test/': { body: HOME } });
    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });
    expect(audit.robotsBlocked).toBe(false);
    expect(audit.emails).toEqual(['info@acme.test']);
  });

  it('does not let a rule about PDFs lock us out of the whole site', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': {
        type: PLAIN,
        body: 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?\n',
      },
      'https://acme.test/': { body: HOME },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.robotsBlocked).toBe(false);
    expect(audit.emails).toEqual(['info@acme.test']);
  });

  it('still refuses a path a wildcard rule really does cover', async () => {
    const { impl, seen } = routedFetch({
      'https://acme.test/robots.txt': { type: PLAIN, body: 'User-agent: *\nDisallow: /*/private\n' },
      'https://acme.test/uk/private': { body: HOME },
    });

    const audit = await auditSite('p1', 'https://acme.test/uk/private', { fetchImpl: impl });

    expect(audit.robotsBlocked).toBe(true);
    expect(seen).toEqual(['https://acme.test/robots.txt']);
  });
});

describe('a malformed page costs that prospect, never the batch', () => {
  it('survives a mailto with a broken percent-escape', () => {
    // decodeURIComponent throws URIError on this, which used to travel all the
    // way up and reject an entire sweep that had already been paid for.
    const html = '<a href="mailto:bob%zz@acme.test">a</a><p>info@acme.test</p>';
    expect(() => extractEmails(html, 'acme.test')).not.toThrow();
    expect(extractEmails(html, 'acme.test')).toContain('info@acme.test');
  });

  it('audits a site whose markup carries one', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { status: 404, body: 'nope' },
      'https://acme.test/': {
        body:
          '<html><a href="mailto:%E0%A4%A">broken</a>' +
          '<a href="mailto:info@acme.test">good</a></html>',
      },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('yes');
    expect(audit.emails).toContain('info@acme.test');
  });

  it('records a contact-extraction failure rather than rejecting', async () => {
    vi.resetModules();
    vi.doMock('../src/audit/email.ts', () => ({
      extractEmails: (): string[] => {
        throw new Error('boom');
      },
      findContactLinks: (): string[] => [],
      bareHost: (h: string): string => h,
    }));

    const { auditSite: isolated } = await import('../src/audit/site.ts');
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { status: 404, body: 'nope' },
      'https://acme.test/': { body: HOME },
    });

    const audit = await isolated('p1', 'https://acme.test/', { fetchImpl: impl });

    // Everything the fetch established survives; only the parse is lost, and it
    // is lost loudly — into the column the export prints.
    expect(audit.reachable).toBe('yes');
    expect(audit.https).toBe('yes');
    expect(audit.mobileViewport).toBe('yes');
    expect(audit.emails).toEqual([]);
    expect(audit.error).toContain('contact extraction failed');

    vi.doUnmock('../src/audit/email.ts');
    vi.resetModules();
  });
});

describe('audit basics', () => {
  it('reports an unreachable host without inventing gaps', async () => {
    const impl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND acme.test');
    }) as unknown as typeof fetch;

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('no');
    expect(audit.https).toBe('unknown');
    expect(audit.mobileViewport).toBe('unknown');
    expect(audit.error).toContain('ENOTFOUND');
  });

  it('does not buffer a body that is not markup', async () => {
    const { impl } = routedFetch({
      'https://acme.test/robots.txt': { status: 404, body: 'nope' },
      'https://acme.test/': { type: 'application/pdf', body: '%PDF-1.7 info@acme.test' },
    });

    const audit = await auditSite('p1', 'https://acme.test/', { fetchImpl: impl });

    expect(audit.reachable).toBe('yes');
    expect(audit.emails).toEqual([]);
    expect(audit.mobileViewport).toBe('unknown');
  });
});

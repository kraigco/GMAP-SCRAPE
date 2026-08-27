import { describe, expect, it } from 'vitest';
import { extractEmails, findContactLinks } from '../src/audit/email.ts';
import { isAllowed, parseRobots } from '../src/audit/robots.ts';

describe('extractEmails', () => {
  it('finds a mailto address', () => {
    const html = '<a href="mailto:info@ottermanagement.com">Email us</a>';
    expect(extractEmails(html, 'ottermanagement.com')).toEqual(['info@ottermanagement.com']);
  });

  it('finds a bare address in body text', () => {
    const html = '<p>Reach the leasing office at leasing@phillypm.com or call.</p>';
    expect(extractEmails(html, 'phillypm.com')).toContain('leasing@phillypm.com');
  });

  it('prefers an address on the firm\'s own domain over a free inbox', () => {
    const html = 'contact@trustartrealty.com and trustartbackup@gmail.com';
    expect(extractEmails(html, 'trustartrealty.com')[0]).toBe('contact@trustartrealty.com');
  });

  it('ranks a human inbox above an anonymous one', () => {
    const html = 'zz9@acme.com info@acme.com';
    expect(extractEmails(html, 'acme.com')[0]).toBe('info@acme.com');
  });

  it('discards image filenames that look like addresses', () => {
    const html = '<img src="https://cdn.site.com/sprite@2x.png"> logo@2x.jpg';
    expect(extractEmails(html, 'site.com')).toEqual([]);
  });

  it('discards analytics and platform noise', () => {
    const html = 'a1b2c3d4e5f6a7b8@sentry.io x@sentry-next.wixpress.com you@example.com';
    expect(extractEmails(html, 'acme.com')).toEqual([]);
  });

  it('discards no-reply addresses — a campaign must never target one', () => {
    const html = 'noreply@acme.com no-reply@acme.com donotreply@acme.com';
    expect(extractEmails(html, 'acme.com')).toEqual([]);
  });

  it('deduplicates case variants', () => {
    const html = 'Info@Acme.com and info@acme.com';
    expect(extractEmails(html, 'acme.com')).toEqual(['info@acme.com']);
  });

  it('returns nothing for a page with no address', () => {
    expect(extractEmails('<html><body><h1>Welcome</h1></body></html>', 'acme.com')).toEqual([]);
  });
});

describe('findContactLinks', () => {
  const base = 'https://acme.com/';

  it('finds a contact page and resolves it absolutely', () => {
    const html = '<a href="/contact-us">Contact</a>';
    expect(findContactLinks(html, base)).toEqual(['https://acme.com/contact-us']);
  });

  it('refuses to follow a link off the prospect\'s own domain', () => {
    const html = '<a href="https://facebook.com/contact">Contact</a>';
    expect(findContactLinks(html, base)).toEqual([]);
  });

  it('ignores mailto and anchor hrefs', () => {
    const html = '<a href="mailto:a@acme.com">contact</a><a href="#contact">contact</a>';
    expect(findContactLinks(html, base)).toEqual([]);
  });

  it('caps how many pages it will chase', () => {
    const html = ['/contact', '/about', '/our-team', '/connect']
      .map((p) => '<a href="' + p + '">x</a>').join('');
    expect(findContactLinks(html, base, 2)).toHaveLength(2);
  });
});

describe('robots.txt', () => {
  it('honours a disallow in the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private');
    expect(isAllowed(rules, '/private/page')).toBe(false);
    expect(isAllowed(rules, '/contact')).toBe(true);
  });

  it('ignores rules aimed at a different agent', () => {
    const rules = parseRobots('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin');
    expect(isAllowed(rules, '/contact')).toBe(true);
    expect(isAllowed(rules, '/admin')).toBe(false);
  });

  it('lets a longer Allow override a broader Disallow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /contact');
    expect(isAllowed(rules, '/contact')).toBe(true);
    expect(isAllowed(rules, '/anything-else')).toBe(false);
  });

  it('treats an empty robots.txt as permissive', () => {
    expect(isAllowed(parseRobots(''), '/anything')).toBe(true);
  });

  it('strips comments', () => {
    const rules = parseRobots('User-agent: *   # everyone\nDisallow: /x  # secret');
    expect(isAllowed(rules, '/x')).toBe(false);
  });
});

describe('extractEmails — third-party addresses', () => {
  it('rejects a font foundry credited in the markup', () => {
    const html = '/* Lato by tyPoland — team@latofonts.com */ <p>Call us today</p>';
    expect(extractEmails(html, 'originalroofingllc.com')).toEqual([]);
  });

  it('rejects the web agency in the footer', () => {
    const html = 'Site by Bright Studio — hello@brightstudio.dev';
    expect(extractEmails(html, 'acmeroofing.com')).toEqual([]);
  });

  it('keeps a consumer inbox — plenty of small firms run on one', () => {
    const html = 'valueroofing@yahoo.com';
    expect(extractEmails(html, 'valueroofing.com')).toEqual(['valueroofing@yahoo.com']);
  });

  it('keeps an address on a subdomain of the site', () => {
    const html = 'office@mail.excelroofingnj.com';
    expect(extractEmails(html, 'excelroofingnj.com')).toEqual(['office@mail.excelroofingnj.com']);
  });

  it('keeps everything plausible when the site host is unknown', () => {
    expect(extractEmails('hello@somewhere.com')).toEqual(['hello@somewhere.com']);
  });
});

describe('extractEmails — version strings', () => {
  it('rejects a package version that parses as an address', () => {
    const html = '<!-- fontawesome-free@6.4.0 --> <p>Roofing since 1998</p>';
    expect(extractEmails(html, 'loftuselite.com')).toEqual([]);
  });

  it('rejects any numeric top-level domain', () => {
    expect(extractEmails('build@1.2.3 tag@2.0', 'acme.com')).toEqual([]);
  });

  it('still accepts a normal address alongside one', () => {
    const html = 'jquery@3.6.0 and info@acme.com';
    expect(extractEmails(html, 'acme.com')).toEqual(['info@acme.com']);
  });
});

describe('extractEmails — developer-facing regions', () => {
  it('ignores a font designer credited in a CSS comment', () => {
    const html = '<style>/* Lato — Copyright Pablo Impallari (impallari@gmail.com) */</style>' +
      '<p>Call ORIGINAL ROOFING today</p>';
    expect(extractEmails(html, 'originalroofingllc.com')).toEqual([]);
  });

  it('ignores an address inside an HTML comment', () => {
    const html = '<!-- old contact: previous@owner.com --><p>Nothing here</p>';
    expect(extractEmails(html, 'acme.com')).toEqual([]);
  });

  it('ignores a developer address in a script body', () => {
    const html = '<script>var support = "dev@vendor.io";</script><p>Roofing</p>';
    expect(extractEmails(html, 'acme.com')).toEqual([]);
  });

  it('KEEPS an address published in JSON-LD — that is the business saying it', () => {
    const html = '<script type="application/ld+json">' +
      '{"@type":"LocalBusiness","email":"office@acmeroofing.com"}</script>';
    expect(extractEmails(html, 'acmeroofing.com')).toEqual(['office@acmeroofing.com']);
  });

  it('still reads a mailto in real markup', () => {
    const html = '<style>/* x@vendor.com */</style><a href="mailto:info@acme.com">Email</a>';
    expect(extractEmails(html, 'acme.com')).toEqual(['info@acme.com']);
  });
});

/**
 * Both collection paths used to disagree about percent escapes: the mailto
 * branch decoded, the bare-text branch did not, and EMAIL_RE's local part
 * accepts `%` and `-`. Three junk addresses reached the real Philadelphia and
 * Makati lists that way — `%20trag@gaocdental.com`, `%20info@oakstreetpm.com`
 * and `-info@wtprops.com` — each of them a live address we would have mailed.
 */
describe('a candidate is normalised before it is judged', () => {
  it('collapses an escaped mailto to the one address it means', () => {
    const html = '<a href="mailto:%20info@oakstreetpm.com">Email</a>';
    expect(extractEmails(html, 'oakstreetpm.com')).toEqual(['info@oakstreetpm.com']);
  });

  it('does not emit both the decoded and the raw form of the same address', () => {
    // The exact shape that produced the duplicate: the href is escaped, so the
    // mailto path decodes it while the text path matches the escape literally.
    const html = '<a href="mailto:%20trag@gaocdental.com">%20trag@gaocdental.com</a>';
    expect(extractEmails(html, 'gaocdental.com')).toEqual(['trag@gaocdental.com']);
  });

  it('strips punctuation the regex ran into on the way in', () => {
    const html = '<p>e-mail:-info@wtprops.com</p>';
    expect(extractEmails(html, 'wtprops.com')).toEqual(['info@wtprops.com']);
  });

  it('rejects a local part still carrying an escape decodeURIComponent refused', () => {
    // `%zz` is malformed, so safeDecode hands the value back untouched and the
    // plausibility guard is the only thing standing between it and a campaign.
    const html = '<p>bo%zzb@acme.com</p>';
    expect(extractEmails(html, 'acme.com')).toEqual([]);
  });

  it('leaves an ordinary address alone', () => {
    const html = '<a href="mailto:first.last@acme.com">First Last</a>';
    expect(extractEmails(html, 'acme.com')).toEqual(['first.last@acme.com']);
  });
});

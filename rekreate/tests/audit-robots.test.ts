import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/audit/robots.ts';

/**
 * Wildcard rules, which the first implementation truncated at the `*` and read
 * as a bare prefix. `Disallow: /*.pdf$` became `Disallow: /`, so a rule about
 * PDF files silently locked the audit out of the entire site — and the site
 * scored worse for it, because a prospect we cannot audit shows no gaps.
 */

const rules = (text: string): ReturnType<typeof parseRobots> => parseRobots(text);

describe('wildcards', () => {
  it('a rule about one file type does not block the site', () => {
    const r = rules('User-agent: *\nDisallow: /*.pdf$');
    expect(isAllowed(r, '/')).toBe(true);
    expect(isAllowed(r, '/contact')).toBe(true);
    expect(isAllowed(r, '/brochure.pdf')).toBe(false);
    expect(isAllowed(r, '/files/2026/brochure.pdf')).toBe(false);
  });

  it('anchors on $ — a path that merely contains the pattern is allowed', () => {
    const r = rules('User-agent: *\nDisallow: /*.pdf$');
    expect(isAllowed(r, '/brochure.pdf.html')).toBe(true);
  });

  it('$ on its own matches the root and nothing below it', () => {
    const r = rules('User-agent: *\nDisallow: /$');
    expect(isAllowed(r, '/')).toBe(false);
    expect(isAllowed(r, '/about')).toBe(true);
  });

  it('matches a wildcard in the middle of a path', () => {
    const r = rules('User-agent: *\nDisallow: /*/private');
    expect(isAllowed(r, '/uk/private')).toBe(false);
    expect(isAllowed(r, '/uk/private/deeper')).toBe(false);
    expect(isAllowed(r, '/private')).toBe(true);
    expect(isAllowed(r, '/uk/public')).toBe(true);
  });

  it('handles several wildcards in one rule', () => {
    const r = rules('User-agent: *\nDisallow: /a/*/b/*/c');
    expect(isAllowed(r, '/a/1/b/2/c')).toBe(false);
    expect(isAllowed(r, '/a/1/2/b/3/4/c/d')).toBe(false);
    expect(isAllowed(r, '/a/1/b/2/d')).toBe(true);
  });

  it('a query-string rule does not swallow ordinary pages', () => {
    // Extremely common in WordPress robots.txt. Truncated at the `*` it reads
    // as "disallow everything".
    const r = rules('User-agent: *\nDisallow: /*?');
    expect(isAllowed(r, '/')).toBe(true);
    expect(isAllowed(r, '/contact')).toBe(true);
  });

  it('returns promptly on a pattern built to make a regex backtrack', () => {
    // A hostile robots.txt is still a robots.txt. This is why the matcher is a
    // two-pointer scan and not a compiled regex: the equivalent pattern makes a
    // backtracking engine take exponential time on a non-matching path.
    const r = rules(`User-agent: *\nDisallow: /${'*a'.repeat(20)}$`);
    expect(isAllowed(r, `/${'a'.repeat(200)}b`)).toBe(true);
  });
});

describe('precedence', () => {
  it('the longer rule wins, wildcards included in its length', () => {
    const r = rules('User-agent: *\nDisallow: /*\nAllow: /contact');
    expect(isAllowed(r, '/contact')).toBe(true);
    expect(isAllowed(r, '/pricing')).toBe(false);
  });

  it('Allow beats Disallow at equal length', () => {
    const r = rules('User-agent: *\nDisallow: /files\nAllow: /files');
    expect(isAllowed(r, '/files/x')).toBe(true);
  });

  it('paths are case-sensitive, as the standard requires', () => {
    const r = rules('User-agent: *\nDisallow: /Admin');
    expect(isAllowed(r, '/Admin')).toBe(false);
    expect(isAllowed(r, '/admin')).toBe(true);
  });
});

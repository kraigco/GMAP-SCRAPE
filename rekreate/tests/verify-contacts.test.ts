import { describe, expect, it } from 'vitest';
import { EMAIL_RE, isPH, lookupMx, phoneProblem, renderReport, verifyContacts } from '../src/verify/contacts.ts';

/**
 * The bug these exist for was not in the DNS parsing — it was in the error
 * handling around it.
 *
 * The first version of this check asked `node:dns` for MX records. UDP :53 was
 * refused in the environment it ran in, every lookup threw, and a
 * `.catch(() => false)` reported all 202 addresses on the sheet as
 * undeliverable. Every one of them was fine. What gave it away was gmail.com
 * failing too, which cannot happen.
 *
 * So the contract under test is narrow and specific: a lookup that FAILS must
 * be distinguishable from a domain that has NO MAIL. Anything that cannot tell
 * those apart is worse than no check at all, because it produces a confident
 * list of wrong answers.
 */

const dns = (body: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('lookupMx', () => {
  it('reports a domain with mail servers as reachable', async () => {
    const f = dns({ Status: 0, Answer: [{ data: '10 mx.example.com.' }] });
    expect(await lookupMx('example.com', f)).toBe('yes');
  });

  it('reports a domain that resolves but has no MX as undeliverable', async () => {
    expect(await lookupMx('example.com', dns({ Status: 0, Answer: [] }))).toBe('no');
  });

  it('reports NXDOMAIN as undeliverable', async () => {
    expect(await lookupMx('nope.invalid', dns({ Status: 3 }))).toBe('no');
  });

  it('reports a THROWN lookup as unknown, never as undeliverable', async () => {
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    // The exact bug: this must not be 'no'.
    expect(await lookupMx('gmail.com', boom)).toBe('unknown');
  });

  it('reports a SERVFAIL as unknown', async () => {
    expect(await lookupMx('example.com', dns({ Status: 2 }))).toBe('unknown');
  });

  it('reports a non-200 from the resolver as unknown', async () => {
    expect(await lookupMx('example.com', dns({}, false))).toBe('unknown');
  });
});

describe('phoneProblem', () => {
  it('accepts a Philippine mobile in either notation', () => {
    expect(phoneProblem('0917 828 0824', true)).toBeNull();
    expect(phoneProblem('+63 917 828 0824', true)).toBeNull();
  });

  it('accepts a Metro Manila landline', () => {
    expect(phoneProblem('(02) 8894 1291', true)).toBeNull();
  });

  it('accepts a US number with or without the country code', () => {
    expect(phoneProblem('(718) 273-8175', false)).toBeNull();
    expect(phoneProblem('+1 718 273 8175', false)).toBeNull();
  });

  it('catches an extension stored in the number field', () => {
    // The real one on the sheet: Chevron Realty, "(646) 221-1300 ext. 106".
    expect(phoneProblem('(646) 221-1300 ext. 106', false)).toMatch(/not 10 digits/);
  });

  it('rejects an area code or exchange starting 0 or 1', () => {
    expect(phoneProblem('(046) 221-1300', false)).toMatch(/area code/);
    expect(phoneProblem('(646) 021-1300', false)).toMatch(/exchange/);
  });

  it('rejects an empty or wordy value', () => {
    expect(phoneProblem('', false)).toBe('no digits');
    expect(phoneProblem('call us', false)).toBe('no digits');
  });
});

describe('isPH', () => {
  it('recognises the Metro Manila cities the sheet actually contains', () => {
    expect(isPH({ address: '1157 Chino Roces Ave, Makati City, Philippines' })).toBe(true);
    expect(isPH({ address: 'Pasay, Metro Manila' })).toBe(true);
    expect(isPH({ address: '6326 Amboy Rd, Staten Island, NY 10309, USA' })).toBe(false);
  });
});

describe('EMAIL_RE', () => {
  it('requires a dotted domain', () => {
    expect(EMAIL_RE.test('info@example.com')).toBe(true);
    expect(EMAIL_RE.test('info@localhost')).toBe(false);
    expect(EMAIL_RE.test('not an address')).toBe(false);
  });
});

describe('verifyContacts', () => {
  const lead = (over: Partial<Parameters<typeof verifyContacts>[0][number]> = {}) => ({
    id: 'p1', name: 'Test Co', address: 'Makati City, Philippines',
    phone: '0917 828 0824', website: '', email: '', emailAlt: [], ...over,
  });

  it('never counts an unresolvable lookup as a bad address', async () => {
    const boom = (async () => { throw new Error('no dns'); }) as unknown as typeof fetch;
    const { report } = await verifyContacts([lead({ email: 'info@example.com' })], {
      fetchImpl: boom,
      cachedProbes: [],
    });
    expect(report.badEmails).toHaveLength(0);
    expect(report.uncheckedEmails).toHaveLength(1);
  });

  it('flags a domain with no mail server', async () => {
    const { report } = await verifyContacts([lead({ email: 'info@example.com' })], {
      fetchImpl: dns({ Status: 0, Answer: [] }),
      cachedProbes: [],
    });
    expect(report.badEmails).toHaveLength(1);
    expect(report.badEmails[0]?.detail).toContain('no mail server');
  });

  it('checks a domain once however many addresses share it', async () => {
    let calls = 0;
    const counting = (async () => { calls += 1; return { ok: true, json: async () => ({ Status: 0, Answer: [1] }) }; }) as unknown as typeof fetch;
    await verifyContacts(
      [lead({ email: 'a@shared.com', emailAlt: ['b@shared.com', 'c@shared.com'] })],
      { fetchImpl: counting, cachedProbes: [] },
    );
    expect(calls).toBe(1);
  });

  it('counts a malformed phone without touching the network', async () => {
    const { report } = await verifyContacts(
      [lead({ phone: '(646) 221-1300 ext. 106', address: 'Philadelphia, PA, USA' })],
      { cachedProbes: [] },
    );
    expect(report.badPhones).toHaveLength(1);
    expect(report.phonesTested).toBe(1);
  });
});

describe('renderReport', () => {
  it('separates what failed from what could not be checked', () => {
    const lead = { id: 'p1', name: 'Test Co', address: 'Makati', phone: '', website: '', email: '' };
    const md = renderReport(
      {
        total: 1, sitesTested: 0, emailsTested: 1, phonesTested: 0,
        brokenSites: [], blockedSites: [], badEmails: [],
        uncheckedEmails: [{ lead, detail: 'x@y.com — y.com could not be checked' }],
        badPhones: [],
      },
      '2026-08-28',
    );
    expect(md).toContain('could not be checked — 1');
    expect(md).toContain('Not a fault');
    // The headline count must not absorb the unchecked ones.
    expect(md).toContain('| Email domain accepts mail | MX looked up | 1 | **0** |');
  });
});

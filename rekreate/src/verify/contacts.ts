/**
 * Re-checks the contact details on a lead list and reports what is broken.
 *
 * Three different kinds of certainty, and blurring them is how this check goes
 * wrong. Each is labelled in the output rather than averaged into one score:
 *
 *   Websites — actually fetched, by the same `auditSite` the pipeline uses, so
 *              the https-retry and the "a 4xx is not down" fixes apply here too.
 *              A verdict of `no` means it genuinely did not load.
 *
 *   Emails   — the DOMAIN is asked for MX records. No MX, or no such domain,
 *              means nothing can be delivered there: a real defect, and one
 *              worth acting on because bounces cost sender reputation. The
 *              MAILBOX cannot be tested without sending to it, so a domain that
 *              passes is `plausible`, never `confirmed`.
 *
 *   Phones   — format only. Whether a line is answered cannot be established
 *              without dialling it or paying for an HLR lookup. Malformed is a
 *              finding; silence is not.
 *
 * MX goes over DNS-over-HTTPS rather than `node:dns`, and that is a correctness
 * decision, not a style one. The first version used `resolveMx()` and reported
 * all 202 addresses on the sheet undeliverable — because UDP :53 was refused in
 * that environment and `.catch(() => false)` turned "could not ask" into "no
 * answer". A known-good control (gmail.com, which cannot plausibly be dead) is
 * what exposed it. DoH travels over the same HTTPS the audit already needs, so
 * it works anywhere the rest of the pipeline works.
 *
 * Hence `MxVerdict` has three values. `unknown` is never counted as a fault —
 * the same rule the audit applies to a prospect, applied to our own tooling.
 */
import { auditSite, type SiteAudit } from '../audit/site.ts';
import { mapPool } from '../lib/concurrency.ts';

export type ContactLead = {
  id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  email: string;
  emailAlt?: string[];
};

export type MxVerdict = 'yes' | 'no' | 'unknown';

export type Finding = { lead: ContactLead; detail: string };

export type ContactReport = {
  total: number;
  sitesTested: number;
  emailsTested: number;
  phonesTested: number;
  brokenSites: Finding[];
  blockedSites: Finding[];
  badEmails: Finding[];
  uncheckedEmails: Finding[];
  badPhones: Finding[];
};

const DOH = 'https://cloudflare-dns.com/dns-query';

/** Somewhere in the Philippines, as far as phone and market rules are concerned. */
export function isPH(lead: Pick<ContactLead, 'address'>): boolean {
  return /Philippines|Metro Manila|Makati|Pasay|Mandaluyong|Quezon City|Taguig/i.test(
    lead.address ?? '',
  );
}

export const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Does anything accept mail for this domain?
 *
 * DNS status codes, not exceptions, carry the answer: 0 with answers is a live
 * mail route, 0 without them is a domain that exists and takes no mail, and 3
 * (NXDOMAIN) is no domain at all. Everything else — a non-200, a SERVFAIL, a
 * thrown fetch — is our failure to ask, and says nothing about them.
 */
export async function lookupMx(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MxVerdict> {
  try {
    const res = await fetchImpl(`${DOH}?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { Status?: number; Answer?: unknown[] };
    if (body.Status === 3) return 'no';
    if (body.Status !== 0) return 'unknown';
    return (body.Answer?.length ?? 0) > 0 ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/**
 * Why this number cannot be dialled as written, or null when the shape is fine.
 *
 * Deliberately shallow. It catches numbers that are structurally impossible —
 * an extension stored in the number field, a truncated paste — and nothing
 * else. A well-formed number that rings nowhere is not detectable from here and
 * must not be implied.
 */
export function phoneProblem(raw: string, ph: boolean): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return 'no digits';

  if (ph) {
    const nat = digits.startsWith('63') ? digits.slice(2) : digits.replace(/^0/, '');
    if (/^9\d{9}$/.test(nat)) return null; // mobile
    if (/^2\d{8}$/.test(nat)) return null; // NCR landline
    if (/^[3-8]\d{6,8}$/.test(nat)) return null; // provincial area codes
    return `unexpected PH format (${digits.length} digits)`;
  }

  // NANP: ten digits, optionally with a leading 1. Neither the area code nor
  // the exchange may begin 0 or 1.
  const nanp = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (nanp.length !== 10) return `not 10 digits (${nanp.length})`;
  if (/^[01]/.test(nanp)) return 'area code starts 0 or 1';
  if (/^\d{3}[01]/.test(nanp)) return 'exchange starts 0 or 1';
  return null;
}

const has = (v: unknown): boolean => !!(v && String(v).trim() && v !== 'unknown');

export type VerifyOptions = {
  fetchImpl?: typeof fetch;
  /** Reuse probes captured earlier instead of refetching every site. */
  cachedProbes?: SiteAudit[] | null;
  concurrency?: number;
  timeoutMs?: number;
  onProgress?: (done: number, total: number) => void;
};

export async function verifyContacts(
  leads: readonly ContactLead[],
  options: VerifyOptions = {},
): Promise<{ report: ContactReport; probes: SiteAudit[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 8;
  const timeoutMs = options.timeoutMs ?? 12000;

  const withSite = leads.filter((l) => has(l.website));
  const probes =
    options.cachedProbes ??
    (await mapPool(
      withSite,
      concurrency,
      (l) => auditSite(l.id, l.website, { timeoutMs, fetchImpl }),
      options.onProgress,
    ));

  const byId = new Map(probes.map((p, i) => [withSite[i]?.id ?? p.placeId, p]));

  const brokenSites: Finding[] = [];
  const blockedSites: Finding[] = [];
  for (const lead of withSite) {
    const probe = byId.get(lead.id);
    if (!probe) continue;
    if (probe.robotsBlocked) {
      blockedSites.push({ lead, detail: 'robots.txt disallows us, so its status is unknown by choice' });
      continue;
    }
    if (probe.reachable === 'no') {
      const status = probe.httpStatus ? ` (HTTP ${probe.httpStatus})` : '';
      brokenSites.push({ lead, detail: `${probe.error ?? 'did not load'}${status}` });
    }
  }

  const addresses = leads.flatMap((lead) =>
    [lead.email, ...(lead.emailAlt ?? [])]
      .filter(has)
      .map((email) => ({ lead, email: String(email).trim() })),
  );

  // One lookup per domain, however many addresses share it.
  const mxCache = new Map<string, Promise<MxVerdict>>();
  const mxFor = (domain: string): Promise<MxVerdict> => {
    let hit = mxCache.get(domain);
    if (!hit) {
      hit = lookupMx(domain, fetchImpl);
      mxCache.set(domain, hit);
    }
    return hit;
  };

  const badEmails: Finding[] = [];
  const uncheckedEmails: Finding[] = [];
  await mapPool(addresses, Math.max(concurrency, 10), async ({ lead, email }) => {
    if (!EMAIL_RE.test(email)) {
      badEmails.push({ lead, detail: `${email} — malformed address` });
      return;
    }
    const domain = email.slice(email.indexOf('@') + 1).toLowerCase();
    const verdict = await mxFor(domain);
    if (verdict === 'no') {
      badEmails.push({ lead, detail: `${email} — ${domain} has no mail server, so nothing can be delivered` });
    } else if (verdict === 'unknown') {
      uncheckedEmails.push({ lead, detail: `${email} — ${domain} could not be checked` });
    }
  });

  const badPhones: Finding[] = [];
  let phonesTested = 0;
  for (const lead of leads) {
    if (!has(lead.phone)) continue;
    phonesTested += 1;
    const problem = phoneProblem(lead.phone, isPH(lead));
    if (problem) badPhones.push({ lead, detail: `${lead.phone} — ${problem}` });
  }

  return {
    report: {
      total: leads.length,
      sitesTested: withSite.length,
      emailsTested: addresses.length,
      phonesTested,
      brokenSites,
      blockedSites,
      badEmails,
      uncheckedEmails,
      badPhones,
    },
    probes,
  };
}

/** Markdown, because the output is a list a person reads and works through. */
export function renderReport(report: ContactReport, today: string): string {
  const line = ({ lead, detail }: Finding): string =>
    `- [${isPH(lead) ? 'PH' : 'US'}] **${lead.name}** — ${detail}`;

  const section = (title: string, rows: Finding[], note?: string): string =>
    `## ${title} — ${rows.length}\n\n` +
    (note ? `${note}\n\n` : '') +
    (rows.length ? rows.map(line).join('\n') : '_Nothing found._') +
    '\n';

  return [
    `# Contact verification — ${report.total} leads`,
    '',
    `Run ${today}. No Places quota was spent: this is direct HTTP and DNS only.`,
    '',
    '| Check | How certain | Tested | Failed |',
    '|---|---|---|---|',
    `| Website loads | Actually fetched | ${report.sitesTested} | **${report.brokenSites.length}** |`,
    `| Email domain accepts mail | MX looked up | ${report.emailsTested} | **${report.badEmails.length}** |`,
    `| Phone is dialable | Format only | ${report.phonesTested} | **${report.badPhones.length}** |`,
    '',
    '**What this does not prove.** A domain with a mail server may still not have',
    'that particular mailbox; only sending finds out. A well-formed phone number',
    'may still ring nowhere.',
    '',
    section(
      'Websites that did not load',
      report.brokenSites,
      'Not a data problem — these are prospects, and a dead site is the strongest hook the audit produces.',
    ),
    section(
      'Email addresses that cannot receive mail',
      report.badEmails,
      'Remove these before the first send. Bounces cost sender reputation for every later campaign.',
    ),
    section('Phone numbers that cannot be dialled as written', report.badPhones),
    section(
      'Email domains that could not be checked',
      report.uncheckedEmails,
      'Not a fault. The lookup itself failed, so nothing is known either way — re-run to resolve.',
    ),
    section('Sites that block us in robots.txt', report.blockedSites),
    '',
  ].join('\n');
}

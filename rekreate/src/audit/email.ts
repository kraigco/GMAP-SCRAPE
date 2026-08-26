/**
 * Pull contact addresses out of a prospect's own HTML.
 *
 * PURE — takes markup, returns addresses. No fetch, so it is testable against
 * fixture pages rather than live sites.
 *
 * The hard part is not finding strings shaped like an email; it is discarding
 * the ones that are not contact addresses. Analytics keys, tracking pixels,
 * theme-author credits and placeholder text all match the naive pattern, and a
 * campaign sent to `noreply@sentry.io` is worse than no campaign.
 */

/**
 * The trailing `[A-Za-z]{2,}` matters more than it looks. Without it,
 * `fontawesome-free@6.4.0` in a dependency banner parses as an address on the
 * domain `6.4.0`, and a package version ends up in a mail campaign.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;

/** Extensions that mean we matched a filename, not an address. */
const FILE_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?|ttf|mp4|pdf)$/i;

/** Hosts that appear in markup for reasons unrelated to contacting anyone. */
const NOISE_HOSTS = [
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com',
  'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'email.com',
  'squarespace.com', 'godaddy.com', 'w3.org', 'schema.org', 'sentry.wixpress.com',
  'googlemail.com.png', 'placeholder.com', 'test.com', 'company.com',
];

/** Local parts that are real addresses but never worth writing to. */
const NOISE_LOCAL = ['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'abuse'];

/**
 * Consumer inboxes. A small business legitimately runs on one of these, so an
 * address here is kept even though it is not on their own domain.
 */
const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'att.net',
  'sbcglobal.net', 'bellsouth.net', 'cox.net', 'earthlink.net', 'juno.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com',
]);

/**
 * The decisive filter.
 *
 * Any page carries addresses belonging to other people — a font foundry in a
 * licence comment, a theme author's credit, an agency's footer signature. They
 * pass every shape check and are completely wrong to email.
 *
 * So an address qualifies only if it is on the firm's OWN domain, or on a
 * consumer provider a small business would plausibly use. That loses the rare
 * firm whose mail lives on an unrelated corporate domain, and that is the right
 * trade: a missed lead costs nothing, a stranger's inbox costs reputation.
 */
function belongsToSite(host: string, siteHost: string | null): boolean {
  if (FREE_PROVIDERS.has(host)) return true;
  if (!siteHost) return true;                 // nothing to compare against
  return host === siteHost || host.endsWith('.' + siteHost) || siteHost.endsWith('.' + host);
}

/** Ranked best-first — a human reads these, a robot reads the rest. */
const PREFERRED_LOCAL = [
  'info', 'contact', 'hello', 'leasing', 'rentals', 'sales', 'inquiries',
  'enquiries', 'office', 'admin', 'support', 'team', 'management', 'properties',
];

function isPlausible(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 1) return false;
  const local = address.slice(0, at).toLowerCase();
  const host = address.slice(at + 1).toLowerCase();

  if (FILE_SUFFIX.test(address)) return false;
  if (address.includes('..') || local.length > 64 || address.length > 254) return false;
  if (!host.includes('.')) return false;
  // A bare numeric TLD or a hex-looking local part is almost always a tracking id.
  if (/^[0-9a-f]{16,}$/.test(local)) return false;
  if (NOISE_HOSTS.some((n) => host === n || host.endsWith('.' + n))) return false;
  if (NOISE_LOCAL.includes(local)) return false;
  return true;
}

function score(address: string, siteHost: string | null): number {
  const at = address.lastIndexOf('@');
  const local = address.slice(0, at).toLowerCase();
  const host = address.slice(at + 1).toLowerCase();

  let value = 0;
  // An address on the firm's own domain beats a gmail on their contact page.
  if (siteHost && (host === siteHost || siteHost.endsWith('.' + host) || host.endsWith('.' + siteHost))) value += 40;
  const preferred = PREFERRED_LOCAL.indexOf(local);
  if (preferred !== -1) value += 30 - preferred;
  if (local.includes('.')) value += 3;          // firstname.lastname reads human
  if (/^\d/.test(local)) value -= 10;
  return value;
}

/** Strip the www. so `www.acme.com` and `acme.com` compare equal. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Remove the parts of a page that are addressed to developers, not customers.
 *
 * Font and theme licences carry their author's personal address — Lato ships
 * with the designer's gmail in a CSS comment — and those pass every other
 * check. They live in comments and script bodies, never in content, so cutting
 * those regions removes the whole class of mistake rather than blocklisting
 * names one at a time.
 *
 * JSON-LD is deliberately kept: `application/ld+json` is where a business
 * publishes its real contact details in machine-readable form.
 */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * `decodeURIComponent` THROWS on a malformed escape — `mailto:bob%zz@acme.com`
 * is a URIError, not a bad return value. That markup exists in the wild, and an
 * uncaught throw here used to travel all the way up through the audit pool and
 * abort an entire sweep that had already been paid for in API calls. One
 * prospect's broken hand-written HTML must cost that prospect, not the run.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractEmails(html: string, siteHost?: string): string[] {
  const content = stripNonContent(html);
  const found = new Set<string>();

  for (const match of content.matchAll(MAILTO_RE)) {
    const raw = safeDecode(match[1] ?? '').trim().toLowerCase();
    if (raw) found.add(raw);
  }
  for (const match of content.matchAll(EMAIL_RE)) {
    found.add(match[0].trim().toLowerCase().replace(/\.$/, ''));
  }

  const host = siteHost ? bareHost(siteHost) : null;
  return [...found]
    .filter(isPlausible)
    .filter((address) => belongsToSite(address.slice(address.lastIndexOf('@') + 1), host))
    .sort((a, b) => score(b, host) - score(a, host) || a.localeCompare(b));
}

/**
 * Links worth following for a contact address, best-first, same-origin only.
 * One extra fetch per prospect at most — a contact page is where the address
 * lives when the homepage does not carry it.
 */
const CONTACT_HINT = /(contact|about|get-in-touch|reach-us|connect|our-team|staff)/i;

export function findContactLinks(html: string, baseUrl: string, max = 2): string[] {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
  const base = (() => {
    try { return new URL(baseUrl); } catch { return null; }
  })();
  if (!base) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const href of hrefs) {
    if (!CONTACT_HINT.test(href)) continue;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;

    let url: URL;
    try { url = new URL(href, base); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (bareHost(url.hostname) !== bareHost(base.hostname)) continue;  // same origin only

    url.hash = '';
    const key = url.toString();
    if (seen.has(key) || key === base.toString()) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }

  return out;
}

import { extractEmails, findContactLinks } from './email.ts';
import { isAllowed, parseRobots, PERMISSIVE } from './robots.ts';
import type { RobotsRules } from './robots.ts';

/**
 * Visit one prospect's site and come back with a contact address plus the
 * infrastructure facts the scoring stage needs.
 *
 * Every check is tri-state. A timeout, a 403 or a robots disallow yields
 * 'unknown' for whatever it blocked — never 'no'. A site we could not reach is
 * not a site without HTTPS, and collapsing those two would invent gaps that do
 * not exist.
 */

export type AuditState = 'yes' | 'no' | 'unknown';

export type SiteAudit = {
  placeId: string;
  inputUrl: string | null;
  finalUrl: string | null;
  reachable: AuditState;
  https: AuditState;
  ttfbMs: number | null;
  mobileViewport: AuditState;
  contactForm: AuditState;
  emails: string[];
  pagesFetched: number;
  httpStatus: number | null;
  error: string | null;
  robotsBlocked: boolean;
};

const UA =
  'RekreateLeadEngine/0.1 (+https://rekreatedigital.com; contact ai@rekreatedigital.com)';

export type FetchOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type Fetched = { status: number; url: string; html: string; ttfbMs: number };

type PageOptions = Required<Pick<FetchOptions, 'timeoutMs'>> & { fetchImpl: typeof fetch };

/** What kind of body a request is willing to buffer. */
type BodyKind = 'html' | 'text';

/**
 * Only read the body when it is the kind we asked for — a PDF or a zip would be
 * pointless to buffer and slow to download.
 *
 * The `text` kind exists because robots.txt is served as `text/plain`. Demanding
 * markup there silently produced an empty body for every correctly-served
 * robots.txt on the web, which `getRobots` then read as "no rules" — so the
 * crawler honoured nothing at all while its unit tests went on passing.
 */
function wantsBody(contentType: string, kind: BodyKind): boolean {
  if (contentType === '') return true;                     // unlabelled: read it and find out
  if (kind === 'text') return contentType.startsWith('text/');
  return contentType.includes('html');
}

async function getPage(url: string, opts: PageOptions, kind: BodyKind = 'html'): Promise<Fetched> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), opts.timeoutMs);
  const started = Date.now();
  try {
    const res = await opts.fetchImpl(url, {
      redirect: 'follow',
      signal: control.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const ttfbMs = Date.now() - started;
    // Normalised: servers send `Text/HTML` and `TEXT/PLAIN` too, and a
    // case-sensitive test would read those as binary.
    const type = (res.headers.get('content-type') ?? '').toLowerCase().trim();
    const html = wantsBody(type, kind) ? await res.text() : '';
    return { status: res.status, url: res.url || url, html, ttfbMs };
  } finally {
    clearTimeout(timer);
  }
}

async function getRobots(origin: string, opts: PageOptions): Promise<RobotsRules> {
  try {
    const res = await getPage(new URL('/robots.txt', origin).toString(), opts, 'text');
    if (res.status >= 200 && res.status < 300 && res.html) return parseRobots(res.html);
  } catch {
    /* unreachable robots.txt means no rules to honour */
  }
  return PERMISSIVE;
}

const VIEWPORT_RE = /<meta[^>]+name\s*=\s*["']viewport["'][^>]*>/i;
const FORM_RE = /<form[\s>]/i;
const FORM_HINT = /(contact|enquir|inquir|message|get-in-touch|request)/i;

export async function auditSite(
  placeId: string,
  websiteUri: string | null,
  options: FetchOptions = {},
): Promise<SiteAudit> {
  const timeoutMs = options.timeoutMs ?? 9000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const opts = { timeoutMs, fetchImpl };

  const base: SiteAudit = {
    placeId,
    inputUrl: websiteUri,
    finalUrl: null,
    reachable: 'unknown',
    https: 'unknown',
    ttfbMs: null,
    mobileViewport: 'unknown',
    contactForm: 'unknown',
    emails: [],
    pagesFetched: 0,
    httpStatus: null,
    error: null,
    robotsBlocked: false,
  };

  if (!websiteUri) return { ...base, reachable: 'no', error: 'no website listed' };

  let start: URL;
  try {
    start = new URL(websiteUri);
  } catch {
    return { ...base, reachable: 'no', error: `unparseable url: ${websiteUri}` };
  }

  let robots = await getRobots(start.origin, opts);
  if (!isAllowed(robots, start.pathname)) {
    return { ...base, robotsBlocked: true, error: 'robots.txt disallows this path' };
  }

  let home: Fetched | null = null;
  let failure: string | null = null;
  try {
    home = await getPage(start.toString(), opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failure = message.includes('abort') ? `timeout after ${timeoutMs}ms` : message.slice(0, 160);
  }

  // A listed http:// URL that will not connect is NOT the same thing as a site
  // that is down: plenty of businesses stopped serving port 80 entirely, and
  // Google goes on listing the http:// address it recorded years ago. Measured
  // on the Philadelphia list, 28 of 39 "unreachable" sites answered fine on
  // https. Claiming those were down put a falsehood in front of an owner who
  // can see their own site working, which is the one mistake outreach cannot
  // survive. So: one retry on the secure scheme before making any claim.
  if (home === null && start.protocol === 'http:') {
    const secure = new URL(start.toString().replace(/^http:/i, 'https:'));
    // A different scheme is a different origin, so the https robots.txt is the
    // one that governs here - and the http one we just read was itself
    // unreachable, which getRobots reports as PERMISSIVE. Reusing it would
    // crawl the secure origin under rules we never actually read.
    const secureRobots = await getRobots(secure.origin, opts);
    if (isAllowed(secureRobots, secure.pathname)) {
      try {
        home = await getPage(secure.toString(), opts);
        robots = secureRobots;
        failure = null;
      } catch {
        /* keep the original http failure - it is the one worth reporting */
      }
    }
  }

  if (home === null) {
    return { ...base, reachable: 'no', error: failure };
  }

  const finalUrl = new URL(home.url);

  // 4xx is 'unknown', never 'no'. A 403 means the server answered and refused
  // this crawler; a 404 means the path Google listed is stale. In both cases
  // the site is up, and "your website did not load" would be false. Only a
  // 5xx is a server actually failing to serve. This is the contract the module
  // header already stated - the old `< 400 ? yes : no` broke it, and fed 'down'
  // hooks to prospects whose sites were fine.
  const reachable: AuditState =
    home.status >= 200 && home.status < 400 ? 'yes' : home.status >= 500 ? 'no' : 'unknown';

  const audit: SiteAudit = {
    ...base,
    finalUrl: home.url,
    httpStatus: home.status,
    // The error page's timing is not the site's timing, so it is not recorded
    // as such - otherwise a slow 403 becomes a 'slow' gap about a page the
    // owner never serves to anyone.
    ttfbMs: reachable === 'yes' ? home.ttfbMs : null,
    pagesFetched: 1,
    reachable,
    // Judged on where we ENDED UP: a listing of http:// that redirects to
    // https:// is a secure site, and calling it insecure would be a false gap.
    https: finalUrl.protocol === 'https:' ? 'yes' : 'no',
  };

  // An error page is still markup, and scanning it answers questions about the
  // wrong document: a 403 splash with no viewport meta would be reported as
  // 'no-viewport' for a site whose real pages have one. Only a page we actually
  // got can be judged.
  if (!home.html || reachable !== 'yes') return audit;

  audit.mobileViewport = VIEWPORT_RE.test(home.html) ? 'yes' : 'no';
  audit.contactForm =
    FORM_RE.test(home.html) && FORM_HINT.test(home.html) ? 'yes' : 'unknown';

  // Contact discovery is the one part of the audit that parses a stranger's
  // markup, so it is the one part that can be handed something malformed enough
  // to throw. This pool audits hundreds of prospects at once and a throw here
  // would reject the whole batch — losing a sweep that has already been paid
  // for in API calls, over one broken page. It is caught, and recorded rather
  // than swallowed: a failure lands in the row's error column where the export
  // shows it.
  try {
    const emails = new Set(extractEmails(home.html, finalUrl.hostname));

    // Only chase a contact page when the homepage gave us nothing.
    if (emails.size === 0) {
      for (const link of findContactLinks(home.html, home.url, 2)) {
        let path: string;
        try { path = new URL(link).pathname; } catch { continue; }
        if (!isAllowed(robots, path)) continue;

        try {
          const page = await getPage(link, opts);
          audit.pagesFetched += 1;
          if (!page.html) continue;
          for (const address of extractEmails(page.html, finalUrl.hostname)) emails.add(address);
          if (audit.contactForm !== 'yes' && FORM_RE.test(page.html)) audit.contactForm = 'yes';
          if (emails.size > 0) break;
        } catch {
          /* one dead contact page does not invalidate the homepage findings */
        }
      }
    }

    audit.emails = [...emails].slice(0, 3);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    audit.error = `contact extraction failed: ${message}`.slice(0, 160);
  }

  return audit;
}

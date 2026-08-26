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

  const robots = await getRobots(start.origin, opts);
  if (!isAllowed(robots, start.pathname)) {
    return { ...base, robotsBlocked: true, error: 'robots.txt disallows this path' };
  }

  let home: Fetched;
  try {
    home = await getPage(start.toString(), opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      reachable: 'no',
      error: message.includes('abort') ? `timeout after ${timeoutMs}ms` : message.slice(0, 160),
    };
  }

  const finalUrl = new URL(home.url);
  const audit: SiteAudit = {
    ...base,
    finalUrl: home.url,
    httpStatus: home.status,
    ttfbMs: home.ttfbMs,
    pagesFetched: 1,
    reachable: home.status >= 200 && home.status < 400 ? 'yes' : 'no',
    // Judged on where we ENDED UP: a listing of http:// that redirects to
    // https:// is a secure site, and calling it insecure would be a false gap.
    https: finalUrl.protocol === 'https:' ? 'yes' : 'no',
  };

  if (!home.html) return audit;

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

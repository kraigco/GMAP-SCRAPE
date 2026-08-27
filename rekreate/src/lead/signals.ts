import type { RawPlace } from '../places/schema.ts';
import type { SiteAudit } from '../audit/site.ts';
import { scoreLead, type LeadScore } from '../scoring/score.ts';

/**
 * One definition of "what is wrong with this prospect", shared by the CSV, the
 * dashboard and (later) the scoring stage. Two implementations would drift, and
 * a lead flagged in one view but not another destroys trust in both.
 *
 * PURE.
 */

export type Signal =
  | 'no-site'
  | 'down'
  | 'insecure'
  | 'no-viewport'
  | 'slow'
  | 'no-contact-form'
  | 'low-rating'
  | 'no-email'
  | 'thin-reviews';

export const SIGNAL_LABELS: Record<Signal, { label: string; severity: 'crit' | 'warn' }> = {
  'no-site':         { label: 'no website',  severity: 'crit' },
  'down':            { label: 'site down',   severity: 'crit' },
  'insecure':        { label: 'no https',    severity: 'warn' },
  'no-viewport':     { label: 'not mobile',  severity: 'warn' },
  'slow':            { label: 'slow',        severity: 'warn' },
  'no-contact-form': { label: 'no enquiry form', severity: 'warn' },
  'low-rating':      { label: 'low rating',  severity: 'warn' },
  'no-email':        { label: 'no email',    severity: 'warn' },
  'thin-reviews':    { label: 'few reviews', severity: 'warn' },
};

/** Slower than this and a visitor notices the wait. */
export const SLOW_TTFB_MS = 2500;
export const THIN_REVIEW_COUNT = 10;

/**
 * Below this a rating is a problem the prospect has, rather than an asset.
 * Deliberately the same number `GOOD_RATING` in the hook generator uses, so the
 * two can never disagree about whose standing is worth mentioning.
 */
export const LOW_RATING = 4.0;

/**
 * The one shape everything downstream reads. It carries the columns the export
 * declares even where the dashboard has no use for them — an intermediate that
 * quietly drops `businessStatus` or a latitude does not lose a field, it
 * produces a CSV with a header for data that is always blank.
 */
export type Lead = {
  id: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  host: string;
  email: string;
  emailAlt: string[];
  rating: number | null;
  reviews: number | null;
  businessStatus: string;
  primaryType: string;
  lat: number | null;
  lng: number | null;
  reachable: string;
  https: string;
  ttfb: number | null;
  viewport: string;
  contactForm: string;
  /** Where the site actually ended up after redirects. */
  finalUrl: string;
  auditError: string;
  signals: Signal[];
  audited: boolean;
  /**
   * Derived exactly like `signals`, and for the same reason: computed once here
   * so the CSV, the Sheet and the dashboard cannot disagree about which lead to
   * call first. A score recomputed in the browser would eventually differ from
   * the one written to the Sheet, and a ranking two views disagree about is
   * worse than no ranking.
   */
  score: LeadScore;
};

/**
 * A lead before anything is derived from it — the measured facts only. Named
 * because two functions take it and `Omit<Lead, 'signals' | 'score'>` spelled
 * out twice is one place for the two to fall out of step.
 */
export type LeadFacts = Omit<Lead, 'signals' | 'score'>;

export function deriveSignals(lead: LeadFacts): Signal[] {
  const signals: Signal[] = [];

  if (!lead.website) signals.push('no-site');
  else if (lead.reachable === 'no') signals.push('down');

  // Only ever raised from an actual visit — 'unknown' is never a gap.
  if (lead.https === 'no') signals.push('insecure');
  if (lead.viewport === 'no') signals.push('no-viewport');
  if (lead.ttfb !== null && lead.ttfb > SLOW_TTFB_MS) signals.push('slow');

  // Only the confident 'no'. The audit records 'unknown' whenever its contact
  // search short-circuited, precisely so this line cannot claim a site has no
  // enquiry route when the form may sit on a page we never opened.
  if (lead.contactForm === 'no') signals.push('no-contact-form');

  // A rating is only a finding when enough people have voted to make it one.
  // Two disappointed customers out of three is noise; twenty-six reviews at 1.9
  // is a business problem. Reusing the thin-reviews bar keeps one definition of
  // "established" in the codebase rather than two that drift apart.
  if (
    lead.rating !== null &&
    lead.rating < LOW_RATING &&
    lead.reviews !== null &&
    lead.reviews >= THIN_REVIEW_COUNT
  ) {
    signals.push('low-rating');
  }

  // Before an audit runs we simply do not know, so we do not claim.
  if (lead.audited && !lead.email) signals.push('no-email');

  if (lead.reviews !== null && lead.reviews < THIN_REVIEW_COUNT) signals.push('thin-reviews');

  return signals;
}

export function toLead(place: RawPlace, audit: SiteAudit | null): Lead {
  const website = place.websiteUri ?? '';
  const base = {
    id: place.id,
    name: place.displayName?.text ?? '(unnamed)',
    address: place.formattedAddress ?? '',
    phone: place.nationalPhoneNumber ?? '',
    website,
    host: website ? website.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '',
    email: audit?.emails[0] ?? '',
    emailAlt: audit?.emails.slice(1) ?? [],
    rating: place.rating ?? null,
    reviews: place.userRatingCount ?? null,
    businessStatus: place.businessStatus ?? '',
    primaryType: place.primaryType ?? '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    reachable: audit?.reachable ?? 'unknown',
    https: audit?.https ?? 'unknown',
    ttfb: audit?.ttfbMs ?? null,
    viewport: audit?.mobileViewport ?? 'unknown',
    contactForm: audit?.contactForm ?? 'unknown',
    finalUrl: audit?.finalUrl ?? '',
    auditError: audit?.error ?? '',
    audited: audit !== null,
  };
  return withDerived(base);
}

/**
 * Attach the two derived fields, in the one order they can be computed in —
 * the score reads the signals. Every constructor of a Lead goes through here,
 * so there is no path that produces a Lead with a stale or missing score.
 */
export function withDerived(base: LeadFacts): Lead {
  const signals = deriveSignals(base);
  const lead = { ...base, signals } as Lead;
  return { ...lead, score: scoreLead(lead) };
}

export function summarise(leads: Lead[]): Record<string, number | string> {
  const n = (fn: (l: Lead) => boolean): number => leads.filter(fn).length;
  const rated = leads.filter((l) => l.rating !== null);
  return {
    prospects: leads.length,
    withEmail: n((l) => !!l.email),
    noSite: n((l) => !l.website),
    down: n((l) => l.signals.includes('down')),
    insecure: n((l) => l.signals.includes('insecure')),
    noViewport: n((l) => l.signals.includes('no-viewport')),
    slow: n((l) => l.signals.includes('slow')),
    noContactForm: n((l) => l.signals.includes('no-contact-form')),
    lowRating: n((l) => l.signals.includes('low-rating')),
    thinReviews: n((l) => l.signals.includes('thin-reviews')),
    contactForm: n((l) => l.contactForm === 'yes'),
    withPhone: n((l) => !!l.phone),
    clean: n((l) => l.signals.length === 0),
    avgRating: rated.length
      ? (rated.reduce((a, b) => a + (b.rating ?? 0), 0) / rated.length).toFixed(2)
      : '—',
  };
}

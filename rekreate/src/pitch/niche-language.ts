import { audienceFor } from './hooks.ts';
import type { Audience } from './hooks.ts';

/**
 * The handful of words a letter needs in order to read as though it were
 * written for one trade rather than adapted to it.
 *
 * PURE — no I/O, no clock, no randomness, same rules as hooks.ts.
 *
 * One campaign letter goes to every recipient, so nothing in it can be a claim
 * about an individual business. It can still speak the trade's own language:
 * a dentist's visitor is deciding where to book, a roofer's is standing under a
 * leak, and calling either of them "an owner or a tenant" is the tell that the
 * letter was written for somebody else and reused.
 *
 * Keyed off the same audience taxonomy the hooks use, so a niche cannot be
 * classified one way for its opening line and another way for its letter.
 */

/**
 * Niches whose name is a mass noun and needs a head noun to be counted.
 *
 * "Every dental clinic" is already a thing you can count; "every property
 * management" is not, and needs "company" after it. Getting this wrong is the
 * difference between "every roofing contractor we could find" and "every
 * roofing contractor company we could find".
 */
const MASS_NOUNS =
  /\b(management|realty|care|repair|cleaning|roofing|plumbing|landscaping|insurance|law|consulting|accounting|bookkeeping|design|marketing|storage|moving|catering|photography|construction|remodeling|painting|flooring|towing|hvac)$/i;

/**
 * The niche as it appears after "every" — singular and countable.
 *
 *   property-management  -> property management company
 *   dental-clinic        -> dental clinic
 *   roofing-contractor   -> roofing contractor
 *   roofing              -> roofing company
 */
export function countableNiche(niche: string, fallback = 'business'): string {
  const clean = niche.replace(/[-_]+/g, ' ').trim().toLowerCase();
  if (!clean) return fallback;
  return MASS_NOUNS.test(clean) ? `${clean} company` : clean;
}

/**
 * The same thing pluralised, for "we checked 215 <these>".
 *
 * Deliberately small: it handles the endings that actually occur in trade
 * names and nothing else. An irregular plural would be a bug worth seeing
 * rather than a rule worth guessing at.
 */
export function pluralNiche(niche: string, fallback = 'businesses'): string {
  const singular = countableNiche(niche, '');
  if (!singular) return fallback;
  if (/(?:s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  return `${singular}s`;
}

/**
 * Who is looking this kind of business up, in the trade's own terms.
 *
 * The letter's second sentence explains why we ran the audit at all, and this
 * is the noun that makes that reason land. It describes the VISITOR, never the
 * recipient — a letter sent to everyone cannot characterise the person opening
 * it, only the person arriving at their site.
 */
const LOOKER: Record<Audience, string> = {
  'emergency-trade': 'someone with a problem that will not wait',
  appointment: 'someone deciding where to book',
  professional: 'a prospective client checking you out before they call',
  property: 'an owner or a tenant',
  'home-services': 'someone putting together a shortlist of quotes',
  general: 'a prospective customer',
};

export function lookerFor(niche: string): string {
  return LOOKER[audienceFor(niche)];
}

/** US state and territory codes, so "nj" becomes "NJ" and not "Nj". */
const STATE_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
  'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt',
  'va', 'wa', 'wv', 'wi', 'wy', 'dc', 'pr',
]);

/**
 * A saved search's location slug, as a person would write their own address.
 *
 *   camden-nj-usa            -> Camden, NJ
 *   philadelphia-pa          -> Philadelphia, PA
 *   makati-city-metro-manila -> Makati City Metro Manila
 *
 * Naive title-casing produced "Camden Nj Usa" in a letter addressed to people
 * who live there, which is the kind of detail that tells a reader no one looked
 * at this before it was sent.
 */
export function marketLabel(location: string, fallback = 'your market'): string {
  const words = location.replace(/[-_]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;

  // "usa" is noise in a letter to a US business, and the country is already
  // implied by the state beside it.
  while (words.length > 1 && (words[words.length - 1] === 'usa' || words[words.length - 1] === 'us')) {
    words.pop();
  }

  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  const last = words[words.length - 1] as string;

  if (words.length > 1 && STATE_CODES.has(last)) {
    return `${words.slice(0, -1).map(cap).join(' ')}, ${last.toUpperCase()}`;
  }
  return words.map(cap).join(' ');
}

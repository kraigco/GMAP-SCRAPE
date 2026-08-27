import type { Lead, Signal } from '../lead/signals.ts';

/**
 * Turn one audited lead into an opening line for a cold approach.
 *
 * PURE — no I/O, no clock, no randomness, no LLM. Every sentence it produces is
 * built from something the audit actually measured, which is the only reason
 * this is safe to send to a stranger. A generated paragraph that guesses at a
 * prospect's problems is worse than no email at all: it is wrong in public, to
 * someone who knows their own business better than we do.
 *
 * The shape is always the same two parts:
 *
 *   observation   what we found, specifically, with the date we found it
 *   stakes        why that costs THIS kind of business money
 *
 * Composing them from two small tables rather than writing one line per
 * (niche × gap) pair keeps it maintainable: six observations and six framings
 * cover thirty-six combinations, and adding a niche costs one sentence.
 */

/**
 * The rating at or above which we will quote a prospect's own standing back to
 * them. Below it the review count may be healthy but the reputation is not, and
 * a line built on "you have a reputation worth directing" stops being true.
 */
export const GOOD_RATING = 4.0;

/** How customers reach this kind of business — which is what a broken site costs. */
export type Audience =
  | 'emergency-trade'
  | 'appointment'
  | 'professional'
  | 'property'
  | 'home-services'
  | 'general';

/**
 * Matched on substrings so a niche typed freehand still lands somewhere sensible.
 * Order matters: the first match wins, so put the specific before the general.
 */
const AUDIENCE_PATTERNS: { audience: Audience; test: RegExp }[] = [
  { audience: 'emergency-trade', test: /plumb|hvac|heating|cooling|air.?con|roof|electric|pest|locksmith|restoration|water.?damage|towing|auto.?repair|mechanic|garage door/i },
  { audience: 'appointment', test: /dent|orthodont|chiro|physio|physical therapy|med.?spa|salon|barber|spa|clinic|vet|doctor|gp|optom|derma|massage|gym|fitness|yoga|daycare|nursery|tattoo/i },
  { audience: 'professional', test: /law|attorney|solicitor|account|bookkeep|tax|insurance|financial|consult|agency|architect|survey/i },
  { audience: 'property', test: /property manage|real estate|realty|letting|estate agent|self.?storage|storage|moving|removal|apartment|hoa|condo/i },
  { audience: 'home-services', test: /landscap|garden|lawn|clean|contractor|builder|remodel|renovat|paint|floor|window|kitchen|pool/i },
];

export function audienceFor(niche: string): Audience {
  // Niches arrive both as saved ids ("property-management") and as free text
  // ("property management"). Matching the raw string sent the flagship niche —
  // the whole first target segment — to `general`, so every Philadelphia letter
  // got the fallback stakes line instead of the one written for landlords.
  // Normalising here fixes it once, rather than in each pattern separately.
  const normalised = niche.replace(/[-_]+/g, ' ');
  const found = AUDIENCE_PATTERNS.find((p) => p.test.test(normalised));
  return found ? found.audience : 'general';
}

/**
 * Why a working site matters to this audience, in their terms rather than ours.
 *
 * Deliberately about their customer's behaviour, not about web design. A roofer
 * does not care that a viewport meta tag is missing; they care that the person
 * standing under a leak gave up and rang someone else.
 */
const STAKES: Record<Audience, string> = {
  'emergency-trade':
    'For urgent work that search happens on a phone, mid-problem, and the first firm that can actually be reached gets the job.',
  appointment:
    'For an appointment business the website is the booking desk — when it does not work, neither does the booking desk.',
  professional:
    'Clients checking a firm they are about to trust with something serious tend to read the website before they ring.',
  property:
    'Owners and tenants compare two or three firms in an evening, and the one they can see the least of is the one they drop first.',
  'home-services':
    'Quote requests come from people comparing a shortlist, and a site that stalls is the easiest name to cross off.',
  general:
    'Most people check a business online before contacting it, and what they find decides whether they bother.',
};

/**
 * The measured finding, stated plainly.
 *
 * `null` means we have nothing honest to open with — no gap was found, or the
 * only thing we noticed is not a problem worth writing to someone about.
 */
function observation(lead: Lead, checkedOn: string | null): string | null {
  const when = checkedOn ? ` when we checked on ${checkedOn}` : '';
  const reviews = lead.reviews ?? 0;

  /**
   * "You have a reputation and nowhere to send it" only lands when the
   * reputation is real. Told to a firm with one review it reads as flattery,
   * and flattery a prospect can disprove in one glance costs more than it
   * wins. The bar is the same `thin-reviews` line the scoring already draws,
   * so the two can never disagree about what counts as established.
   *
   * Volume is not enough on its own, though: the sentence argues that they have
   * standing worth directing somewhere, and at 1.6 stars that argument is false
   * and the compliment reads as a dig. Nine of the fourteen established no-site
   * leads on the Philadelphia list sit under 4.0, so this is the common case,
   * not the edge one. Below the bar we say the plainer thing, which is just as
   * true and insults nobody.
   */
  const established =
    lead.rating !== null &&
    lead.rating >= GOOD_RATING &&
    reviews > 0 &&
    !lead.signals.includes('thin-reviews');
  const standing = `${reviews} review${reviews === 1 ? '' : 's'} at ${(lead.rating ?? 0).toFixed(1)} stars`;

  // Ordered by how much the finding actually costs the prospect. The first one
  // that applies is the one worth leading with — a site that is down matters
  // more than a site that is merely slow, and saying both dilutes each.
  if (lead.signals.includes('no-site')) {
    return established
      ? `You have ${standing} on Google and no website to send any of it to.`
      : `You are listed on Google Maps with no website attached, so everyone who looks you up stops at the listing.`;
  }
  if (lead.signals.includes('down')) {
    return `Your website did not load${when} — a search for you currently ends at an error page.`;
  }
  if (lead.signals.includes('no-viewport')) {
    // Past tense throughout: "is not built for phones when we checked" is the
    // tense slip you only hear by reading the finished line out loud.
    return `Your site was not built for phones${when} — it renders desktop-width on a handset.`;
  }
  if (lead.signals.includes('insecure')) {
    return `Your site was still on http${when}, so browsers mark it "Not secure" before anyone reads a word.`;
  }
  if (lead.signals.includes('slow')) {
    const seconds = lead.ttfb !== null ? ` — about ${(lead.ttfb / 1000).toFixed(1)} seconds before anything appears` : '';
    return `Your site was slow to respond${when}${seconds}.`;
  }
  if (lead.signals.includes('no-contact-form')) {
    // Last, because a working site with no form still works — the visitor has
    // to pick up the phone rather than give up. The signal is only ever raised
    // when the audit finished looking, so this sentence is safe to send.
    return `Your site had no way to send an enquiry${when} — a visitor who is not ready to ring has nothing to do next.`;
  }

  /**
   * `low-rating` is deliberately absent, and it must stay absent.
   *
   * It is a real finding and it belongs in the scoring and the filters — a firm
   * at 1.9 stars over twenty-six reviews has a problem worth solving. But an
   * opening line that quotes it back to them is the exact bug that was already
   * found and fixed once by reading real letters: "You have 20 reviews at 1.6
   * stars" reads as a dig from a stranger, and a prospect insulted in sentence
   * one never reaches sentence two. Reputation work is a conversation to have
   * after they reply, not a cold open.
   */
  return null;
}

export type LeadHook = {
  /** Empty when there was nothing honest to say. */
  text: string;
  audience: Audience;
  /** The measured finding the line rests on. */
  basis: Signal | 'none';
  /** Why there is no hook, when there is no hook. */
  reason: string | null;
};

export type HookContext = {
  niche: string;
  /** e.g. "26 Aug" — the day the audit ran. Omitted rather than guessed. */
  checkedOn?: string | null;
};

/** The finding the line was built on, for the record. */
const PRIORITY: Signal[] = ['no-site', 'down', 'no-viewport', 'insecure', 'slow', 'no-contact-form'];

export function buildHook(lead: Lead, context: HookContext): LeadHook {
  const audience = audienceFor(context.niche || lead.primaryType || '');

  if (!lead.audited && lead.website) {
    return {
      text: '',
      audience,
      basis: 'none',
      reason: 'not audited — run the audit before writing to this one',
    };
  }

  const line = observation(lead, context.checkedOn ?? null);
  if (line === null) {
    // Nothing was found, so nothing is claimed. An invented problem, sent to
    // someone who knows their own business, loses the lead and the credibility.
    return {
      text: '',
      audience,
      basis: 'none',
      reason: 'no gap found — this prospect needs a different angle, not a generated one',
    };
  }

  const basis = PRIORITY.find((s) => lead.signals.includes(s)) ?? 'none';
  return { text: `${line} ${STAKES[audience]}`, audience, basis, reason: null };
}

/** `2026-08-26T14:27:26.820Z` → `26 Aug`. Returns null rather than inventing a date. */
export function checkDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

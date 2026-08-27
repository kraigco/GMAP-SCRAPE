// Type-only, so this module and signals.ts can reference each other's shapes
// without a runtime import cycle: score.ts takes only types from signals.ts,
// signals.ts takes only the function from here.
import type { Lead, Signal } from '../lead/signals.ts';

/**
 * How worth calling is this lead, on one number a human can sort by.
 *
 * PURE — same lead in, same score out, no clock and no I/O.
 *
 * The list is 388 rows and growing, and nobody works a list of 388 rows top to
 * bottom. Until now the only ordering available was "whatever order Google
 * returned them in", which is not an ordering at all. The scoring here answers
 * one question: if you can make ten calls this morning, which ten?
 *
 * THREE AXES, deliberately kept separate rather than blended into one intuition:
 *
 *   opportunity  how badly broken is the thing we sell fixing
 *   reach        can we actually get a message to them
 *   value        do they look like a real trading business with money
 *
 * They are separate because the highest-opportunity leads are systematically
 * the hardest to reach — a firm with no website can never yield an email,
 * because emails are found BY reading the website. A single blended number
 * would keep sorting those to the top and then leave a salesperson with no way
 * to contact them. Splitting the axes lets the reasons say so out loud.
 *
 * The score is a PRIORITY, not a prediction. It does not know deal size, and a
 * one-person operation with no website can score high while having no budget.
 * It orders a morning's calls; it does not forecast revenue.
 */

export type ScoreBand = 'hot' | 'warm' | 'cool' | 'cold';

export type LeadScore = {
  /** 0-100. */
  total: number;
  opportunity: number;
  reach: number;
  value: number;
  band: ScoreBand;
  /** Why it landed where it did, in the order the points were awarded. */
  reasons: string[];
};

export const MAX_OPPORTUNITY = 45;
export const MAX_REACH = 30;
export const MAX_VALUE = 25;

/**
 * What each defect is worth, best-first.
 *
 * Only the single worst one counts. Defects do not add up: a site that is both
 * down and slow is not twice the problem of a site that is down, it is the same
 * conversation. Summing them would push a lead with three cosmetic faults above
 * a lead with no website at all, which is exactly backwards — the no-website
 * lead is the one that converts. (Measured: on the audited Philadelphia list,
 * no-website prospects hooked at 100% and prospects whose site loaded at 13%.)
 */
const DEFECT_POINTS: { signal: Signal; points: number; reason: string }[] = [
  { signal: 'no-site',         points: 45, reason: 'no website at all' },
  { signal: 'down',            points: 40, reason: 'website does not load' },
  { signal: 'no-viewport',     points: 25, reason: 'site is not built for phones' },
  { signal: 'insecure',        points: 20, reason: 'site is still on http' },
  { signal: 'no-contact-form', points: 18, reason: 'site cannot take an enquiry' },
  { signal: 'slow',            points: 15, reason: 'site is slow to respond' },
];

/**
 * A poor rating is a second, different problem we can help with, so it adds
 * rather than competing — but only a little. It is not a website defect and it
 * is never used as a cold opening line, so it earns a nudge up the call list
 * and nothing more.
 */
const LOW_RATING_BONUS = 5;

function opportunityOf(lead: Lead): { points: number; reasons: string[] } {
  // An unaudited site is not a clean site. Awarding zero and saying nothing
  // would rank it alongside a prospect we checked and found perfect, which is a
  // claim we have not earned. It scores zero here WITH the reason attached, so
  // a low score reads as "unknown" rather than "no good".
  if (!lead.audited && lead.website) {
    return { points: 0, reasons: ['not audited yet — score is provisional'] };
  }

  const worst = DEFECT_POINTS.find((d) => lead.signals.includes(d.signal));
  const reasons: string[] = [];
  let points = 0;

  if (worst) {
    points += worst.points;
    reasons.push(worst.reason);
  }
  if (lead.signals.includes('low-rating')) {
    points += LOW_RATING_BONUS;
    reasons.push('rating is below the bar');
  }
  if (!worst && !lead.signals.includes('low-rating')) {
    reasons.push('nothing measurably wrong — needs a different angle');
  }

  return { points: Math.min(points, MAX_OPPORTUNITY), reasons };
}

function reachOf(lead: Lead): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;

  // Email outranks phone because it is what a campaign can actually use at
  // scale, and because it is the scarce one: 56% of the corpus has no email
  // and only 4% has no phone.
  if (lead.email) { points += 20; reasons.push('email address found'); }
  if (lead.phone) { points += 10; reasons.push('phone number on the listing'); }
  if (!lead.email && !lead.phone) reasons.push('no way to contact them at all');

  return { points, reasons };
}

function valueOf(lead: Lead): { points: number; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;

  // Review count is the only evidence in this data that a business is actually
  // trading and has customers. It is banded rather than continuous because the
  // difference between 300 reviews and 400 does not mean anything, while the
  // difference between 3 and 30 does.
  const reviews = lead.reviews ?? 0;
  if (reviews >= 100)      { points += 15; reasons.push(`${reviews} reviews — well established`); }
  else if (reviews >= 50)  { points += 12; reasons.push(`${reviews} reviews`); }
  else if (reviews >= 20)  { points += 9;  reasons.push(`${reviews} reviews`); }
  else if (reviews >= 10)  { points += 6;  reasons.push(`${reviews} reviews`); }
  else if (reviews >= 1)   { points += 3;  reasons.push(`only ${reviews} review${reviews === 1 ? '' : 's'}`); }
  else                     { reasons.push('no reviews — may not be trading'); }

  // A well-rated firm is a firm with satisfied customers and, usually, money.
  // This is about their capacity to pay, which is why it does not contradict
  // `low-rating` scoring as an opportunity: a badly-rated business has a
  // problem worth solving AND less evidence of a budget to solve it with.
  const rating = lead.rating;
  if (rating !== null) {
    if (rating >= 4.5)      { points += 10; reasons.push(`${rating.toFixed(1)} stars`); }
    else if (rating >= 4.0) { points += 7;  reasons.push(`${rating.toFixed(1)} stars`); }
    else if (rating >= 3.0) { points += 3; }
  }

  return { points: Math.min(points, MAX_VALUE), reasons };
}

export function bandOf(total: number): ScoreBand {
  if (total >= 70) return 'hot';
  if (total >= 50) return 'warm';
  if (total >= 30) return 'cool';
  return 'cold';
}

export function scoreLead(lead: Lead): LeadScore {
  const opportunity = opportunityOf(lead);
  const reach = reachOf(lead);
  const value = valueOf(lead);
  const total = opportunity.points + reach.points + value.points;

  return {
    total,
    opportunity: opportunity.points,
    reach: reach.points,
    value: value.points,
    band: bandOf(total),
    reasons: [...opportunity.reasons, ...reach.reasons, ...value.reasons],
  };
}

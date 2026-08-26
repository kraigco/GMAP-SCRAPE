import type { RawPlace } from '../places/schema.ts';
import type { Lead } from './signals.ts';

/**
 * Narrowing a sweep to prospects worth contacting.
 *
 * Two things this deliberately does NOT claim to do:
 *
 * 1. Revenue and net worth. Places returns neither, and no field mask can ask
 *    for them — Google does not hold that data. Anything labelled "revenue"
 *    here would be invented. `minReviews` is the honest stand-in: review count
 *    is the best size signal a local listing carries, because reviews
 *    accumulate with years in business and volume of customers.
 *
 * 2. A 0–10 score. Google ratings run 0–5. A rating filter is expressed on
 *    Google's own scale so the number in the UI means the number in the data.
 */

export type LeadFilters = {
  /** Google's own 0–5 scale. 3.5 is the midpoint people usually mean by "7/10". */
  minRating?: number | undefined;
  /** Review count as a proxy for how established the business is. */
  minReviews?: number | undefined;
  /** Drop anything the audit could not find a contact address for. */
  requireEmail?: boolean | undefined;
  /** Drop anything with no website listed at all. */
  requireWebsite?: boolean | undefined;
  /**
   * Keep unrated businesses. A brand new firm has no rating and no reviews,
   * which is not the same as a bad one — so this defaults to false only
   * because a rating filter is usually meant as a quality bar.
   */
  keepUnrated?: boolean | undefined;
};

export type DropReason =
  | 'rating below minimum'
  | 'unrated'
  | 'too few reviews'
  | 'no email found'
  | 'no website';

export type FilterReport = {
  considered: number;
  kept: number;
  dropped: { reason: DropReason; count: number }[];
};

function tally(reasons: DropReason[]): { reason: DropReason; count: number }[] {
  const counts = new Map<DropReason, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export function isEmptyFilter(f: LeadFilters): boolean {
  return (
    f.minRating === undefined &&
    f.minReviews === undefined &&
    !f.requireEmail &&
    !f.requireWebsite
  );
}

/**
 * Applied BEFORE the audit, on data Google already gave us.
 *
 * This ordering matters for more than tidiness: every prospect removed here is
 * a website we never fetch. Filtering a 216-firm sweep down to 60 before the
 * audit saves 150-odd HTTP requests to strangers' servers, which is faster and
 * more polite than fetching them all and discarding the results.
 */
export function filterPlaces(
  places: RawPlace[],
  filters: LeadFilters,
): { kept: RawPlace[]; report: FilterReport } {
  const kept: RawPlace[] = [];
  const reasons: DropReason[] = [];

  for (const place of places) {
    const rating = place.rating ?? null;
    const reviews = place.userRatingCount ?? 0;

    if (filters.requireWebsite && !place.websiteUri) {
      reasons.push('no website');
      continue;
    }
    if (filters.minRating !== undefined) {
      if (rating === null) {
        if (!filters.keepUnrated) {
          reasons.push('unrated');
          continue;
        }
      } else if (rating < filters.minRating) {
        reasons.push('rating below minimum');
        continue;
      }
    }
    if (filters.minReviews !== undefined && reviews < filters.minReviews) {
      reasons.push('too few reviews');
      continue;
    }
    kept.push(place);
  }

  return {
    kept,
    report: { considered: places.length, kept: kept.length, dropped: tally(reasons) },
  };
}

/**
 * Applied AFTER the audit, because only the audit knows whether an address
 * exists. Nothing here can be decided earlier.
 */
export function filterLeads(
  leads: Lead[],
  filters: LeadFilters,
): { kept: Lead[]; report: FilterReport } {
  if (!filters.requireEmail) {
    return {
      kept: leads,
      report: { considered: leads.length, kept: leads.length, dropped: [] },
    };
  }

  const kept = leads.filter((l) => l.email);
  const dropped = leads.length - kept.length;

  return {
    kept,
    report: {
      considered: leads.length,
      kept: kept.length,
      dropped: dropped > 0 ? [{ reason: 'no email found', count: dropped }] : [],
    },
  };
}

/** Merge the two passes into one line the caller can show without arithmetic. */
export function mergeReports(pre: FilterReport, post: FilterReport): FilterReport {
  return {
    considered: pre.considered,
    kept: post.kept,
    dropped: [...pre.dropped, ...post.dropped].sort((a, b) => b.count - a.count),
  };
}

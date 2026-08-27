import type { Lead } from './signals.ts';

/**
 * Find the leads that would receive the same message twice.
 *
 * PURE — takes the list, returns groupings. No I/O.
 *
 * THE QUESTION THIS ANSWERS IS NARROWER THAN "IS THIS THE SAME BUSINESS", and
 * that narrowing is the whole design. Matching on name looked obvious and is
 * wrong: measured against the real corpus it produced five pairs, and four of
 * them were legitimately distinct branches — Lindy Properties has offices in
 * Philadelphia and Huntingdon Valley, Renzi has one in Moorestown NJ and one in
 * Elkins Park PA, each with its own phone and its own manager. Merging those
 * loses a real prospect. Meanwhile it MISSED the pairs that actually matter,
 * like two Affinity Dental branches that publish the same info@ address.
 *
 * So this does not try to decide what a business is. It asks whether two rows
 * lead to the same inbox or handset, because that is the only thing that
 * causes harm: a stranger receiving our cold email twice with two different
 * salutations. Two branches with two separate phones are two calls, and that is
 * correct — they stay separate.
 *
 * Nothing here merges or deletes. It labels, and the caller decides.
 */

export type DuplicateCluster = {
  /** The lead ids that share a contact route, in the order they were given. */
  ids: string[];
  /** What they share, for a human deciding whether to trust the grouping. */
  sharedBy: 'email' | 'phone' | 'website';
  /** The shared value itself. */
  value: string;
};

/** Digits only, so `(215) 549-3909` and `215-549-3909` are one number. */
export function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Lowercase, no `www.`, no path — the host two listings would have in common. */
export function normaliseHost(website: string): string {
  return website
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Is this website plausibly THIS firm's own domain, rather than a platform it
 * merely has a page on?
 *
 * This is the guard that makes website-matching safe, and without it the rule
 * is actively harmful. In the real corpus `facebook.com` was the listed website
 * for eleven unrelated dental clinics and `cebudentalimplants.com` — a
 * directory — for seven more. Grouping those would silently drop sixteen
 * genuine prospects on the grounds that they share a landlord.
 *
 * The test is that the domain and the business name have to recognise each
 * other: either the domain's own label appears in the name (lindyproperty →
 * "Lindy Properties"), or the name's first real word appears in the label
 * ("Philly Property Management" → phillypm). A directory fails both, because
 * its name has nothing to do with the clinics it lists.
 *
 * Deliberately NOT a blocklist of known platforms. A list needs maintaining and
 * is wrong the first time someone lists a platform this project has not heard
 * of; this test needs no upkeep and generalises.
 */
export function ownsDomain(name: string, host: string): boolean {
  const label = host.split('.')[0] ?? '';
  // Two-letter labels like `fb` match far too much to be evidence of anything.
  if (label.length < 3) return false;

  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (flat.includes(label)) return true;

  const first = (name.toLowerCase().match(/[a-z0-9]{4,}/) ?? [])[0];
  return first !== undefined && label.includes(first);
}

/**
 * Group leads that reach the same person.
 *
 * Order of preference matters when a pair shares more than one route: an email
 * is the most specific evidence and a website the least, so the reported reason
 * is the strongest one available rather than whichever was checked first.
 */
export function findDuplicates(leads: Lead[]): DuplicateCluster[] {
  const clusters: DuplicateCluster[] = [];
  const claimed = new Set<string>();

  const collect = (
    sharedBy: DuplicateCluster['sharedBy'],
    keyOf: (lead: Lead) => string | null,
  ): void => {
    const groups = new Map<string, Lead[]>();
    for (const lead of leads) {
      const key = keyOf(lead);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), lead]);
    }

    for (const [value, group] of groups) {
      // A lead already grouped by a stronger signal is not regrouped by a
      // weaker one — otherwise the same pair is reported twice with two
      // different reasons and the count of "duplicate sends" double-counts.
      const fresh = group.filter((l) => !claimed.has(l.id));
      if (fresh.length < 2) continue;
      for (const lead of fresh) claimed.add(lead.id);
      clusters.push({ ids: fresh.map((l) => l.id), sharedBy, value });
    }
  };

  collect('email', (l) => (l.email ? l.email.toLowerCase() : null));
  collect('phone', (l) => (l.phone ? normalisePhone(l.phone) || null : null));
  collect('website', (l) => {
    if (!l.website) return null;
    const host = normaliseHost(l.website);
    return host && ownsDomain(l.name, host) ? host : null;
  });

  return clusters;
}

/**
 * One lead per cluster, everything else untouched — the list as a campaign
 * should send it.
 *
 * The survivor is the highest-scoring member, because when two rows reach the
 * same inbox the one worth leading with is the one with the better story. Ties
 * keep the earlier lead, so the result is stable for the same input.
 */
export function collapseDuplicates(leads: Lead[]): Lead[] {
  const drop = new Set<string>();

  for (const cluster of findDuplicates(leads)) {
    const members = cluster.ids
      .map((id) => leads.find((l) => l.id === id))
      .filter((l): l is Lead => l !== undefined);
    const best = members.reduce((a, b) => (b.score.total > a.score.total ? b : a));
    for (const lead of members) if (lead.id !== best.id) drop.add(lead.id);
  }

  return leads.filter((l) => !drop.has(l.id));
}

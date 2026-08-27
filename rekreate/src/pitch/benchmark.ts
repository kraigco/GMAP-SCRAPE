import type { Lead } from '../lead/signals.ts';

/**
 * The one sentence in a cold email that is allowed to create urgency.
 *
 * PURE — no I/O, no clock, no randomness, no LLM, same rules as hooks.ts.
 *
 * A cold email needs a reason to act now, and there are only two places to get
 * one. It can be invented — a deadline, a discount, "your competitors are
 * pulling ahead" — which reads as pressure from someone who never actually
 * looked. Or it can be measured: this is where you sit against the other firms
 * in your market, and here are the counts. The second is the stronger of the
 * two and it is the only one that survives a prospect checking.
 *
 * So the pressure here comes entirely from the corpus. We audited every firm in
 * the market; we know how many had a site that loaded. Telling a prospect they
 * were one of the 74 out of 216 whose site did not is FOMO in the only form
 * this project will send: a fact, about them, that they can verify, next to the
 * number of their competitors for whom it was not true.
 *
 * The same discipline as the hook applies. When there is nothing measured to
 * compare, this returns an empty string and the email goes out one sentence
 * shorter, which is always better than going out one invention longer.
 */

export type Corpus = {
  /** Leads considered — the audited rows for one market and niche. */
  n: number;
  /** Sites that loaded. */
  up: number;
  /** Sites that did not load. */
  down: number;
  medianTtfbMs: number | null;
  viewportOk: number;
  viewportBad: number;
  httpsOk: number;
  httpsBad: number;
};

/**
 * Below this the corpus is not a market, it is an anecdote, and a sentence
 * built on it would imply a survey we did not do. Say nothing instead.
 */
export const MIN_CORPUS = 30;

export type BenchmarkContext = {
  /** e.g. "Greater Philadelphia" — how the reader would name their own area. */
  market: string;
  /** e.g. "property management companies" — plural, in the reader's words. */
  nicheLabel: string;
};

/** Sub-second times read better as "0.6 seconds" than as "612ms". */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} seconds`;
}

/**
 * The market's findings as one sentence, for a letter sent to everybody.
 *
 * Assembled rather than interpolated, because two things go wrong in a single
 * template string and neither shows up on the niche you wrote it for. On a
 * market where every site renders on a phone it reads "Another 0 were still not
 * built for phones" — a clean result stated as though it were a fault. And
 * where only one site loaded it reads "Of the 1 that did, the typical one",
 * which is not English. Both appeared the first time this ran against a second
 * niche, which is the argument for running it against a second niche.
 *
 * `slowestMs` is the highest time-to-first-byte in the corpus, or null when
 * nothing was timed. It is dropped when it equals the median, since "the
 * typical one took 0.7 seconds and the slowest took 0.7 seconds" says nothing
 * twice.
 */
export function marketFindings(corpus: Corpus, slowestMs: number | null): string {
  const loaded =
    corpus.up === 1
      ? `Of the one that did, it answered in about ${seconds(corpus.medianTtfbMs ?? 0)}.`
      : `Of the ${corpus.up} that did, the typical one answered in about ` +
        `${seconds(corpus.medianTtfbMs ?? 0)}` +
        (slowestMs !== null && slowestMs !== corpus.medianTtfbMs
          ? `, and the slowest took ${seconds(slowestMs)}.`
          : '.');

  const clauses: string[] = [];
  if (corpus.viewportBad > 0) {
    clauses.push(
      `${corpus.viewportBad} ${corpus.viewportBad === 1 ? 'was' : 'were'} still not built for phones`,
    );
  }
  if (corpus.httpsBad > 0) {
    clauses.push(
      `${corpus.httpsBad} ${corpus.httpsBad === 1 ? 'was' : 'were'} still on http, which ` +
        `browsers mark "Not secure" before anyone reads a word`,
    );
  }

  return (
    `${corpus.down} of those ${corpus.n} sites did not load at all. ${loaded}` +
    (clauses.length > 0 ? ` Another ${clauses.join(', and ')}.` : '')
  );
}

/**
 * Fold audited leads into the counts the comparison needs.
 *
 * Only the sites that loaded are counted for viewport and HTTPS: those two are
 * unknowable for a site that never answered, and an unmeasurable thing must
 * never be folded into a denominator as though it had been measured.
 */
export function computeCorpus(leads: Lead[]): Corpus {
  const audited = leads.filter((l) => l.reachable === 'yes' || l.reachable === 'no');
  const up = audited.filter((l) => l.reachable === 'yes');

  const ttfbs = up
    .map((l) => l.ttfb)
    .filter((t): t is number => typeof t === 'number')
    .sort((a, b) => a - b);

  const count = (list: Lead[], pick: (l: Lead) => string, want: string): number =>
    list.filter((l) => pick(l) === want).length;

  return {
    n: audited.length,
    up: up.length,
    down: audited.length - up.length,
    medianTtfbMs: ttfbs.length > 0 ? (ttfbs[Math.floor(ttfbs.length / 2)] as number) : null,
    viewportOk: count(up, (l) => l.viewport, 'yes'),
    viewportBad: count(up, (l) => l.viewport, 'no'),
    httpsOk: count(up, (l) => l.https, 'yes'),
    httpsBad: count(up, (l) => l.https, 'no'),
  };
}

/**
 * The comparison sentence for one lead, or '' when there is nothing honest to
 * compare.
 *
 * Chosen by the same measured gap that chose the hook, and in the same order,
 * so the two sentences always talk about the same finding. An email that opens
 * about a slow site and then benchmarks a missing viewport reads as two
 * templates stapled together, because that is what it would be.
 */
export function benchmarkFor(lead: Lead, corpus: Corpus, ctx: BenchmarkContext): string {
  if (corpus.n < MIN_CORPUS) return '';

  const { market, nicheLabel } = ctx;

  // A prospect with no website is not in the corpus of sites we loaded, and
  // "your competitors have websites" is a jab, not a measurement. The hook
  // already carries the whole argument for this one.
  if (lead.signals.includes('no-site')) return '';

  if (lead.signals.includes('down')) {
    if (corpus.down === 0) return '';
    return (
      `We checked ${corpus.n} ${nicheLabel} across ${market}. ` +
      `${corpus.up} had a site that loaded. Yours was one of the ${corpus.down} that didn't.`
    );
  }

  if (lead.signals.includes('no-viewport')) {
    if (corpus.viewportBad === 0 || corpus.viewportOk === 0) return '';
    return (
      `${corpus.viewportOk} of the ${corpus.up} sites we checked in ${market} render properly ` +
      `on a phone. Yours is one of the ${corpus.viewportBad} that don't.`
    );
  }

  if (lead.signals.includes('insecure')) {
    if (corpus.httpsBad === 0 || corpus.httpsOk === 0) return '';
    return (
      `${corpus.httpsOk} of the ${corpus.up} sites we checked in ${market} are on HTTPS. ` +
      `Yours is one of the ${corpus.httpsBad} that aren't.`
    );
  }

  if (lead.signals.includes('slow')) {
    // Both halves have to be real: without this lead's own time there is no
    // comparison, only an implication that they are on the wrong side of it.
    if (corpus.medianTtfbMs === null || lead.ttfb === null) return '';
    // And the comparison has to run the way the sentence claims. A "slow" lead
    // at or under the median means the market is slow, not that they are.
    if (lead.ttfb <= corpus.medianTtfbMs) return '';
    return (
      `Across the ${corpus.up} sites in ${market} that loaded, the median was ` +
      `${seconds(corpus.medianTtfbMs)}. Yours was ${seconds(lead.ttfb)}.`
    );
  }

  return '';
}

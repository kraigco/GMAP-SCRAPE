import { describe, expect, it } from 'vitest';
import { benchmarkFor, computeCorpus, marketFindings, MIN_CORPUS } from '../src/pitch/benchmark.ts';
import type { Corpus } from '../src/pitch/benchmark.ts';
import { toLead } from '../src/lead/signals.ts';
import type { SiteAudit } from '../src/audit/site.ts';
import type { RawPlace } from '../src/places/schema.ts';

/**
 * The comparison sentence is the only place in a cold email allowed to create
 * urgency, so it is the place most likely to drift into invention. Every test
 * here is really the same test: when the measurement is not there, the sentence
 * is not there either.
 */

const place = (over: Partial<RawPlace> = {}): RawPlace => ({
  id: 'p1',
  displayName: { text: 'Otter Property' },
  formattedAddress: '12 Main St',
  websiteUri: 'https://otter.test',
  rating: 4.5,
  userRatingCount: 31,
  ...over,
});

const audit = (over: Partial<SiteAudit> = {}): SiteAudit => ({
  placeId: 'p1',
  inputUrl: 'https://otter.test',
  finalUrl: 'https://otter.test/',
  reachable: 'yes',
  https: 'yes',
  ttfbMs: 300,
  mobileViewport: 'yes',
  contactForm: 'yes',
  emails: ['info@otter.test'],
  pagesFetched: 1,
  httpStatus: 200,
  error: null,
  robotsBlocked: false,
  ...over,
});

const ctx = { market: 'Greater Philadelphia', nicheLabel: 'property management companies' };

/** A corpus big enough to be quotable, adjusted per test. */
const corpus = (over: Partial<Corpus> = {}): Corpus => ({
  n: 216,
  up: 141,
  down: 75,
  medianTtfbMs: 612,
  viewportOk: 137,
  viewportBad: 4,
  httpsOk: 138,
  httpsBad: 3,
  ...over,
});

describe('computeCorpus', () => {
  it('counts only what was actually audited', () => {
    const leads = [
      toLead(place({ id: 'a' }), audit()),
      toLead(place({ id: 'b' }), audit({ reachable: 'no', ttfbMs: null })),
      // Never audited — must not land in any denominator.
      toLead(place({ id: 'c' }), null),
    ];
    const c = computeCorpus(leads);

    expect(c.n).toBe(2);
    expect(c.up).toBe(1);
    expect(c.down).toBe(1);
  });

  it('judges viewport and HTTPS only on sites that answered', () => {
    // A site that never loaded has no measurable viewport. Counting it as a
    // failure would inflate the number we then quote at somebody.
    const leads = [
      toLead(place({ id: 'a' }), audit({ mobileViewport: 'yes', https: 'yes' })),
      toLead(place({ id: 'b' }), audit({ reachable: 'no', mobileViewport: 'unknown', https: 'unknown', ttfbMs: null })),
    ];
    const c = computeCorpus(leads);

    expect(c.up).toBe(1);
    expect(c.viewportOk).toBe(1);
    expect(c.viewportBad).toBe(0);
    expect(c.httpsBad).toBe(0);
  });

  it('reports no median when nothing was timed', () => {
    const leads = [toLead(place(), audit({ reachable: 'no', ttfbMs: null }))];
    expect(computeCorpus(leads).medianTtfbMs).toBeNull();
  });
});

describe('it only compares when there is something to compare', () => {
  it('says nothing when the corpus is too small to be a market', () => {
    const lead = toLead(place(), audit({ reachable: 'no', ttfbMs: null }));
    expect(benchmarkFor(lead, corpus({ n: MIN_CORPUS - 1 }), ctx)).toBe('');
  });

  it('says nothing for a prospect with no website at all', () => {
    // They are not in the corpus of sites that loaded, and "your competitors
    // have websites" is a jab rather than a measurement.
    const lead = toLead(place({ websiteUri: undefined }), null);
    expect(benchmarkFor(lead, corpus(), ctx)).toBe('');
  });

  it('says nothing about speed without both times', () => {
    const noMedian = toLead(place(), audit({ ttfbMs: 4000 }));
    expect(benchmarkFor(noMedian, corpus({ medianTtfbMs: null }), ctx)).toBe('');
  });

  it('will not claim a prospect is slower than a market they beat', () => {
    // Flagged slow, but faster than the median — the market is slow, not them,
    // and the sentence would say the opposite.
    const lead = toLead(place(), audit({ ttfbMs: 2800 }));
    expect(lead.signals).toContain('slow');
    expect(benchmarkFor(lead, corpus({ medianTtfbMs: 3000 }), ctx)).toBe('');
  });

  it('says nothing when nobody in the corpus shares the fault', () => {
    const lead = toLead(place(), audit({ mobileViewport: 'no' }));
    expect(benchmarkFor(lead, corpus({ viewportBad: 0 }), ctx)).toBe('');
  });
});

describe('the sentence it does write', () => {
  it('places a dead site against the market', () => {
    const lead = toLead(place(), audit({ reachable: 'no', ttfbMs: null }));
    expect(benchmarkFor(lead, corpus(), ctx)).toBe(
      'We checked 216 property management companies across Greater Philadelphia. ' +
        "141 had a site that loaded. Yours was one of the 75 that didn't.",
    );
  });

  it('places a slow site against the median, in seconds', () => {
    const lead = toLead(place(), audit({ ttfbMs: 3200 }));
    expect(benchmarkFor(lead, corpus(), ctx)).toBe(
      'Across the 141 sites in Greater Philadelphia that loaded, the median was ' +
        '0.6 seconds. Yours was 3.2 seconds.',
    );
  });

  it('places a desktop-only site against the ones that render', () => {
    const lead = toLead(place(), audit({ mobileViewport: 'no' }));
    expect(benchmarkFor(lead, corpus(), ctx)).toContain('137 of the 141 sites');
  });

  it('leads with the same finding the hook leads with', () => {
    // Down outranks slow, so a site that is both must benchmark as down —
    // otherwise the email opens about one fault and compares another.
    const lead = toLead(place(), audit({ reachable: 'no', ttfbMs: null, mobileViewport: 'no' }));
    expect(benchmarkFor(lead, corpus(), ctx)).toContain('had a site that loaded');
  });

  it('says nothing at all about a healthy site', () => {
    const lead = toLead(place(), audit());
    expect(benchmarkFor(lead, corpus(), ctx)).toBe('');
  });
});

describe('marketFindings — the sentence sent to a whole market', () => {
  const base = (over: Partial<Corpus> = {}): Corpus => corpus(over);

  it('drops a clean result rather than reporting it as a fault', () => {
    // "Another 0 were still not built for phones" states a good outcome as a
    // problem, and reads as a template nobody checked.
    const s = marketFindings(base({ viewportBad: 0, httpsBad: 0 }), 5535);
    expect(s).not.toContain('0 were');
    expect(s).not.toContain('Another');
  });

  it('keeps only the faults that actually occur', () => {
    const s = marketFindings(base({ viewportBad: 0, httpsBad: 3 }), 5535);
    expect(s).toContain('3 were still on http');
    expect(s).not.toContain('built for phones');
  });

  it('agrees in number when only one site has the fault', () => {
    const s = marketFindings(base({ viewportBad: 1, httpsBad: 0 }), 5535);
    expect(s).toContain('1 was still not built for phones');
  });

  it('stays English when a single site loaded', () => {
    // "Of the 1 that did, the typical one answered" is not a sentence.
    const s = marketFindings(base({ n: 40, up: 1, down: 39, medianTtfbMs: 700 }), 700);
    expect(s).toContain('Of the one that did, it answered in about 0.7 seconds.');
    expect(s).not.toContain('the typical one');
  });

  it('does not say the same number twice', () => {
    // Median and slowest coincide on a one-site corpus.
    const s = marketFindings(base({ n: 40, up: 1, down: 39, medianTtfbMs: 700 }), 700);
    expect(s).not.toContain('the slowest took');
  });

  it('reports the slowest when it differs from the median', () => {
    const s = marketFindings(base(), 5535);
    expect(s).toContain('the slowest took 5.5 seconds');
  });

  it('leads with how many did not load', () => {
    expect(marketFindings(base(), 5535)).toMatch(/^75 of those 216 sites did not load at all\./);
  });
});

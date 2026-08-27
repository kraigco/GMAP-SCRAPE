import { describe, expect, it } from 'vitest';
import { bandOf, MAX_OPPORTUNITY, MAX_REACH, MAX_VALUE, scoreLead } from '../src/scoring/score.ts';
import { withDerived, type Lead, type LeadFacts } from '../src/lead/signals.ts';

/**
 * The ranking that decides which ten calls get made this morning.
 *
 * The tests worth having here are not "45 + 30 + 25 = 100" — that is arithmetic
 * the code already states. They are the judgements: that defects do not stack,
 * that an unaudited lead is not a clean one, and that the number can always
 * account for itself.
 */

function lead(over: Partial<LeadFacts> = {}): Lead {
  return withDerived({
    id: 'p1', name: 'Firm', address: '', phone: '', website: 'https://acme.test',
    host: 'acme.test', email: '', emailAlt: [],
    rating: null, reviews: null, businessStatus: 'OPERATIONAL', primaryType: '',
    lat: null, lng: null, reachable: 'yes', https: 'yes', ttfb: 400,
    viewport: 'yes', contactForm: 'yes', finalUrl: 'https://acme.test/',
    auditError: '', audited: true,
    ...over,
  });
}

describe('opportunity — the worst defect counts, not all of them', () => {
  it('does not stack a second defect on top of the first', () => {
    // A site that is down AND slow is one conversation, not two. Summing them
    // would rank a lead with three cosmetic faults above one with no website,
    // which is backwards: the no-website lead is the one that converts.
    const one = scoreLead(lead({ website: '', reachable: 'no' }));
    const many = scoreLead(lead({ website: '', reachable: 'no', https: 'no', viewport: 'no', ttfb: 9000 }));
    expect(many.opportunity).toBe(one.opportunity);
  });

  it('ranks no website above a site that merely loads slowly', () => {
    expect(scoreLead(lead({ website: '' })).opportunity)
      .toBeGreaterThan(scoreLead(lead({ ttfb: 9000 })).opportunity);
  });

  it('never exceeds its share of the total', () => {
    const worst = scoreLead(lead({ website: '', rating: 1.2, reviews: 60 }));
    expect(worst.opportunity).toBeLessThanOrEqual(MAX_OPPORTUNITY);
  });

  it('treats an unaudited site as unknown, not as clean', () => {
    // The distinction that matters: a zero here must read as "we have not
    // looked", and the reason has to say so, or a provisional score is
    // indistinguishable from a verdict.
    const score = scoreLead(lead({ audited: false }));
    expect(score.opportunity).toBe(0);
    expect(score.reasons.join(' ')).toContain('not audited');
  });
});

describe('reach — the axis that decides whether any of it is usable', () => {
  it('puts an email above a phone number', () => {
    expect(scoreLead(lead({ email: 'a@acme.test' })).reach)
      .toBeGreaterThan(scoreLead(lead({ phone: '555' })).reach);
  });

  it('scores zero and says so when there is no way to make contact', () => {
    const score = scoreLead(lead({ email: '', phone: '' }));
    expect(score.reach).toBe(0);
    expect(score.reasons.join(' ')).toContain('no way to contact');
  });

  it('caps at its share when both are present', () => {
    expect(scoreLead(lead({ email: 'a@acme.test', phone: '555' })).reach).toBe(MAX_REACH);
  });
});

describe('value — evidence they are actually trading', () => {
  it('separates a busy firm from a silent listing', () => {
    expect(scoreLead(lead({ reviews: 300, rating: 4.8 })).value)
      .toBeGreaterThan(scoreLead(lead({ reviews: 0, rating: null })).value);
  });

  it('says out loud when a listing has no reviews at all', () => {
    expect(scoreLead(lead({ reviews: 0 })).reasons.join(' ')).toContain('may not be trading');
  });

  it('never exceeds its share of the total', () => {
    expect(scoreLead(lead({ reviews: 5000, rating: 5 })).value).toBeLessThanOrEqual(MAX_VALUE);
  });
});

describe('the whole number', () => {
  it('stays inside 0-100 at both extremes', () => {
    const best = scoreLead(lead({ website: '', email: 'a@acme.test', phone: '555', rating: 4.9, reviews: 900 }));
    const worst = scoreLead(lead({ email: '', phone: '', rating: null, reviews: 0 }));
    expect(best.total).toBeLessThanOrEqual(100);
    expect(worst.total).toBeGreaterThanOrEqual(0);
  });

  it('is the sum of its three parts, so the parts explain the whole', () => {
    const s = scoreLead(lead({ website: '', phone: '555', reviews: 40, rating: 4.2 }));
    expect(s.total).toBe(s.opportunity + s.reach + s.value);
  });

  it('always carries at least one reason', () => {
    // A number with no account of itself is a number a salesperson learns to
    // distrust, and a distrusted ranking is the same as no ranking.
    for (const l of [lead(), lead({ website: '' }), lead({ audited: false })]) {
      expect(scoreLead(l).reasons.length).toBeGreaterThan(0);
    }
  });

  it('bands on the boundaries it claims', () => {
    expect(bandOf(70)).toBe('hot');
    expect(bandOf(69)).toBe('warm');
    expect(bandOf(50)).toBe('warm');
    expect(bandOf(49)).toBe('cool');
    expect(bandOf(30)).toBe('cool');
    expect(bandOf(29)).toBe('cold');
  });

  it('ranks a reachable broken firm above an unreachable one', () => {
    // The whole reason the axes are separate. Both have the strongest possible
    // hook; only one of them can be told about it.
    const reachable = scoreLead(lead({ website: '', phone: '555', email: 'a@acme.test', reviews: 50, rating: 4.5 }));
    const not = scoreLead(lead({ website: '', phone: '', email: '', reviews: 50, rating: 4.5 }));
    expect(reachable.total).toBeGreaterThan(not.total);
  });
});

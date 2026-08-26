import { describe, expect, it } from 'vitest';
import { audienceFor, buildHook, checkDate } from '../src/pitch/hooks.ts';
import { toLead } from '../src/lead/signals.ts';
import type { SiteAudit } from '../src/audit/site.ts';
import type { RawPlace } from '../src/places/schema.ts';

/**
 * Opening lines for cold outreach.
 *
 * These go to real businesses who know their own operation better than we do,
 * so the binding rule is that every claim must rest on something the audit
 * actually measured. A line that invents a problem is not a weak email, it is a
 * lost lead and a lost reputation — so "says nothing" must always beat
 * "says something plausible".
 */

const place = (over: Partial<RawPlace> = {}): RawPlace => ({
  id: 'p1',
  displayName: { text: 'Otter Roofing' },
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

const ctx = { niche: 'roofing contractor', checkedOn: '26 Aug' };

describe('audienceFor', () => {
  it('routes a niche to how its customers actually arrive', () => {
    expect(audienceFor('roofing contractor')).toBe('emergency-trade');
    expect(audienceFor('emergency plumber')).toBe('emergency-trade');
    expect(audienceFor('dentist')).toBe('appointment');
    expect(audienceFor('physical therapy clinic')).toBe('appointment');
    expect(audienceFor('law firm')).toBe('professional');
    expect(audienceFor('property management')).toBe('property');
    expect(audienceFor('landscaping company')).toBe('home-services');
  });

  it('falls back rather than guessing at an unknown trade', () => {
    expect(audienceFor('artisanal candle maker')).toBe('general');
    expect(audienceFor('')).toBe('general');
  });
});

describe('the line rests on a measured finding', () => {
  it('leads with no website, and cites the reputation being wasted', () => {
    const lead = toLead(place({ websiteUri: undefined }), audit({ reachable: 'no', error: 'no website listed' }));
    const hook = buildHook(lead, ctx);

    expect(hook.basis).toBe('no-site');
    expect(hook.text).toContain('31 reviews at 4.5 stars');
    expect(hook.text).toContain('no website');
    expect(hook.text).toContain('urgent work');   // the emergency-trade framing
  });

  it('does not flatter a firm whose reputation is one review', () => {
    // "You have a reputation and nowhere to send it" is disprovable at a glance
    // here, so the line must not make that claim at all.
    const lead = toLead(
      place({ websiteUri: undefined, userRatingCount: 1, rating: 5 }),
      audit({ reachable: 'no', error: 'no website listed' }),
    );
    const hook = buildHook(lead, ctx);

    expect(hook.basis).toBe('no-site');
    expect(hook.text).toContain('no website attached');
    expect(hook.text).not.toContain('review');
  });

  it('never writes "1 reviews"', () => {
    // Copy that goes to a stranger cannot have a grammar bug in the first line.
    // Anchored on a word boundary, because "11 reviews" is correct and merely
    // contains the string a naive check would flag.
    for (const count of [1, 2, 11, 21, 31]) {
      const lead = toLead(
        place({ websiteUri: undefined, userRatingCount: count, rating: 4.8 }),
        audit({ reachable: 'no' }),
      );
      expect(buildHook(lead, ctx).text).not.toMatch(/\b1 reviews\b/);
    }
  });

  it('writes "1 review" where a singular is reachable', () => {
    // Only reachable above the thin-reviews bar, which one review is not — so
    // the singular path is proven directly rather than left untested.
    const lead = toLead(place({ websiteUri: undefined, userRatingCount: 1, rating: 5 }), audit({ reachable: 'no' }));
    lead.signals = lead.signals.filter((s) => s !== 'thin-reviews');
    expect(buildHook(lead, ctx).text).toContain('1 review at 5.0 stars');
  });

  it('states an unreachable site with the date it was checked', () => {
    const lead = toLead(place(), audit({ reachable: 'no', ttfbMs: null }));
    const hook = buildHook(lead, ctx);

    expect(hook.basis).toBe('down');
    expect(hook.text).toContain('did not load');
    expect(hook.text).toContain('26 Aug');
  });

  it('quotes the real response time when the site is slow', () => {
    const lead = toLead(place(), audit({ ttfbMs: 4200 }));
    const hook = buildHook(lead, ctx);

    expect(hook.basis).toBe('slow');
    expect(hook.text).toContain('4.2 seconds');
  });

  it('names http rather than describing it vaguely', () => {
    const lead = toLead(place({ websiteUri: 'http://otter.test' }), audit({ https: 'no' }));
    expect(buildHook(lead, ctx).text).toContain('Not secure');
  });

  it('leads with the costliest finding when there are several', () => {
    // Down AND not mobile AND slow — "down" is the one worth the sentence.
    const lead = toLead(place(), audit({ reachable: 'no', mobileViewport: 'no', ttfbMs: 9000 }));
    const hook = buildHook(lead, ctx);

    expect(hook.basis).toBe('down');
    expect(hook.text).not.toContain('phones');
  });
});

describe('it refuses to invent a problem', () => {
  it('says nothing about a prospect whose site is fine', () => {
    const hook = buildHook(toLead(place(), audit()), ctx);

    expect(hook.text).toBe('');
    expect(hook.basis).toBe('none');
    expect(hook.reason).toContain('no gap found');
  });

  it('says nothing about a prospect that was never audited', () => {
    const hook = buildHook(toLead(place(), null), ctx);

    expect(hook.text).toBe('');
    expect(hook.reason).toContain('not audited');
  });

  it('never claims a fault the audit could not determine', () => {
    // Everything unknown — robots blocked us, so we know nothing at all.
    const blocked = audit({
      reachable: 'unknown', https: 'unknown', mobileViewport: 'unknown',
      contactForm: 'unknown', ttfbMs: null, robotsBlocked: true, emails: [],
    });
    const hook = buildHook(toLead(place(), blocked), ctx);
    expect(hook.text).toBe('');
  });

  it('does not treat a thin review count as something to write about', () => {
    // It is a real signal for scoring, but "you have few reviews" is an insult,
    // not an opening, and it is not a thing we would be fixing.
    const lead = toLead(place({ userRatingCount: 2, rating: 5 }), audit());
    expect(buildHook(lead, ctx).text).toBe('');
  });
});

describe('the framing follows the niche', () => {
  const downLead = () => toLead(place(), audit({ reachable: 'no' }));

  it('tells a dentist about bookings and a roofer about urgency', () => {
    const dentist = buildHook(downLead(), { niche: 'dentist', checkedOn: '26 Aug' });
    const roofer = buildHook(downLead(), { niche: 'roofing contractor', checkedOn: '26 Aug' });

    expect(dentist.text).toContain('booking desk');
    expect(roofer.text).toContain('urgent work');
    // Same finding, different consequence — that is the whole point.
    expect(dentist.text).not.toBe(roofer.text);
  });

  it('gives every audience a usable line for the same finding', () => {
    for (const niche of ['plumber', 'dentist', 'law firm', 'property management', 'cleaning service', 'candle shop']) {
      const hook = buildHook(downLead(), { niche, checkedOn: '26 Aug' });
      expect(hook.text.length).toBeGreaterThan(60);
      expect(hook.text).toContain('did not load');
    }
  });
});

describe('checkDate', () => {
  it('formats an audit timestamp the way a person writes a date', () => {
    expect(checkDate('2026-08-26T14:27:26.820Z')).toBe('26 Aug');
    expect(checkDate('2026-01-02T00:00:00.000Z')).toBe('2 Jan');
  });

  it('returns null rather than inventing one', () => {
    expect(checkDate(null)).toBeNull();
    expect(checkDate('')).toBeNull();
    expect(checkDate('not a date')).toBeNull();
  });

  it('omits the date from the line when there is none', () => {
    const lead = toLead(place(), audit({ reachable: 'no' }));
    const hook = buildHook(lead, { niche: 'roofing contractor', checkedOn: null });
    expect(hook.text).toContain('did not load');
    expect(hook.text).not.toContain('undefined');
    expect(hook.text).not.toContain('null');
  });
});

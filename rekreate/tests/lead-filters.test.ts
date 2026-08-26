import { describe, expect, it } from 'vitest';
import { filterLeads, filterPlaces, mergeReports } from '../src/lead/filters.ts';
import type { RawPlace } from '../src/places/schema.ts';
import type { Lead } from '../src/lead/signals.ts';

function place(over: Partial<RawPlace> & { id: string }): RawPlace {
  return { displayName: { text: 'Firm ' + over.id }, ...over };
}

function lead(over: Partial<Lead> & { id: string }): Lead {
  return {
    name: 'Firm', address: '', phone: '', website: '', host: '',
    email: '', emailAlt: [], rating: null, reviews: null,
    businessStatus: '', primaryType: '', lat: null, lng: null,
    reachable: 'unknown', https: 'unknown', ttfb: null, viewport: 'unknown',
    contactForm: 'unknown', finalUrl: '', auditError: '',
    signals: [], audited: true,
    ...over,
  };
}

describe('rating filter — Google\'s 0-5 scale', () => {
  const places = [
    place({ id: 'a', rating: 4.8, userRatingCount: 120 }),
    place({ id: 'b', rating: 3.4, userRatingCount: 50 }),
    place({ id: 'c', rating: 5.0, userRatingCount: 3 }),
  ];

  it('keeps only ratings at or above the bar', () => {
    const { kept } = filterPlaces(places, { minRating: 3.5 });
    expect(kept.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('treats the bar as inclusive', () => {
    const exact = [place({ id: 'x', rating: 4.0 })];
    expect(filterPlaces(exact, { minRating: 4.0 }).kept).toHaveLength(1);
  });

  it('drops unrated businesses by default', () => {
    const mixed = [place({ id: 'a', rating: 4.5 }), place({ id: 'n' })];
    const { kept, report } = filterPlaces(mixed, { minRating: 3.5 });
    expect(kept.map((p) => p.id)).toEqual(['a']);
    expect(report.dropped).toContainEqual({ reason: 'unrated', count: 1 });
  });

  it('keeps unrated businesses when asked — new is not the same as bad', () => {
    const mixed = [place({ id: 'a', rating: 4.5 }), place({ id: 'n' })];
    const { kept } = filterPlaces(mixed, { minRating: 3.5, keepUnrated: true });
    expect(kept.map((p) => p.id)).toEqual(['a', 'n']);
  });
});

describe('review filter — the size proxy', () => {
  const places = [
    place({ id: 'big', rating: 4.4, userRatingCount: 884 }),
    place({ id: 'small', rating: 5.0, userRatingCount: 17 }),
    place({ id: 'none', rating: 4.9 }),
  ];

  it('keeps only well-reviewed businesses', () => {
    const { kept } = filterPlaces(places, { minReviews: 100 });
    expect(kept.map((p) => p.id)).toEqual(['big']);
  });

  it('treats a missing review count as zero', () => {
    const { kept } = filterPlaces(places, { minReviews: 1 });
    expect(kept.map((p) => p.id)).toEqual(['big', 'small']);
  });

  it('combines with the rating bar', () => {
    const { kept } = filterPlaces(places, { minRating: 4.5, minReviews: 10 });
    expect(kept.map((p) => p.id)).toEqual(['small']);
  });
});

describe('website filter', () => {
  it('drops prospects with nothing to audit', () => {
    const places = [
      place({ id: 'has', websiteUri: 'https://acme.com' }),
      place({ id: 'none' }),
    ];
    const { kept, report } = filterPlaces(places, { requireWebsite: true });
    expect(kept.map((p) => p.id)).toEqual(['has']);
    expect(report.dropped).toEqual([{ reason: 'no website', count: 1 }]);
  });
});

describe('email gate — runs after the audit', () => {
  const leads = [
    lead({ id: 'a', email: 'info@acme.com' }),
    lead({ id: 'b' }),
    lead({ id: 'c', email: 'hi@beta.com' }),
  ];

  it('keeps only leads that can actually be contacted', () => {
    const { kept, report } = filterLeads(leads, { requireEmail: true });
    expect(kept.map((l) => l.id)).toEqual(['a', 'c']);
    expect(report.dropped).toEqual([{ reason: 'no email found', count: 1 }]);
  });

  it('passes everything through when the gate is off', () => {
    const { kept, report } = filterLeads(leads, {});
    expect(kept).toHaveLength(3);
    expect(report.dropped).toEqual([]);
  });
});

describe('reporting — a filtered sweep is never silent', () => {
  it('counts every reason separately', () => {
    const places = [
      place({ id: 'keep', rating: 4.8, userRatingCount: 200 }),
      place({ id: 'lowRating', rating: 2.1, userRatingCount: 200 }),
      place({ id: 'fewReviews', rating: 4.9, userRatingCount: 2 }),
      place({ id: 'unrated' }),
    ];
    const { report } = filterPlaces(places, { minRating: 3.5, minReviews: 10 });

    expect(report.considered).toBe(4);
    expect(report.kept).toBe(1);
    expect(report.dropped).toEqual(
      expect.arrayContaining([
        { reason: 'rating below minimum', count: 1 },
        { reason: 'too few reviews', count: 1 },
        { reason: 'unrated', count: 1 },
      ]),
    );
  });

  it('merges both passes into one honest total', () => {
    const pre = { considered: 216, kept: 80, dropped: [{ reason: 'unrated' as const, count: 136 }] };
    const post = { considered: 80, kept: 42, dropped: [{ reason: 'no email found' as const, count: 38 }] };
    const merged = mergeReports(pre, post);

    // 216 went in, 42 came out — the number the user actually needs.
    expect(merged.considered).toBe(216);
    expect(merged.kept).toBe(42);
    expect(merged.dropped[0]).toEqual({ reason: 'unrated', count: 136 });
  });

  it('an empty filter changes nothing and reports nothing', () => {
    const places = [place({ id: 'a' }), place({ id: 'b' })];
    const { kept, report } = filterPlaces(places, {});
    expect(kept).toHaveLength(2);
    expect(report.dropped).toEqual([]);
  });
});

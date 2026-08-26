import { describe, expect, it } from 'vitest';
import { leadToEnrichedRow, parseEnrichedCsv, renderEnrichedCsv } from '../src/export/csv.ts';
import { parseSearchBaseName, searchBaseName } from '../src/export/search-file.ts';
import { toLead } from '../src/lead/signals.ts';
import { isTooSmallToSweep, MIN_SWEEPABLE_SPAN_DEG } from '../src/places/geocode.ts';
import type { SiteAudit } from '../src/audit/site.ts';
import type { RawPlace } from '../src/places/schema.ts';

/**
 * Reopening a saved search. Every run already wrote its own file, but nothing
 * could read one back, so a refresh looked exactly like losing results that
 * cost real API calls — and the only way back was to pay for the sweep again.
 */

const PLACE: RawPlace = {
  id: 'ChIJ_test',
  displayName: { text: 'Smith, Jones & Co "Roofing"' },
  formattedAddress: '12 Main St, Camden, NJ',
  nationalPhoneNumber: '(856) 555-0100',
  websiteUri: 'https://smithjones.test/roofing',
  rating: 4.4,
  userRatingCount: 52,
  businessStatus: 'OPERATIONAL',
  primaryType: 'roofing_contractor',
  location: { latitude: 39.9345511, longitude: -75.1189862 },
};

const AUDIT: SiteAudit = {
  placeId: 'ChIJ_test',
  inputUrl: 'https://smithjones.test/roofing',
  finalUrl: 'https://smithjones.test/roofing',
  reachable: 'yes',
  https: 'yes',
  ttfbMs: 3100,
  mobileViewport: 'no',
  contactForm: 'yes',
  emails: ['info@smithjones.test', 'sales@smithjones.test'],
  pagesFetched: 1,
  httpStatus: 200,
  error: null,
  robotsBlocked: false,
};

const roundTrip = (lead: ReturnType<typeof toLead>): ReturnType<typeof parseEnrichedCsv> =>
  parseEnrichedCsv(renderEnrichedCsv([leadToEnrichedRow(lead, '2026-08-26T10:00:00.000Z')]));

describe('parseEnrichedCsv', () => {
  it('round-trips every field a lead carries', () => {
    const original = toLead(PLACE, AUDIT);
    const back = roundTrip(original)[0]!;

    expect(back.id).toBe(original.id);
    expect(back.name).toBe('Smith, Jones & Co "Roofing"'); // survived the quoting
    expect(back.address).toBe(original.address);
    expect(back.phone).toBe(original.phone);
    expect(back.website).toBe(original.website);
    expect(back.host).toBe(original.host);
    expect(back.email).toBe('info@smithjones.test');
    expect(back.emailAlt).toEqual(['sales@smithjones.test']);
    expect(back.rating).toBe(4.4);
    expect(back.reviews).toBe(52);
    expect(back.businessStatus).toBe('OPERATIONAL');
    expect(back.primaryType).toBe('roofing_contractor');
    expect(back.lat).toBeCloseTo(39.9345511, 6);
    expect(back.lng).toBeCloseTo(-75.1189862, 6);
    expect(back.reachable).toBe('yes');
    expect(back.https).toBe('yes');
    expect(back.ttfb).toBe(3100);
    expect(back.viewport).toBe('no');
    expect(back.contactForm).toBe('yes');
    expect(back.finalUrl).toBe(original.finalUrl);
    expect(back.audited).toBe(true);
  });

  it('re-derives the same signals rather than storing them', () => {
    const original = toLead(PLACE, AUDIT);
    expect(roundTrip(original)[0]!.signals).toEqual(original.signals);
    // Sanity: this fixture really does carry signals to compare.
    expect(original.signals).toContain('no-viewport');
    expect(original.signals).toContain('slow');
  });

  it('knows an un-audited row from an audited one', () => {
    expect(roundTrip(toLead(PLACE, null))[0]!.audited).toBe(false);
    expect(roundTrip(toLead(PLACE, AUDIT))[0]!.audited).toBe(true);
  });

  it('does not invent a no-email signal for a row never audited', () => {
    const back = roundTrip(toLead(PLACE, null))[0]!;
    expect(back.signals).not.toContain('no-email');
  });

  it('reads a place with no optional fields', () => {
    const back = roundTrip(toLead({ id: 'bare' }, null))[0]!;
    expect(back.id).toBe('bare');
    expect(back.rating).toBeNull();
    expect(back.lat).toBeNull();
    expect(back.ttfb).toBeNull();
  });

  it('locates columns by name, so an older file still loads', () => {
    const csv = 'place_id,name,rating\r\nabc,Old Format Co,3.9\r\n';
    const back = parseEnrichedCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]!.name).toBe('Old Format Co');
    expect(back[0]!.rating).toBe(3.9);
    expect(back[0]!.audited).toBe(false);
  });

  it('returns nothing for a file that is not a lead export', () => {
    expect(parseEnrichedCsv('a,b,c\r\n1,2,3\r\n')).toEqual([]);
    expect(parseEnrichedCsv('')).toEqual([]);
  });
});

describe('parseSearchBaseName', () => {
  it('reads back what searchBaseName wrote', () => {
    const name = searchBaseName('2026-08-26T14:27:26.820Z', 'Camden, NJ, USA', 'roofing contractor');
    const parsed = parseSearchBaseName(`${name}.csv`)!;

    expect(parsed.location).toBe('camden nj usa');
    expect(parsed.niche).toBe('roofing contractor');
    expect(parsed.when).toBe('2026-08-26T14:27:26.000Z');
  });

  it('ignores the collision suffix', () => {
    const parsed = parseSearchBaseName('20260826-142726_camden-nj_roofing-2.csv')!;
    expect(parsed.niche).toBe('roofing');
  });

  it('returns null for a name it does not recognise', () => {
    expect(parseSearchBaseName('leads.csv')).toBeNull();
    expect(parseSearchBaseName('notes.txt')).toBeNull();
  });
});

describe('isTooSmallToSweep', () => {
  it('rejects a single business viewport', () => {
    // Google's viewport for one shop is roughly 150m across.
    expect(isTooSmallToSweep(0.0014, 0.0018)).toBe(true);
  });

  it('accepts a town, a city and a county', () => {
    expect(isTooSmallToSweep(0.05, 0.06)).toBe(false);   // small town
    expect(isTooSmallToSweep(0.27, 0.32)).toBe(false);   // Philadelphia
    expect(isTooSmallToSweep(0.76, 0.89)).toBe(false);   // metro
  });

  it('accepts a box that is narrow in one axis only', () => {
    // A coastal strip or a long thin postal district is still sweepable.
    expect(isTooSmallToSweep(0.001, 0.4)).toBe(false);
  });

  it('sits well clear of both cases', () => {
    expect(MIN_SWEEPABLE_SPAN_DEG).toBeGreaterThan(0.002);
    expect(MIN_SWEEPABLE_SPAN_DEG).toBeLessThan(0.02);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ENRICHED_COLUMNS,
  leadToEnrichedRow,
  parseCsv,
  renderEnrichedCsv,
} from '../src/export/csv.ts';
import { toLead } from '../src/lead/signals.ts';
import type { SiteAudit } from '../src/audit/site.ts';
import type { RawPlace } from '../src/places/schema.ts';

/**
 * The dashboard built its CSV rows inline and passed `''` for business status,
 * type, latitude and longitude, and `null` for the final URL and the audit
 * error — six declared columns that were always empty, in the file that is the
 * whole record of a paid run. Rows are built in one place now, and these tests
 * read the output by column NAME so a positional slip cannot pass either.
 */

const PLACE: RawPlace = {
  id: 'ChIJ_test',
  displayName: { text: 'Otter Property Management, Inc.' },
  formattedAddress: '12 Main St, Philadelphia, PA',
  nationalPhoneNumber: '(215) 555-0100',
  websiteUri: 'http://otter.test',
  rating: 4.6,
  userRatingCount: 73,
  businessStatus: 'OPERATIONAL',
  primaryType: 'real_estate_agency',
  types: ['real_estate_agency', 'point_of_interest'],
  location: { latitude: 39.9526, longitude: -75.1652 },
};

const AUDIT: SiteAudit = {
  placeId: 'ChIJ_test',
  inputUrl: 'http://otter.test',
  finalUrl: 'https://www.otter.test/',
  reachable: 'yes',
  https: 'yes',
  ttfbMs: 412,
  mobileViewport: 'no',
  contactForm: 'yes',
  emails: ['info@otter.test', 'leasing@otter.test'],
  pagesFetched: 2,
  httpStatus: 200,
  error: null,
  robotsBlocked: false,
};

/** Read a rendered CSV back as objects keyed by header, the way a user sees it. */
function readBack(csv: string): Record<string, string>[] {
  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  return rows.slice(1).map((row) => {
    const out: Record<string, string> = {};
    header.forEach((name, i) => {
      out[name] = row[i] ?? '';
    });
    return out;
  });
}

describe('leadToEnrichedRow', () => {
  it('carries every column the header declares', () => {
    const lead = toLead(PLACE, AUDIT);
    const csv = renderEnrichedCsv([leadToEnrichedRow(lead, '2026-08-26T10:00:00.000Z')]);
    const row = readBack(csv)[0]!;

    expect(row['place_id']).toBe('ChIJ_test');
    expect(row['name']).toBe('Otter Property Management, Inc.');
    expect(row['address']).toBe('12 Main St, Philadelphia, PA');
    expect(row['phone']).toBe('(215) 555-0100');
    expect(row['website']).toBe('http://otter.test');
    expect(row['rating']).toBe('4.6');
    expect(row['review_count']).toBe('73');

    // The six that were always blank.
    expect(row['business_status']).toBe('OPERATIONAL');
    expect(row['primary_type']).toBe('real_estate_agency');
    expect(row['latitude']).toBe('39.9526');
    expect(row['longitude']).toBe('-75.1652');
    expect(row['final_url']).toBe('https://www.otter.test/');
    expect(row['audit_error']).toBe('');

    expect(row['google_refreshed_at']).toBe('2026-08-26T10:00:00.000Z');
    expect(row['email']).toBe('info@otter.test');
    expect(row['email_alt']).toBe('leasing@otter.test');
    expect(row['reachable']).toBe('yes');
    expect(row['https']).toBe('yes');
    expect(row['ttfb_ms']).toBe('412');
    expect(row['mobile_viewport']).toBe('no');
    expect(row['contact_form']).toBe('yes');
  });

  it('records an audit error where the export can show it', () => {
    const failed: SiteAudit = { ...AUDIT, emails: [], error: 'timeout after 9000ms' };
    const csv = renderEnrichedCsv([leadToEnrichedRow(toLead(PLACE, failed), 'now')]);
    expect(readBack(csv)[0]!['audit_error']).toBe('timeout after 9000ms');
  });

  it('leaves derived columns empty for a prospect that was never audited', () => {
    const csv = renderEnrichedCsv([leadToEnrichedRow(toLead(PLACE, null), 'now')]);
    const row = readBack(csv)[0]!;

    // Google's own fields survive; ours stay honestly blank rather than
    // claiming a site was checked and found wanting.
    expect(row['business_status']).toBe('OPERATIONAL');
    expect(row['latitude']).toBe('39.9526');
    expect(row['reachable']).toBe('unknown');
    expect(row['final_url']).toBe('');
    expect(row['email']).toBe('');
  });

  it('emits exactly one cell per declared column', () => {
    const csv = renderEnrichedCsv([leadToEnrichedRow(toLead(PLACE, AUDIT), 'now')]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...ENRICHED_COLUMNS]);
    expect(rows[1]).toHaveLength(ENRICHED_COLUMNS.length);
  });

  it('quotes a business name containing a comma so columns cannot shift', () => {
    const place: RawPlace = { ...PLACE, displayName: { text: 'Smith, Jones & Co "The Best"' } };
    const csv = renderEnrichedCsv([leadToEnrichedRow(toLead(place, AUDIT), 'now')]);
    const row = readBack(csv)[0]!;
    expect(row['name']).toBe('Smith, Jones & Co "The Best"');
    expect(row['address']).toBe('12 Main St, Philadelphia, PA');
  });

  it('handles a place with none of the optional Google fields', () => {
    const csv = renderEnrichedCsv([leadToEnrichedRow(toLead({ id: 'bare' }, null), 'now')]);
    const row = readBack(csv)[0]!;
    expect(row['place_id']).toBe('bare');
    expect(row['name']).toBe('(unnamed)');
    expect(row['rating']).toBe('');
    expect(row['latitude']).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { ENRICHED_COLUMNS, LEAD_COLUMNS, parseCsv, parseEnrichedCsv, renderEnrichedCsv } from '../src/export/csv.ts';
import type { EnrichedRow } from '../src/export/csv.ts';

/**
 * Re-auditing an already-enriched CSV must produce the same shape as auditing a
 * raw harvest — because refreshing a saved search is the normal way to use this,
 * and getting it wrong is silent.
 *
 * The bug: the audit CLI passed the whole input row as `base`. On a raw harvest
 * that is 12 columns and the output is a correct 21. On an already-enriched file
 * it is 21, so renderEnrichedCsv appended the nine audit columns a SECOND time —
 * 30 fields under a 21-column header. parseEnrichedCsv reads by header position,
 * so every later read returned the STALE audit and discarded the fresh one. A
 * whole re-audit of 216 leads came back byte-identical to the run it replaced,
 * and nothing anywhere reported a problem.
 */

/** The projection the audit command performs: harvest columns, selected by name. */
function project(header: string[], row: string[]): string[] {
  return LEAD_COLUMNS.map((column) => {
    const idx = header.indexOf(column);
    return idx === -1 ? '' : row[idx] ?? '';
  });
}

const AUDIT: Omit<EnrichedRow, 'base'> = {
  emails: ['fresh@acme.test'],
  reachable: 'yes',
  https: 'yes',
  ttfbMs: 96,
  mobileViewport: 'yes',
  contactForm: 'yes',
  finalUrl: 'https://acme.test/',
  error: null,
  score: 40,
};

const HARVEST_ROW = [
  'place1', 'Acme', '1 Main St', '555', 'http://acme.test/', '4.2', '134',
  'OPERATIONAL', 'service', '40.0', '-75.0', '2026-08-25T00:00:00.000Z',
];

describe('the enriched CSV keeps one shape however it was produced', () => {
  it('writes exactly the declared number of columns from a raw harvest', () => {
    const rows: EnrichedRow[] = [{ base: HARVEST_ROW, ...AUDIT }];
    const parsed = parseCsv(renderEnrichedCsv(rows));

    expect(parsed[0]).toHaveLength(ENRICHED_COLUMNS.length);
    expect(parsed[1]).toHaveLength(ENRICHED_COLUMNS.length);
  });

  it('writes the same width when the input was ALREADY enriched', () => {
    // Round one: harvest -> enriched.
    const first = renderEnrichedCsv([{ base: HARVEST_ROW, ...AUDIT }]);
    const firstRows = parseCsv(first);
    const header = firstRows[0]!;

    // Round two: feed that output back in, exactly as `audit -i <enriched>` does.
    const reaudited = renderEnrichedCsv([
      { base: project(header, firstRows[1]!), ...AUDIT, emails: ['second@acme.test'] },
    ]);
    const secondRows = parseCsv(reaudited);

    expect(secondRows[0]).toHaveLength(ENRICHED_COLUMNS.length);
    expect(secondRows[1]).toHaveLength(ENRICHED_COLUMNS.length);
  });

  it('surfaces the FRESH audit on re-audit, not the stale one it replaced', () => {
    const first = renderEnrichedCsv([
      { base: HARVEST_ROW, ...AUDIT, emails: ['stale@acme.test'], reachable: 'no', error: 'timeout after 9000ms' },
    ]);
    const firstRows = parseCsv(first);
    const header = firstRows[0]!;

    const reaudited = renderEnrichedCsv([
      { base: project(header, firstRows[1]!), ...AUDIT, emails: ['fresh@acme.test'] },
    ]);

    const leads = parseEnrichedCsv(reaudited);
    expect(leads[0]?.email).toBe('fresh@acme.test');
    expect(leads[0]?.reachable).toBe('yes');
    expect(leads[0]?.auditError).toBe('');
  });

  it('preserves the harvest facts across a re-audit', () => {
    // The Google-sourced columns are a cache, not something the audit may lose.
    const first = renderEnrichedCsv([{ base: HARVEST_ROW, ...AUDIT }]);
    const firstRows = parseCsv(first);
    const reaudited = renderEnrichedCsv([
      { base: project(firstRows[0]!, firstRows[1]!), ...AUDIT },
    ]);

    const leads = parseEnrichedCsv(reaudited);
    expect(leads[0]?.id).toBe('place1');
    expect(leads[0]?.name).toBe('Acme');
    expect(leads[0]?.rating).toBe(4.2);
    expect(leads[0]?.reviews).toBe(134);
  });
});

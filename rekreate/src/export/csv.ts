import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RawPlace } from '../places/schema.ts';
import { withDerived } from '../lead/signals.ts';
import type { Lead } from '../lead/signals.ts';

/**
 * The columns, in the order they appear in the file. Kept identical to the
 * Sheets export so the two never drift.
 */
export const LEAD_COLUMNS = [
  'place_id',
  'name',
  'address',
  'phone',
  'website',
  'rating',
  'review_count',
  'business_status',
  'primary_type',
  'latitude',
  'longitude',
  'google_refreshed_at',
] as const;

/**
 * RFC 4180 quoting. A field is quoted when it contains a comma, a quote or a
 * newline; embedded quotes are doubled. Business names routinely contain
 * commas ("Smith, Jones & Co"), so this is not a formality.
 */
function escapeCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

export function toRow(place: RawPlace, refreshedAt: string): string[] {
  return [
    place.id,
    place.displayName?.text ?? '',
    place.formattedAddress ?? '',
    place.nationalPhoneNumber ?? '',
    place.websiteUri ?? '',
    place.rating?.toString() ?? '',
    place.userRatingCount?.toString() ?? '',
    place.businessStatus ?? '',
    place.primaryType ?? '',
    place.location?.latitude?.toString() ?? '',
    place.location?.longitude?.toString() ?? '',
    refreshedAt,
  ];
}

export function renderCsv(places: RawPlace[], refreshedAt: string): string {
  const rows = [
    LEAD_COLUMNS.join(','),
    ...places.map((p) => toRow(p, refreshedAt).map(escapeCell).join(',')),
  ];
  // Trailing newline: without it, some tools drop the final row.
  return `${rows.join('\r\n')}\r\n`;
}

export async function writeCsv(
  path: string,
  places: RawPlace[],
  refreshedAt: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // BOM so Excel opens UTF-8 business names correctly instead of mojibake.
  await writeFile(path, `﻿${renderCsv(places, refreshedAt)}`, 'utf8');
}

/** RFC 4180 reader — the inverse of escapeCell, quoted fields and all. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const body = text.replace(/^﻿/, '');

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }

  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Harvest columns plus everything the audit stage discovered. */
export const ENRICHED_COLUMNS = [
  ...LEAD_COLUMNS,
  'email',
  'email_alt',
  'reachable',
  'https',
  'ttfb_ms',
  'mobile_viewport',
  'contact_form',
  'final_url',
  'audit_error',
  // Derived, not measured — last, so every column that records a fact comes
  // before every column that interprets one.
  'score',
] as const;

export type EnrichedRow = {
  base: string[];
  emails: string[];
  reachable: string;
  https: string;
  ttfbMs: number | null;
  mobileViewport: string;
  contactForm: string;
  finalUrl: string | null;
  error: string | null;
  score: number;
};

/**
 * A lead, as the enriched CSV wants it — the single place that maps one to the
 * other, so the CLI's export and the dashboard's cannot drift into disagreeing
 * about what a column means. The dashboard used to build this inline and pass
 * `''` for business status, type, latitude and longitude, and `null` for the
 * final URL and the audit error: six columns of header with nothing ever under
 * them, in a file whose whole job is to be the record of the run.
 */
export function leadToEnrichedRow(lead: Lead, refreshedAt: string): EnrichedRow {
  return {
    // Order matters — this is LEAD_COLUMNS, positionally.
    base: [
      lead.id,
      lead.name,
      lead.address,
      lead.phone,
      lead.website,
      lead.rating?.toString() ?? '',
      lead.reviews?.toString() ?? '',
      lead.businessStatus,
      lead.primaryType,
      lead.lat?.toString() ?? '',
      lead.lng?.toString() ?? '',
      refreshedAt,
    ],
    emails: lead.email ? [lead.email, ...lead.emailAlt] : [],
    reachable: lead.reachable,
    https: lead.https,
    ttfbMs: lead.ttfb,
    mobileViewport: lead.viewport,
    contactForm: lead.contactForm,
    finalUrl: lead.finalUrl || null,
    error: lead.auditError || null,
    score: lead.score.total,
  };
}

/**
 * Score a row the CLI's audit stage assembled positionally.
 *
 * That command works from a harvest CSV rather than from RawPlace objects, so
 * it never holds a Lead to score. Rebuilding the facts here — from the same
 * LEAD_COLUMNS order the row was written in — routes it through `withDerived`
 * like every other path, rather than giving the CLI a private copy of the
 * weights that would drift the first time one of them changed.
 */
export function scoreEnrichedRow(row: Omit<EnrichedRow, 'score'>): number {
  const at = (name: (typeof LEAD_COLUMNS)[number]): string =>
    row.base[LEAD_COLUMNS.indexOf(name)] ?? '';
  const num = (value: string): number | null => {
    if (value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const website = at('website');

  return withDerived({
    id: at('place_id'),
    name: at('name'),
    address: at('address'),
    phone: at('phone'),
    website,
    host: website ? website.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '',
    email: row.emails[0] ?? '',
    emailAlt: row.emails.slice(1),
    rating: num(at('rating')),
    reviews: num(at('review_count')),
    businessStatus: at('business_status'),
    primaryType: at('primary_type'),
    lat: num(at('latitude')),
    lng: num(at('longitude')),
    reachable: row.reachable,
    https: row.https,
    ttfb: row.ttfbMs,
    viewport: row.mobileViewport,
    contactForm: row.contactForm,
    finalUrl: row.finalUrl ?? '',
    auditError: row.error ?? '',
    // This function is only ever reached from the audit command, which has just
    // visited the site.
    audited: true,
  }).score.total;
}

export function renderEnrichedCsv(rows: EnrichedRow[]): string {
  const lines = [
    ENRICHED_COLUMNS.join(','),
    ...rows.map((r) =>
      [
        ...r.base,
        r.emails[0] ?? '',
        r.emails.slice(1).join(' '),
        r.reachable,
        r.https,
        r.ttfbMs?.toString() ?? '',
        r.mobileViewport,
        r.contactForm,
        r.finalUrl ?? '',
        r.error ?? '',
        r.score.toString(),
      ]
        .map(escapeCell)
        .join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function writeEnrichedCsv(path: string, rows: EnrichedRow[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `﻿${renderEnrichedCsv(rows)}`, 'utf8');
}

/**
 * Read a saved search back into leads — the inverse of `leadToEnrichedRow`.
 *
 * Every run already lands in `out/searches/`, but nothing could read one back,
 * so a refresh threw away results that cost real API calls. Columns are located
 * by NAME, not position, so a file written by an older version still loads.
 */
export function parseEnrichedCsv(text: string): Lead[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header || header.indexOf('place_id') === -1) return [];

  const at = (row: string[], column: string): string => {
    const index = header.indexOf(column);
    return index === -1 ? '' : (row[index] ?? '');
  };
  const num = (value: string): number | null => {
    if (value.trim() === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  return rows.slice(1).map((row) => {
    const website = at(row, 'website');
    const email = at(row, 'email');
    const alt = at(row, 'email_alt').split(' ').filter(Boolean);
    const reachable = at(row, 'reachable') || 'unknown';
    const finalUrl = at(row, 'final_url');

    const base = {
      id: at(row, 'place_id'),
      name: at(row, 'name') || '(unnamed)',
      address: at(row, 'address'),
      phone: at(row, 'phone'),
      website,
      host: website ? website.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '',
      email,
      emailAlt: alt,
      rating: num(at(row, 'rating')),
      reviews: num(at(row, 'review_count')),
      businessStatus: at(row, 'business_status'),
      primaryType: at(row, 'primary_type'),
      lat: num(at(row, 'latitude')),
      lng: num(at(row, 'longitude')),
      reachable,
      https: at(row, 'https') || 'unknown',
      ttfb: num(at(row, 'ttfb_ms')),
      viewport: at(row, 'mobile_viewport') || 'unknown',
      contactForm: at(row, 'contact_form') || 'unknown',
      finalUrl,
      auditError: at(row, 'audit_error'),
      // Not a stored column. A row the audit never touched has no verdict on
      // any of these; one it did has at least a verdict on reachability.
      audited: reachable !== 'unknown' || finalUrl !== '' || email !== '',
    };

    return withDerived(base);
  });
}

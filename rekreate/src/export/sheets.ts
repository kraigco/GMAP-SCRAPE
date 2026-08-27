import { buildHook, checkDate } from '../pitch/hooks.ts';
import type { Lead } from '../lead/signals.ts';

/**
 * Push leads into the spreadsheet through its own Apps Script.
 *
 * The script is bound to the sheet and runs as its owner, so there is no
 * service-account key to create (an org policy forbids that here), no OAuth
 * client, and no browser consent to renew. What replaces all of it is one URL
 * and one shared secret.
 *
 * Rows are upserted on place_id by the script, so this can be called after
 * every scrape without ever producing a duplicate.
 */

/** One prospect, in the shape `Code.gs` reads. Field names are the contract. */
export type SheetLead = {
  id: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  emailAlt: string[];
  website: string;
  rating: number | null;
  reviews: number | null;
  signals: string[];
  reachable: string;
  https: string;
  ttfb: number | null;
  viewport: string;
  contactForm: string;
  businessStatus: string;
  primaryType: string;
  lat: number | null;
  lng: number | null;
  finalUrl: string;
  auditError: string;
  niche: string;
  searchLocation: string;
  googleRefreshedAt: string;
  /** The opening line, derived from what the audit measured. Empty when nothing honest could be said. */
  hook: string;
  hookBasis: string;
};

export type SheetRun = {
  finishedAt: string;
  location: string;
  niche: string;
  terms: string[];
  prospects: number;
  withEmail: number;
  tilesSearched: number;
  tilesSplit: number;
  callsUsed: number;
  maxCalls: number;
  estimatedCostUsd: number;
  duplicatesDropped: number;
  halted: boolean;
  aborted: boolean;
  file: string;
};

export type IngestResult = {
  ok: boolean;
  inserted: number;
  updated: number;
  total: number | null;
  error: string | null;
  /** Internal: the failure might clear on its own, so the caller may try again. */
  retryable?: boolean;
};

const HTML_RESPONSE = 'the Web App returned a page instead of a result';

export type SheetsTarget = {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Leads per request. Kept well under Apps Script's limits. */
  batchSize?: number;
  /** Attempts per batch before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Where the run's own facts come from, since a Lead carries none of them. */
export type PushContext = { niche: string; location: string; refreshedAt: string };

export function toSheetLead(lead: Lead, context: PushContext): SheetLead {
  const hook = buildHook(lead, {
    niche: context.niche,
    checkedOn: checkDate(context.refreshedAt),
  });

  return {
    id: lead.id,
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    email: lead.email,
    emailAlt: lead.emailAlt,
    website: lead.website,
    rating: lead.rating,
    reviews: lead.reviews,
    signals: lead.signals,
    reachable: lead.reachable,
    https: lead.https,
    ttfb: lead.ttfb,
    viewport: lead.viewport,
    contactForm: lead.contactForm,
    businessStatus: lead.businessStatus,
    primaryType: lead.primaryType,
    lat: lead.lat,
    lng: lead.lng,
    finalUrl: lead.finalUrl,
    auditError: lead.auditError,
    niche: context.niche,
    searchLocation: context.location,
    googleRefreshedAt: context.refreshedAt,
    hook: hook.text,
    // When there is no hook, the cell says WHY rather than sitting blank — a
    // lead with no gap needs a different approach, not a silent gap in the sheet.
    hookBasis: hook.text ? hook.basis : (hook.reason ?? 'none'),
  };
}

/** True when both settings are present. Absent is a valid state, not an error. */
export function isConfigured(url: string | undefined, token: string | undefined): boolean {
  return Boolean(url && url.trim() && token && token.trim());
}

const failure = (error: string): IngestResult => ({
  ok: false,
  inserted: 0,
  updated: 0,
  total: null,
  error,
});

/**
 * Read one response.
 *
 * An Apps Script web app answers 200 to everything — a thrown error, a bad
 * token and a clean write all arrive with the same status — so the verdict is
 * in the body and the status is nearly meaningless. The one case worth naming
 * precisely is an HTML body: that is Google's sign-in page, which means the
 * deployment's "Who has access" is not set to Anyone, and no amount of retrying
 * will change it.
 */
async function readResult(res: Response, attemptsLeft: number): Promise<IngestResult> {
  const text = await res.text();
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);

  if (looksLikeHtml) {
    // Google serves an interstitial here for two very different reasons: a
    // deployment that genuinely requires a sign-in, and a momentary hiccup
    // under back-to-back requests. They are indistinguishable from the body,
    // so the retry decides which one it was — and only a failure that survives
    // every attempt gets blamed on configuration.
    if (attemptsLeft > 0) return { ...failure(HTML_RESPONSE), retryable: true };
    return failure(
      'the Web App returned a sign-in page on every attempt. In Apps Script, ' +
        'redeploy with "Who has access" set to Anyone — with anything else, only a ' +
        'signed-in browser can reach it, and this is a script.',
    );
  }

  let body: { ok?: boolean; inserted?: number; updated?: number; total?: number; error?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return failure(`the Web App returned something that is not JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!body.ok) return failure(body.error ?? 'the Web App reported a failure with no reason');

  return {
    ok: true,
    inserted: body.inserted ?? 0,
    updated: body.updated ?? 0,
    total: body.total ?? null,
    error: null,
  };
}

/**
 * Send leads to the sheet, in batches.
 *
 * Never throws. A sheet that cannot be reached must not lose a scrape that has
 * already been paid for in API calls, so every failure comes back as a result
 * the caller can report and move past.
 */
export async function pushLeads(
  leads: SheetLead[],
  run: SheetRun | null,
  target: SheetsTarget,
): Promise<IngestResult> {
  if (!isConfigured(target.url, target.token)) {
    return failure('SHEETS_WEBAPP_URL or SHEETS_INGEST_TOKEN is not set');
  }
  if (leads.length === 0 && !run) {
    return { ok: true, inserted: 0, updated: 0, total: null, error: null };
  }

  const doFetch = target.fetchImpl ?? fetch;
  const batchSize = Math.max(1, target.batchSize ?? 400);
  const batches: SheetLead[][] = [];
  for (let i = 0; i < leads.length; i += batchSize) batches.push(leads.slice(i, i + batchSize));
  if (batches.length === 0) batches.push([]);

  let inserted = 0;
  let updated = 0;
  let total: number | null = null;

  const maxRetries = Math.max(0, target.maxRetries ?? 3);
  const sleep = target.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 0; i < batches.length; i += 1) {
    // The run ledger goes with the last batch, so a run is recorded only once
    // and only after its leads are in.
    const isLast = i === batches.length - 1;
    const payload = JSON.stringify({
      token: target.token,
      leads: batches[i],
      run: isLast ? run : null,
    });

    let result: IngestResult | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptsLeft = maxRetries - attempt;

      let res: Response | null = null;
      try {
        res = await doFetch(target.url, {
          method: 'POST',
          // Apps Script serves the real response behind a 302 to
          // script.googleusercontent.com; following it is how this works at all.
          redirect: 'follow',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = attemptsLeft > 0
          ? { ...failure(message), retryable: true }
          : failure(`could not reach the Web App: ${message}`);
      }

      if (res) result = await readResult(res, attemptsLeft);
      if (!result || result.ok || !result.retryable) break;

      // Upserting is idempotent, so a retry can only ever re-write rows it
      // already wrote — never duplicate them.
      await sleep(1000 * 2 ** attempt);
    }

    if (!result || !result.ok) return result ?? failure('no response');

    inserted += result.inserted;
    updated += result.updated;
    total = result.total;
  }

  return { ok: true, inserted, updated, total, error: null };
}

/** A one-line summary for a log or a toast. */
export function describeResult(result: IngestResult): string {
  if (!result.ok) return `sheet not updated — ${result.error ?? 'unknown error'}`;
  const parts = [`${result.inserted} added`, `${result.updated} updated`];
  if (result.total !== null) parts.push(`${result.total} in the sheet`);
  return parts.join(', ');
}

/** One lead as it comes back from the sheet, plus when it was first collected. */
export type StoredLead = Lead & {
  /** ISO date this prospect was first seen by any scrape, or '' if unrecorded. */
  collectedAt: string;
  /** ISO date the scraper last refreshed it. */
  lastSeen: string;
  reviewStatus: string;
  notes: string;
  hook: string;
  hookBasis: string;
};

export type StoredLeadsResult = {
  ok: boolean;
  leads: StoredLead[];
  /** Rows in the sheet, which may exceed the page returned. */
  total: number;
  error: string | null;
};

/**
 * Map one sheet row onto a lead, BY COLUMN NAME.
 *
 * Positional mapping is the obvious version and the wrong one: a column
 * inserted in the middle of the sheet would quietly shift every later field one
 * place, and the symptom is a phone number rendered as a rating rather than an
 * error anyone would notice. Reading the header the sheet actually sent means a
 * renamed or missing column produces an empty field, which is visible.
 */
export function rowToStoredLead(columns: string[], row: unknown[]): StoredLead | null {
  const at = (name: string): string => {
    const i = columns.indexOf(name);
    const v = i === -1 ? '' : row[i];
    return v === null || v === undefined ? '' : String(v);
  };
  const num = (name: string): number | null => {
    const raw = at(name);
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const id = at('place_id');
  // A row with no key is not a lead. Rendering it would put a blank line in the
  // table that no selection or push could ever address.
  if (!id) return null;

  const website = at('website');
  const emailAlt = at('email_alt').split(/\s+/).filter(Boolean);

  return {
    id,
    name: at('name'),
    address: at('address'),
    phone: at('phone'),
    website,
    host: website ? website.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '',
    email: at('email'),
    emailAlt,
    rating: num('rating'),
    reviews: num('reviews'),
    businessStatus: at('business_status'),
    primaryType: at('primary_type'),
    lat: num('latitude'),
    lng: num('longitude'),
    reachable: at('reachable'),
    https: at('https'),
    ttfb: num('ttfb_ms'),
    viewport: at('mobile_viewport'),
    contactForm: at('contact_form'),
    finalUrl: at('final_url'),
    auditError: at('audit_error'),
    signals: at('signals').split(/\s+/).filter(Boolean) as Lead['signals'],
    // 'reachable' is only ever written by the audit, so its presence is the
    // record that an audit happened. Defaulting this to true would let a
    // never-audited row claim a clean bill of health it never earned.
    audited: at('reachable') !== '',
    collectedAt: at('first_listed'),
    lastSeen: at('last_seen'),
    reviewStatus: at('review_status'),
    notes: at('notes'),
    hook: at('hook'),
    hookBasis: at('hook_basis'),
  };
}

/**
 * Read leads back out of the sheet.
 *
 * Never throws, for the same reason pushLeads does not: the dashboard showing
 * an empty table is a worse outcome than it showing an error, but both are far
 * better than the page failing to load at all.
 */
export async function fetchStoredLeads(
  target: SheetsTarget,
  opts: { limit?: number; offset?: number } = {},
): Promise<StoredLeadsResult> {
  const empty = (error: string | null): StoredLeadsResult => ({
    ok: error === null,
    leads: [],
    total: 0,
    error,
  });

  if (!isConfigured(target.url, target.token)) {
    return empty('SHEETS_WEBAPP_URL and SHEETS_INGEST_TOKEN are not both set');
  }

  const doFetch = target.fetchImpl ?? fetch;
  const qs = new URLSearchParams({
    token: target.token,
    action: 'leads',
    limit: String(opts.limit ?? 500),
    offset: String(opts.offset ?? 0),
  });

  try {
    const res = await doFetch(`${target.url}?${qs}`, { redirect: 'follow' });
    const text = await res.text();

    // An Apps Script web app answers 200 to everything, and serves an HTML
    // sign-in page transiently even when access is set to Anyone.
    if (/^\s*<(!doctype|html)/i.test(text)) return empty(HTML_RESPONSE);

    const body = JSON.parse(text) as {
      ok?: boolean;
      columns?: string[];
      rows?: unknown[][];
      total?: number;
      error?: string;
      authorised?: boolean;
    };

    if (body.authorised === false) return empty('the Web App rejected SHEETS_INGEST_TOKEN');
    if (!body.ok) return empty(body.error ?? 'the Web App reported a failure with no reason');
    if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
      // The deployed version predates ?action=leads — a redeploy, not a fault.
      return empty('the deployed Web App does not serve leads yet — redeploy Code.gs');
    }

    const columns = body.columns;
    const leads = body.rows
      .map((row) => rowToStoredLead(columns, row))
      .filter((l): l is StoredLead => l !== null);

    return { ok: true, leads, total: body.total ?? leads.length, error: null };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

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

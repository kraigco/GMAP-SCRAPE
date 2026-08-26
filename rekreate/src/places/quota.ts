/**
 * Google returns 429 for two completely different situations, and they need
 * opposite responses:
 *
 *   'rate'  — a per-minute ceiling. Backing off and retrying is exactly right;
 *             the limit refills in seconds.
 *   'daily' — the per-day allowance is gone. Retrying cannot succeed for hours,
 *             and every attempt spends another request against a limit that is
 *             already exhausted. This is the case that must fail immediately.
 *
 * Treating the second like the first is how one failed sweep becomes four.
 *
 * Shared, because every Places surface can hit this — the tiled sweep, the
 * location lookup and the autocomplete box all talk to the same project quota.
 */

export type QuotaKind = 'daily' | 'rate';

export class PlacesQuotaError extends Error {
  readonly kind: QuotaKind;
  readonly status: number;
  readonly limitName: string | null;
  readonly raw: string;

  constructor(
    kind: QuotaKind,
    status: number,
    message: string,
    limitName: string | null,
    raw: string,
  ) {
    super(message);
    this.name = 'PlacesQuotaError';
    this.kind = kind;
    this.status = status;
    this.limitName = limitName;
    this.raw = raw;
  }
}

/** Null when the body is not a quota error, or is one we cannot place. */
export function classifyQuotaError(body: string): QuotaKind | null {
  const looksLikeQuota = body.includes('RESOURCE_EXHAUSTED') || /quota/i.test(body);
  if (!looksLikeQuota) return null;
  if (/per\s*day/i.test(body)) return 'daily';
  if (/per\s*minute/i.test(body)) return 'rate';
  // A quota error we cannot place. Callers treat this as retryable, because a
  // per-minute limit is far commoner and a bounded retry costs little.
  return null;
}

export function quotaLimitName(body: string): string | null {
  return /limit\s+'([^']+)'/.exec(body)?.[1] ?? null;
}

export function dailyQuotaMessage(limitName: string | null): string {
  return (
    `Google's daily quota for Places is used up on this project` +
    (limitName ? ` (limit "${limitName}")` : '') +
    `. Nothing was charged, and no further request can succeed until it resets ` +
    `at midnight US Pacific.\n` +
    `  Check the cap:  https://console.cloud.google.com/apis/api/places.googleapis.com/quotas\n` +
    `  A low daily cap usually means billing is not attached to the project.`
  );
}

export function rateLimitMessage(limitName: string | null, attempts: number): string {
  return (
    `Google is rate-limiting this project` +
    (limitName ? ` (limit "${limitName}")` : '') +
    `. Retried ${attempts} time(s) without success — lower the concurrency or wait a minute.`
  );
}

/**
 * Turn a 429 into the right error, or return null when the response is not a
 * quota problem and the caller should handle it its own way.
 */
export function quotaErrorFor(status: number, body: string): PlacesQuotaError | null {
  if (status !== 429) return null;
  if (classifyQuotaError(body) !== 'daily') return null;
  const limitName = quotaLimitName(body);
  return new PlacesQuotaError('daily', status, dailyQuotaMessage(limitName), limitName, body);
}

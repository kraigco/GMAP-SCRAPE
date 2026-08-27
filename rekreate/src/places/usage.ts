import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ENTERPRISE_FREE_CALLS_PER_MONTH } from './field-mask.ts';

/**
 * The monthly Places allowance, tracked across runs.
 *
 * A per-sweep cap cannot keep this project inside the free tier, and that is
 * not a tuning problem — it is arithmetic. Google's Enterprise SKU grants 1,000
 * Text Search calls a month, and those allowances stopped pooling when the
 * universal $200 credit was retired in March 2025. Thirty runs of forty-five
 * calls is 1,350, every one of the last 350 billable, and no per-run number can
 * see the other twenty-nine runs. Staying free requires state that outlives a
 * single process.
 *
 * An earlier session declined to keep a DAILY ledger, on the grounds that it
 * would be a second source of truth for something Postgres will own later. That
 * reasoning held while the goal was "do not trip the 100/day console cap",
 * which a per-run cap can approximate. It does not hold now that the goal is
 * "never spend money", which a per-run cap cannot express at all.
 *
 * RESERVE BEFORE, SETTLE AFTER. The budget is written to disk before the first
 * request goes out and corrected downward when the sweep finishes. A crash
 * therefore leaves the month looking MORE spent than it was, never less — the
 * safe direction when the alternative is an invoice. The cost is that a killed
 * run forfeits its unused reservation until the month rolls over.
 */

/** Where the ledger lives. Under out/, which is gitignored — this is local state. */
export const USAGE_PATH = 'out/places-usage.json';

export type Usage = {
  /** Calendar month in UTC, "YYYY-MM". */
  month: string;
  /** Calls reserved so far this month. */
  used: number;
};

export type Reservation = {
  /** Calls this run may spend. Zero means the month is gone. */
  granted: number;
  /** Reserved so far this month, including this grant. */
  used: number;
  /** Calls left after this grant. */
  remaining: number;
  cap: number;
  /** When the allowance resets, ISO. */
  resetsAt: string;
};

/**
 * Google's free tier runs on the calendar month. UTC is an assumption — the
 * billing month may well be US Pacific — and it is the conservative one, since
 * a UTC month rolls over up to eight hours before a Pacific one, so the ledger
 * frees its budget no earlier than Google does... which is the wrong direction.
 * Deliberately accepted: the residual risk is a handful of calls in the hours
 * around a month boundary, and the alternative is pretending to know a billing
 * timezone Google does not publish per-account.
 */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of the next UTC month. */
export function nextReset(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

const EMPTY: Usage = { month: '', used: 0 };

/**
 * Grant what the month can still afford — pure, so the arithmetic is testable
 * without touching a disk.
 *
 * A new month resets the counter rather than accumulating, and a `want` larger
 * than the remainder is trimmed rather than refused: half a sweep inside the
 * free tier is worth more than no sweep at all, and the caller is told what it
 * actually got so it can say so.
 */
export function grant(
  current: Usage,
  month: string,
  want: number,
  cap: number = ENTERPRISE_FREE_CALLS_PER_MONTH,
): { next: Usage; granted: number } {
  const used = current.month === month ? current.used : 0;
  const remaining = Math.max(0, cap - used);
  const granted = Math.max(0, Math.min(want, remaining));
  return { next: { month, used: used + granted }, granted };
}

/**
 * Hand back the part of a reservation the sweep did not spend.
 *
 * Never lets the month go negative, and never credits back more than was
 * reserved — a caller reporting a larger spend than its grant is a bug, and
 * quietly absorbing it would hide the overspend rather than record it.
 */
export function settle(current: Usage, month: string, reserved: number, actual: number): Usage {
  if (current.month !== month) return current;
  const unused = Math.max(0, reserved - Math.max(0, actual));
  return { month, used: Math.max(0, current.used - unused) };
}

async function read(path: string): Promise<Usage> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Usage>;
    if (typeof parsed.month === 'string' && typeof parsed.used === 'number' && parsed.used >= 0) {
      return { month: parsed.month, used: parsed.used };
    }
    return EMPTY;
  } catch {
    // No ledger yet, or one we cannot read. Starting from zero is right for the
    // first case; for the second it is the only option, and over-spending a
    // month is recoverable while refusing to ever run again is not.
    return EMPTY;
  }
}

async function write(path: string, usage: Usage): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
}

/** Claim up to `want` calls for this run, writing the reservation before it is spent. */
export async function reserve(
  want: number,
  opts: { path?: string; now?: Date; cap?: number } = {},
): Promise<Reservation> {
  const path = opts.path ?? USAGE_PATH;
  const now = opts.now ?? new Date();
  const cap = opts.cap ?? ENTERPRISE_FREE_CALLS_PER_MONTH;
  const month = monthKey(now);

  const { next, granted } = grant(await read(path), month, want, cap);
  await write(path, next);

  return {
    granted,
    used: next.used,
    remaining: Math.max(0, cap - next.used),
    cap,
    resetsAt: nextReset(now).toISOString(),
  };
}

/** Return the unspent part of a reservation once the sweep is over. */
export async function release(
  reserved: number,
  actual: number,
  opts: { path?: string; now?: Date } = {},
): Promise<void> {
  const path = opts.path ?? USAGE_PATH;
  const now = opts.now ?? new Date();
  await write(path, settle(await read(path), monthKey(now), reserved, actual));
}

/** What the month looks like right now, without claiming anything. */
export async function peek(
  opts: { path?: string; now?: Date; cap?: number } = {},
): Promise<Reservation> {
  const now = opts.now ?? new Date();
  const cap = opts.cap ?? ENTERPRISE_FREE_CALLS_PER_MONTH;
  const stored = await read(opts.path ?? USAGE_PATH);
  const used = stored.month === monthKey(now) ? stored.used : 0;
  return {
    granted: 0,
    used,
    remaining: Math.max(0, cap - used),
    cap,
    resetsAt: nextReset(now).toISOString(),
  };
}

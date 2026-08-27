import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dayKey,
  FREE_CALLS_PER_DAY,
  grant,
  nextDayReset,
  peek,
  release,
  reserve,
  settle,
} from '../src/places/usage.ts';

/**
 * The daily ceiling, which exists so one afternoon cannot spend the month.
 *
 * 30 calls a day x 31 days is 930, under the 1,000/month Enterprise allowance
 * with room to spare. The monthly ledger alone cannot make that promise: it
 * would happily grant all 1,000 on the 2nd and leave twenty-nine days dark.
 *
 * Everything here is keyed on the US/Pacific date, because that is where
 * Google's own daily quota resets. A UTC key would roll over at 4pm or 5pm
 * local and hand back an allowance Google still considered spent.
 */

let dir = '';
let path = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'daily-'));
  path = join(dir, 'usage.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// 2026-08-15 12:00 UTC is 05:00 Pacific on the same date — comfortably inside
// the day, so the two calendars agree and the fixture is unambiguous.
const MIDDAY = new Date('2026-08-15T12:00:00Z');
const BIG_MONTH = 1_000_000;

describe('the daily budget blocks the 31st call of the day', () => {
  it('grants exactly 30 and then nothing more, across many runs', async () => {
    let total = 0;
    for (let run = 0; run < 40; run += 1) {
      const r = await reserve(1, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
      total += r.granted;
      await release(r.granted, r.granted, { path, now: MIDDAY });
    }

    // Forty single-call runs, thirty granted. The 31st is the one that matters.
    expect(total).toBe(30);
  });

  it('refuses the 31st call outright rather than trimming it', async () => {
    await reserve(30, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
    const r = await reserve(1, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });

    expect(r.granted).toBe(0);
    expect(r.dayRemaining).toBe(0);
    expect(r.limitedBy).toBe('day');
  });

  it('trims an over-large request to what the day can still afford', async () => {
    await reserve(25, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
    const r = await reserve(25, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });

    expect(r.granted).toBe(5);
    expect(r.dayUsed).toBe(30);
    expect(r.limitedBy).toBe('day');
  });

  it('defaults to 30 a day with no cap given', async () => {
    expect(FREE_CALLS_PER_DAY).toBe(30);
    const r = await reserve(1000, { path, now: MIDDAY, cap: BIG_MONTH });
    expect(r.granted).toBe(30);
  });

  it('frees the allowance on the next Pacific day', async () => {
    await reserve(30, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
    const tomorrow = new Date('2026-08-16T12:00:00Z');

    const r = await reserve(30, { path, now: tomorrow, cap: BIG_MONTH, dayCap: 30 });
    expect(r.granted).toBe(30);
  });

  it('still refuses when the MONTH is gone even if the day is clean', async () => {
    // Both ceilings bind. A fresh day does not resurrect a spent month.
    await writeFile(path, JSON.stringify({ month: '2026-08', used: 1000 }), 'utf8');
    const r = await reserve(10, { path, now: MIDDAY, cap: 1000, dayCap: 30 });

    expect(r.granted).toBe(0);
    expect(r.limitedBy).toBe('month');
  });
});

describe('the day key follows US/Pacific, not UTC', () => {
  it('is still the previous day at 07:00 UTC', () => {
    // 2026-08-16T07:00Z is midnight Pacific on the 16th during PDT (UTC-7) —
    // the very first instant of the new day.
    expect(dayKey(new Date('2026-08-16T06:59:00Z'))).toBe('2026-08-15');
    expect(dayKey(new Date('2026-08-16T07:00:00Z'))).toBe('2026-08-16');
  });

  it('does not roll over at UTC midnight', () => {
    // The bug this prevents: a UTC-keyed ledger hands back a fresh 30 calls at
    // 5pm Pacific, while Google's day still has seven hours to run.
    expect(dayKey(new Date('2026-08-16T00:30:00Z'))).toBe('2026-08-15');
  });

  it('handles standard time, where the offset is UTC-8', () => {
    // January: PST, so midnight Pacific is 08:00 UTC rather than 07:00. A
    // hard-coded offset would be an hour wrong for half the year.
    expect(dayKey(new Date('2026-01-16T07:59:00Z'))).toBe('2026-01-15');
    expect(dayKey(new Date('2026-01-16T08:00:00Z'))).toBe('2026-01-16');
  });
});

describe('nextDayReset', () => {
  it('lands on the first instant of the next Pacific day', () => {
    const reset = nextDayReset(new Date('2026-08-15T12:00:00Z'));

    expect(reset.toISOString()).toBe('2026-08-16T07:00:00.000Z');
    expect(dayKey(reset)).toBe('2026-08-16');
  });

  it('is exact across the spring-forward transition', () => {
    // 8 March 2026 is a 23-hour Pacific day. Adding 24h would overshoot.
    const reset = nextDayReset(new Date('2026-03-08T12:00:00Z'));
    expect(dayKey(reset)).toBe('2026-03-09');
    expect(dayKey(new Date(reset.getTime() - 1))).toBe('2026-03-08');
  });

  it('is exact across the autumn fall-back transition', () => {
    // 1 November 2026 is a 25-hour Pacific day.
    const reset = nextDayReset(new Date('2026-11-01T12:00:00Z'));
    expect(dayKey(reset)).toBe('2026-11-02');
    expect(dayKey(new Date(reset.getTime() - 1))).toBe('2026-11-01');
  });
});

describe('the two ceilings settle independently', () => {
  it('credits an unspent reservation back to both the day and the month', () => {
    const after = settle(
      { month: '2026-08', used: 100, day: '2026-08-15', dayUsed: 25 },
      '2026-08',
      25,
      4,
      '2026-08-15',
    );

    expect(after.used).toBe(79);
    expect(after.dayUsed).toBe(4);
  });

  it('does not credit yesterday’s underspend to today', () => {
    // The run reserved on the 15th and finished after midnight. Handing the
    // remainder to the 16th would grant an allowance that was never earned.
    const after = settle(
      { month: '2026-08', used: 100, day: '2026-08-16', dayUsed: 10 },
      '2026-08',
      25,
      4,
      '2026-08-16-MISMATCH',
    );

    expect(after.dayUsed).toBe(10);
  });

  it('reports which ceiling bound when neither was hit', () => {
    const { limitedBy } = grant(
      { month: '2026-08', used: 0, day: '2026-08-15', dayUsed: 0 },
      '2026-08',
      10,
      1000,
      '2026-08-15',
      30,
    );
    expect(limitedBy).toBeNull();
  });

  it('peek reports the day without claiming any of it', async () => {
    await reserve(10, { path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
    await peek({ path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });

    const seen = await peek({ path, now: MIDDAY, cap: BIG_MONTH, dayCap: 30 });
    expect(seen.dayUsed).toBe(10);
    expect(seen.dayRemaining).toBe(20);
  });
});

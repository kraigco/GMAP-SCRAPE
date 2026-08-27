import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grant,
  monthKey,
  nextReset,
  peek,
  release,
  reserve,
  settle,
} from '../src/places/usage.ts';

/**
 * The ledger exists to make one promise: this project cannot spend money on
 * Places. Every test here is that promise from a different angle, and the
 * failures that matter are the ones where it hands out calls it should not.
 */

let dir = '';
let path = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'usage-'));
  path = join(dir, 'usage.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A daily cap high enough never to bind. The tests below predate the daily
 * ceiling and are each about the MONTHLY one; letting 30/day bind inside them
 * would turn every monthly assertion into a daily one and test nothing twice.
 * The daily ceiling has its own describe block.
 */
const BIG = 1_000_000;
const DAY = '2026-08-15';

const AUG = new Date('2026-08-15T12:00:00Z');
const SEP = new Date('2026-09-02T12:00:00Z');

describe('monthKey', () => {
  it('is the UTC calendar month', () => {
    expect(monthKey(AUG)).toBe('2026-08');
    expect(monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
  });

  it('does not drift on a local timezone boundary', () => {
    // 31 Aug 23:00 UTC is already September in Manila. The ledger follows UTC,
    // and must not disagree with itself depending on where it runs.
    expect(monthKey(new Date('2026-08-31T23:00:00Z'))).toBe('2026-08');
  });
});

describe('nextReset', () => {
  it('is the first instant of the following month', () => {
    expect(nextReset(AUG).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(nextReset(new Date('2026-12-10T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('grant', () => {
  it('gives the whole request when the month can afford it', () => {
    const { next, granted } = grant({ month: '2026-08', used: 100 }, '2026-08', 45, 1000, DAY, BIG);
    expect(granted).toBe(45);
    expect(next.used).toBe(145);
  });

  it('trims to what is left rather than refusing outright', () => {
    // Half a sweep inside the free tier beats no sweep.
    const { next, granted } = grant({ month: '2026-08', used: 980 }, '2026-08', 45, 1000, DAY, BIG);
    expect(granted).toBe(20);
    expect(next.used).toBe(1000);
  });

  it('grants nothing once the month is spent', () => {
    const { next, granted } = grant({ month: '2026-08', used: 1000 }, '2026-08', 45, 1000, DAY, BIG);
    expect(granted).toBe(0);
    expect(next.used).toBe(1000);
  });

  it('never exceeds the cap however often it is called', () => {
    let usage = { month: '2026-08', used: 0 };
    let total = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = grant(usage, '2026-08', 45, 1000, DAY, BIG);
      usage = r.next;
      total += r.granted;
    }
    // 100 runs of 45 would be 4,500. The point of the ledger is that it is not.
    expect(total).toBe(1000);
    expect(usage.used).toBe(1000);
  });

  it('starts the count over in a new month', () => {
    const { next, granted } = grant({ month: '2026-08', used: 1000 }, '2026-09', 45, 1000, DAY, BIG);
    expect(granted).toBe(45);
    expect(next).toMatchObject({ month: '2026-09', used: 45 });
  });
});

describe('settle', () => {
  it('hands back what the sweep did not spend', () => {
    expect(settle({ month: '2026-08', used: 145 }, '2026-08', 45, 12)).toMatchObject({
      month: '2026-08',
      used: 112,
    });
  });

  it('keeps the whole reservation when it was all spent', () => {
    expect(settle({ month: '2026-08', used: 145 }, '2026-08', 45, 45).used).toBe(145);
  });

  it('does not credit back more than was reserved', () => {
    // A run reporting less than zero, or a nonsense actual, must not be able to
    // mint budget.
    expect(settle({ month: '2026-08', used: 145 }, '2026-08', 45, -5).used).toBe(100);
    expect(settle({ month: '2026-08', used: 145 }, '2026-08', 45, 999).used).toBe(145);
  });

  it('leaves a rolled-over month alone', () => {
    // The reservation belonged to August; September must not be credited for it.
    const sept = { month: '2026-09', used: 30 };
    expect(settle(sept, '2026-08', 45, 0)).toEqual(sept);
  });
});

describe('the ledger on disk', () => {
  it('grants from a clean slate and records the reservation', async () => {
    const r = await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
    expect(r.granted).toBe(45);
    expect(r.remaining).toBe(955);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ month: '2026-08', used: 45 });
  });

  it('reserves BEFORE the calls are spent, so a crash cannot undercount', async () => {
    // The file must already show the full reservation with no settlement yet:
    // that is what makes an interrupted run fail safe.
    await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
    expect(JSON.parse(await readFile(path, 'utf8')).used).toBe(45);

    // Simulate the process dying here — no release() call. The next run sees
    // 45 spent even though the sweep may have used none.
    const after = await peek({ path, now: AUG, cap: 1000, dayCap: BIG });
    expect(after.used).toBe(45);
  });

  it('returns the unspent remainder after a normal run', async () => {
    const r = await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
    await release(r.granted, 12, { path, now: AUG });
    expect((await peek({ path, now: AUG, cap: 1000, dayCap: BIG })).used).toBe(12);
  });

  it('refuses once the month is gone, and says when it returns', async () => {
    await writeFile(path, JSON.stringify({ month: '2026-08', used: 1000 }), 'utf8');
    const r = await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
    expect(r.granted).toBe(0);
    expect(r.remaining).toBe(0);
    expect(r.resetsAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('frees the allowance when the month rolls over', async () => {
    await writeFile(path, JSON.stringify({ month: '2026-08', used: 1000 }), 'utf8');
    expect((await reserve(45, { path, now: SEP, cap: 1000, dayCap: BIG })).granted).toBe(45);
  });

  it('starts from zero rather than refusing when the file is corrupt', async () => {
    // Overspending one month is recoverable; a ledger that can brick the tool
    // is not.
    await writeFile(path, 'not json at all', 'utf8');
    expect((await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG })).granted).toBe(45);
  });

  it('ignores a ledger with a negative count', async () => {
    await writeFile(path, JSON.stringify({ month: '2026-08', used: -500 }), 'utf8');
    expect((await peek({ path, now: AUG, cap: 1000, dayCap: BIG })).used).toBe(0);
  });

  it('holds the line across many reserve/release cycles', async () => {
    let total = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
      total += r.granted;
      // Every run spends its whole grant — the worst case for the cap.
      await release(r.granted, r.granted, { path, now: AUG });
    }
    expect(total).toBe(1000);
    expect((await peek({ path, now: AUG, cap: 1000, dayCap: BIG })).remaining).toBe(0);
  });

  it('peek claims nothing', async () => {
    await reserve(45, { path, now: AUG, cap: 1000, dayCap: BIG });
    await peek({ path, now: AUG, cap: 1000, dayCap: BIG });
    await peek({ path, now: AUG, cap: 1000, dayCap: BIG });
    expect((await peek({ path, now: AUG, cap: 1000, dayCap: BIG })).used).toBe(45);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchBaseName, slug, timestampSlug, writeUnique } from '../src/export/search-file.ts';

describe('slug', () => {
  it('turns a place name into a safe filename component', () => {
    expect(slug('Makati City, Metro Manila')).toBe('makati-city-metro-manila');
  });

  it('strips accents rather than mangling them', () => {
    expect(slug('Zürich')).toBe('zurich');
    expect(slug('Córdoba')).toBe('cordoba');
  });

  it('never emits a character Windows forbids', () => {
    const dirty = 'a<b>c:d"e/f\\g|h?i*j';
    expect(slug(dirty)).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('falls back rather than producing an empty name', () => {
    expect(slug('   ')).toBe('untitled');
    expect(slug('!!!')).toBe('untitled');
    expect(slug('')).toBe('untitled');
  });

  it('caps the length and never ends on a separator', () => {
    const long = slug('a very long location name that keeps going and going and going');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('timestampSlug', () => {
  it('is sortable and has no colons', () => {
    expect(timestampSlug('2026-08-26T10:48:12.345Z')).toBe('20260826-104812');
  });

  it('pads single digits', () => {
    expect(timestampSlug('2026-01-02T03:04:05.000Z')).toBe('20260102-030405');
  });

  it('sorts chronologically as plain text', () => {
    const a = timestampSlug('2026-08-26T09:00:00Z');
    const b = timestampSlug('2026-08-26T10:00:00Z');
    const c = timestampSlug('2026-09-01T00:00:00Z');
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  it('refuses an unusable date instead of writing a file called NaN', () => {
    expect(() => timestampSlug('not a date')).toThrow(/unusable date/);
  });
});

describe('searchBaseName', () => {
  it('says when, where and what', () => {
    expect(searchBaseName('2026-08-26T10:48:12Z', 'Makati City, Metro Manila', 'dental clinic'))
      .toBe('20260826-104812_makati-city-metro-manila_dental-clinic');
  });
});

describe('writeUnique — the bug this fixes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rekreate-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the plain name when nothing is there', async () => {
    const path = await writeUnique(dir, 'run', 'first');
    expect(path.endsWith('run.csv')).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('first');
  });

  it('NEVER overwrites — a second write of the same name lands beside it', async () => {
    const first = await writeUnique(dir, 'run', 'philadelphia');
    const second = await writeUnique(dir, 'run', 'manila');

    expect(second).not.toBe(first);
    // The whole point: the earlier result is still intact.
    expect(await readFile(first, 'utf8')).toBe('philadelphia');
    expect(await readFile(second, 'utf8')).toBe('manila');
    expect(second.endsWith('run-2.csv')).toBe(true);
  });

  it('keeps counting past the second collision', async () => {
    await writeUnique(dir, 'run', 'a');
    await writeUnique(dir, 'run', 'b');
    const third = await writeUnique(dir, 'run', 'c');
    expect(third.endsWith('run-3.csv')).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(['run-2.csv', 'run-3.csv', 'run.csv']);
  });

  it('survives concurrent writes without either losing data', async () => {
    // The reason for the 'wx' flag: check-then-write would let both of these
    // decide the same filename was free.
    const paths = await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeUnique(dir, 'race', `payload-${i}`)),
    );

    expect(new Set(paths).size).toBe(8);
    const written = await Promise.all(paths.map((p) => readFile(p, 'utf8')));
    expect(new Set(written).size).toBe(8);
    expect((await readdir(dir))).toHaveLength(8);
  });

  it('creates the directory if it does not exist yet', async () => {
    const nested = join(dir, 'searches', 'deep');
    const path = await writeUnique(nested, 'run', 'x');
    expect(await readFile(path, 'utf8')).toBe('x');
  });
});

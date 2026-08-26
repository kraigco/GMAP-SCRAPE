import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Every search gets its own file.
 *
 * The dashboard used to write one fixed path, so each search silently
 * destroyed the one before it — a Manila run wiped a Philadelphia run, and the
 * loss was invisible until someone read the file and found the wrong city in
 * it. Results are expensive: they cost API quota and a few hundred requests to
 * other people's servers. Nothing should be able to overwrite them by accident.
 */

/** Filesystem-safe component. Windows also forbids < > : " / \ | ? * */
export function slug(text: string, maxLength = 40): string {
  const cleaned = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents rather than mangling them
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const clipped = cleaned.slice(0, maxLength).replace(/-+$/, '');
  return clipped || 'untitled';
}

/** `2026-08-26T10:48:12.345Z` becomes `20260826-104812`. Colons are illegal on Windows. */
export function timestampSlug(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`timestampSlug: unusable date "${iso}"`);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Sorts chronologically in a file listing, and says what it holds. */
export function searchBaseName(finishedAt: string, location: string, niche: string): string {
  return `${timestampSlug(finishedAt)}_${slug(location)}_${slug(niche)}`;
}

/**
 * Read a base name back into its parts, for listing saved searches.
 *
 * Lossy by nature — the slug threw away the original punctuation — so this is
 * the FALLBACK. A search saved with its sidecar carries the real labels; this
 * is what lets files written before sidecars existed still appear in the list.
 */
export function parseSearchBaseName(
  name: string,
): { when: string | null; location: string; niche: string } | null {
  const base = name.replace(/\.(csv|json)$/i, '').replace(/-\d+$/, '');
  const match = /^(\d{8})-(\d{6})_([^_]*)_(.*)$/.exec(base);
  if (!match) return null;

  const [, date, time, location, niche] = match;
  const iso =
    `${date!.slice(0, 4)}-${date!.slice(4, 6)}-${date!.slice(6, 8)}` +
    `T${time!.slice(0, 2)}:${time!.slice(2, 4)}:${time!.slice(4, 6)}.000Z`;

  const words = (s: string): string => s.replace(/-/g, ' ').trim();
  return {
    when: Number.isNaN(new Date(iso).getTime()) ? null : iso,
    location: words(location ?? ''),
    niche: words(niche ?? ''),
  };
}

/**
 * Write without ever clobbering an existing file.
 *
 * Uses the 'wx' flag rather than checking existence first: a check followed by
 * a write is a race, and two searches finishing in the same second would both
 * see "free" and one would lose. 'wx' makes the filesystem itself refuse.
 */
export async function writeUnique(
  dir: string,
  baseName: string,
  contents: string,
  extension = '.csv',
): Promise<string> {
  await mkdir(dir, { recursive: true });

  for (let n = 0; n < 100; n += 1) {
    const name = n === 0 ? `${baseName}${extension}` : `${baseName}-${n + 1}${extension}`;
    const full = join(dir, name);
    try {
      await writeFile(full, contents, { encoding: 'utf8', flag: 'wx' });
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Taken — try the next suffix.
    }
  }

  throw new Error(`writeUnique: no free filename for "${baseName}" after 100 attempts in ${dir}`);
}

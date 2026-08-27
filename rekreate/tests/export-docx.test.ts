import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { crc32, zip } from '../src/lib/zip.ts';
import { buildDocx } from '../src/export/docx.ts';

/**
 * A .docx that Word refuses to open fails as a corrupt-file dialog, with
 * nothing pointing back at the code that wrote it. So these tests read the
 * container back at the byte level rather than trusting that it looks right.
 *
 * The reader below walks the central directory — the index a real unzip uses to
 * find anything — rather than scanning for local headers. That is what catches
 * a wrong offset or size, which is the failure mode that produces an archive
 * looking fine until something tries to open it.
 */

type ReadEntry = { name: string; data: Buffer };

function readZip(buf: Buffer): ReadEntry[] {
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ReadEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central header at ${p}`);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;

    const stored = buf.subarray(start, start + compSize);
    const data = inflateRawSync(stored);

    // The checksum in the index must match what actually inflated.
    expect(crc32(data)).toBe(buf.readUInt32LE(p + 16));

    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

const textOf = (buf: Buffer, name: string): string => {
  const entry = readZip(buf).find((e) => e.name === name);
  if (!entry) throw new Error(`${name} is not in the archive`);
  return entry.data.toString('utf8');
};

describe('crc32', () => {
  it('matches the known checksum for a standard vector', () => {
    // The canonical CRC-32 of "123456789".
    expect(crc32(Buffer.from('123456789', 'utf8'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('zip', () => {
  it('round-trips names and contents through the central directory', () => {
    const archive = zip([
      { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
      { name: 'nested/b.txt', data: Buffer.from('world', 'utf8') },
    ]);
    const entries = readZip(archive);

    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'nested/b.txt']);
    expect(entries[0]!.data.toString('utf8')).toBe('hello');
    expect(entries[1]!.data.toString('utf8')).toBe('world');
  });

  it('starts with the local file header signature', () => {
    const archive = zip([{ name: 'a.txt', data: Buffer.from('x', 'utf8') }]);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('survives content large enough to actually compress', () => {
    const big = Buffer.from('the quick brown fox '.repeat(5000), 'utf8');
    const entry = readZip(zip([{ name: 'big.txt', data: big }]))[0]!;
    expect(entry.data.equals(big)).toBe(true);
  });

  it('handles an empty file without corrupting the index', () => {
    const entries = readZip(
      zip([
        { name: 'empty.txt', data: Buffer.alloc(0) },
        { name: 'after.txt', data: Buffer.from('still here', 'utf8') },
      ]),
    );
    expect(entries[0]!.data.length).toBe(0);
    expect(entries[1]!.data.toString('utf8')).toBe('still here');
  });

  it('is byte-identical across runs of the same content', () => {
    // The timestamp is fixed on purpose: regenerating an unchanged document
    // must not produce a different file, or no diff can answer "did the copy
    // change?".
    const once = zip([{ name: 'a.txt', data: Buffer.from('same', 'utf8') }]);
    const twice = zip([{ name: 'a.txt', data: Buffer.from('same', 'utf8') }]);
    expect(once.equals(twice)).toBe(true);
  });
});

describe('buildDocx', () => {
  it('writes the parts Word will not open without', () => {
    const names = readZip(buildDocx([{ text: 'Hello' }])).map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/styles.xml');
    expect(names).toContain('word/_rels/document.xml.rels');
  });

  it('escapes the characters that arrive in real business names', () => {
    // "Smith & Jones" from a Google listing is one unescaped ampersand away
    // from a document that will not open.
    const doc = textOf(
      buildDocx([{ text: 'Smith & Jones <Realty> "The Best"' }]),
      'word/document.xml',
    );
    expect(doc).toContain('Smith &amp; Jones &lt;Realty&gt; &quot;The Best&quot;');
    expect(doc).not.toMatch(/Smith & Jones/);
  });

  it('carries the style and the page break onto the paragraph', () => {
    const doc = textOf(
      buildDocx([
        { text: 'A title', style: 'Title' },
        { text: 'Next page', style: 'Heading2', pageBreakBefore: true },
      ]),
      'word/document.xml',
    );
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('<w:pageBreakBefore/>');
  });

  it('preserves whitespace so a signature block keeps its shape', () => {
    const doc = textOf(buildDocx([{ text: '  indented' }]), 'word/document.xml');
    expect(doc).toContain('xml:space="preserve"');
  });

  it('declares every part it ships in the content types manifest', () => {
    const archive = buildDocx([{ text: 'Hello' }]);
    const types = textOf(archive, '[Content_Types].xml');
    expect(types).toContain('/word/document.xml');
    expect(types).toContain('/word/styles.xml');
  });

  it('survives an empty paragraph', () => {
    expect(() => buildDocx([{ text: '' }, { text: 'after' }])).not.toThrow();
  });
});

/**
 * The reader above and the writer under test were written together, so one
 * check goes outside both: hand the bytes to an unzip implementation nobody
 * here wrote. Slow, because it starts a process — hence the raised timeout —
 * and worth it once.
 */
describe('an independent unzip accepts it', () => {
  it('opens the document and lists its parts', { timeout: 30_000 }, () => {
    const b64 = buildDocx([{ text: 'Hello' }]).toString('base64');
    const script =
      `Add-Type -AssemblyName System.IO.Compression;` +
      `$b=[Convert]::FromBase64String('${b64}');` +
      `$m=New-Object System.IO.MemoryStream(,$b);` +
      `$z=New-Object System.IO.Compression.ZipArchive($m);` +
      `$z.Entries | ForEach-Object { $_.FullName }`;

    const names = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
  });
});

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { parseEnrichedCsv } from '../src/export/csv.ts';
import { parseSearchBaseName } from '../src/export/search-file.ts';
import { buildHook, checkDate } from '../src/pitch/hooks.ts';
import { benchmarkFor, computeCorpus } from '../src/pitch/benchmark.ts';
import { buildDocx } from '../src/export/docx.ts';
import type { DocxParagraph } from '../src/export/docx.ts';
import type { Lead } from '../src/lead/signals.ts';

/**
 * Write the finished letters for a saved search as a document.
 *
 * Generated rather than typed, and regenerated rather than edited. Every number
 * in this copy — the corpus counts, the median, a prospect's own response time
 * — comes from the audit, and a re-audit moves them. A letter kept by hand
 * drifts from what the engine actually produces on the day it sends, and the
 * numbers in a cold email are the first thing a prospect checks.
 *
 *   node scripts/render-letters.ts out/searches/<file>.csv [out.docx|out.md]
 *
 * The output format follows the extension. .docx is the default because that is
 * what gets opened, edited and passed to whoever sends it.
 */

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/render-letters.ts <csv> [out.docx|out.md]');

const parsed = parseSearchBaseName(basename(file));
const leads = parseEnrichedCsv(await readFile(file, 'utf8'));
const corpus = computeCorpus(leads);

const title = (s: string): string =>
  s.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * How the reader would name their own area and trade, taken from the search
 * that produced the file — so a Camden roofing list cannot inherit a
 * Philadelphia property-management benchmark sentence.
 */
const market = parsed?.location ? title(parsed.location).replace(/ Pa$/, ', PA') : 'your market';
const nicheLabel = parsed?.niche ? `${parsed.niche.replace(/-/g, ' ')} companies` : 'businesses';
const checkedOn = checkDate(parsed?.when ?? null);

const hookCtx = { niche: parsed?.niche ?? '', checkedOn };
const benchCtx = { market, nicheLabel };

/** Slots the engine cannot fill. Left visible rather than guessed at. */
const SENDER = '[SENDER NAME]';
const ROLE = '[TITLE]';
const PHONE = '[PHONE]';
const ADDRESS = '[POSTAL ADDRESS — legally required]';
const UNSUB = '[unsubscribe link]';

const SUBJECTS: Record<string, (l: Lead) => string> = {
  down: (l) => `${l.name} — your site didn't load on ${checkedOn}`,
  'no-site': (l) => `${l.reviews ?? 0} reviews, no website`,
  slow: (l) => `${l.name} takes ${((l.ttfb ?? 0) / 1000).toFixed(1)} seconds to load`,
  'no-viewport': (l) => `${l.name} on a phone`,
  insecure: (l) => `browsers are flagging ${l.name}`,
};

/**
 * One letter as logical paragraphs, not pre-wrapped lines.
 *
 * The wrapping belongs to whatever renders it: Word reflows to the page, a
 * plain-text file wraps at a column. Baking hard line breaks in here would give
 * the Word version ragged, un-editable text.
 */
type Letter = { subject: string; to: string; paragraphs: string[]; footer: string[] };

function letterFor(lead: Lead): Letter | null {
  const hook = buildHook(lead, hookCtx);
  if (!hook.text) return null;

  const bench = benchmarkFor(lead, corpus, benchCtx);
  const paragraphs = ['Hi there,', hook.text];
  if (bench) paragraphs.push(bench);

  paragraphs.push(
    `I am ${SENDER} — I run Rekreate Digital. We build the site and the systems behind it, ` +
      `hand you the keys, and stay on call when something breaks. You own it outright. ` +
      `That is the whole model.`,
    `I am not asking for a meeting. If you want it, reply "send it" and I will write up ` +
      `everything we found on ${lead.name} — what we checked, what we measured, and what ` +
      `I would fix first. No charge, no call, and I will not follow up unless you ask me to.`,
    SENDER,
    `${ROLE}, Rekreate Digital`,
    PHONE,
  );

  return {
    subject: SUBJECTS[hook.basis]?.(lead) ?? lead.name,
    to: lead.email || '— no public address found —',
    paragraphs,
    footer: [
      'Rekreate Digital',
      ADDRESS,
      `You are getting this because ${lead.name} is listed publicly in ${market} and its ` +
        `website is publicly reachable. If you would rather not hear from me, ${UNSUB} and ` +
        `I will remove you permanently — one click, no reply needed.`,
    ],
  };
}

const written = leads
  .map((lead) => ({ lead, hook: buildHook(lead, hookCtx) }))
  .filter((r) => r.hook.text);

// Ordered so the biggest groups lead and identical gaps sit together — this
// document is read to check the copy, and five variants scattered through
// ninety-three letters cannot be compared.
const ORDER = ['down', 'no-site', 'slow', 'no-viewport', 'insecure'];
written.sort((a, b) => ORDER.indexOf(a.hook.basis) - ORDER.indexOf(b.hook.basis));

const counts = new Map<string, number>();
for (const r of written) counts.set(r.hook.basis, (counts.get(r.hook.basis) ?? 0) + 1);

const emailable = written.filter((r) => r.lead.email).length;
const phoneable = written.filter((r) => r.lead.phone).length;
const median = corpus.medianTtfbMs === null ? 'n/a' : `${(corpus.medianTtfbMs / 1000).toFixed(1)}s`;

const heading = `Cold outreach letters — ${title(parsed?.niche ?? 'leads')}, ${market}`;

/** The coverage figures, stated the same way in both formats. */
const COVERAGE = [
  `${leads.length} prospects in the file, ${corpus.n} audited`,
  `${written.length} have a measured gap, so ${written.length} letters can be written`,
  `${emailable} of those have a public email address; ${phoneable} have a phone number`,
  `${leads.length - written.length} get no letter — there is nothing measured to say to them`,
];

const CORPUS_LINES = [
  `${corpus.up} of ${corpus.n} sites loaded; ${corpus.down} did not`,
  `median response ${median}`,
  `${corpus.viewportOk} render on a phone, ${corpus.viewportBad} do not`,
  `${corpus.httpsOk} on HTTPS, ${corpus.httpsBad} not`,
];

const BEFORE_SENDING =
  `Fill ${SENDER}, ${ROLE}, ${PHONE} and ${ADDRESS}. The postal address is required by ` +
  `CAN-SPAM and there is no version of this send without one. ${UNSUB} should be the ` +
  `sending platform's native token so opt-outs suppress automatically.`;

const PROVENANCE =
  `Generated from ${basename(file)} by scripts/render-letters.ts. Regenerate rather than ` +
  `edit: every number here comes from the audit, and a re-audit moves them.`;

// ------------------------------------------------------------------- docx

function renderDocx(): Buffer {
  const out: DocxParagraph[] = [
    { text: heading, style: 'Title' },
    { text: PROVENANCE, style: 'Meta' },
    { text: 'Coverage', style: 'Heading1' },
    ...COVERAGE.map((t): DocxParagraph => ({ text: `•  ${t}` })),
    { text: 'The corpus these letters compare against', style: 'Heading2' },
    ...CORPUS_LINES.map((t): DocxParagraph => ({ text: `•  ${t}` })),
    { text: 'Letters by measured gap', style: 'Heading2' },
    ...ORDER.filter((k) => counts.has(k)).map(
      (k): DocxParagraph => ({ text: `•  ${k} — ${counts.get(k)}` }),
    ),
    { text: 'Before sending', style: 'Heading2' },
    { text: BEFORE_SENDING },
  ];

  let lastBasis = '';
  for (const { lead, hook } of written) {
    const letter = letterFor(lead);
    if (!letter) continue;

    const newGroup = hook.basis !== lastBasis;
    if (newGroup) {
      lastBasis = hook.basis;
      out.push({
        text: `${hook.basis} — ${counts.get(hook.basis)} letter(s)`,
        style: 'Heading1',
        pageBreakBefore: true,
      });
    }

    // One letter per page: this document is printed and marked up, and a letter
    // split across a page break cannot be read as the recipient will see it.
    out.push({ text: lead.name, style: 'Heading2', pageBreakBefore: !newGroup });
    out.push({ text: `Subject:  ${letter.subject}`, style: 'Meta' });
    out.push({ text: `To:  ${letter.to}`, style: 'Meta' });
    for (const p of letter.paragraphs) out.push({ text: p, style: 'Mono' });
    out.push({ text: '--', style: 'Mono' });
    for (const p of letter.footer) out.push({ text: p, style: 'Mono' });
  }

  return buildDocx(out);
}

// --------------------------------------------------------------- markdown

function renderMarkdown(): string {
  const doc: string[] = [
    `# ${heading}`,
    '',
    PROVENANCE,
    '',
    '## Coverage',
    '',
    ...COVERAGE.map((t) => `- ${t}`),
    '',
    '### The corpus these letters compare against',
    '',
    ...CORPUS_LINES.map((t) => `- ${t}`),
    '',
    '### Letters by measured gap',
    '',
    '| Gap | Letters |',
    '|---|---|',
    ...ORDER.filter((k) => counts.has(k)).map((k) => `| ${k} | ${counts.get(k)} |`),
    '',
    '## Before sending',
    '',
    BEFORE_SENDING,
    '',
    '---',
    '',
  ];

  let lastBasis = '';
  for (const { lead, hook } of written) {
    const letter = letterFor(lead);
    if (!letter) continue;

    if (hook.basis !== lastBasis) {
      lastBasis = hook.basis;
      doc.push(`## ${hook.basis} — ${counts.get(hook.basis)} letter(s)`, '');
    }

    doc.push(
      `### ${lead.name}`,
      '',
      `**Subject:** ${letter.subject}`,
      `**To:** ${letter.to}`,
      '',
      '```',
      ...letter.paragraphs.flatMap((p) => [p, '']),
      '--',
      ...letter.footer,
      '```',
      '',
    );
  }

  return doc.join('\n');
}

// ------------------------------------------------------------------ write

const outPath = process.argv[3] ?? `out/letters/${basename(file, '.csv')}.docx`;
await mkdir(dirname(outPath), { recursive: true });

if (extname(outPath).toLowerCase() === '.md') {
  await writeFile(outPath, renderMarkdown(), 'utf8');
} else {
  await writeFile(outPath, renderDocx());
}

console.log(`\n  ${written.length} letter(s) written to ${outPath}`);
console.log(`  ${emailable} emailable, ${phoneable} phoneable\n`);

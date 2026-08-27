import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { parseEnrichedCsv } from '../src/export/csv.ts';
import { parseSearchBaseName } from '../src/export/search-file.ts';
import { checkDate } from '../src/pitch/hooks.ts';
import { computeCorpus, marketFindings, MIN_CORPUS } from '../src/pitch/benchmark.ts';
import { countableNiche, lookerFor, marketLabel, pluralNiche } from '../src/pitch/niche-language.ts';
import { buildDocx } from '../src/export/docx.ts';
import type { DocxParagraph } from '../src/export/docx.ts';

/**
 * The campaign letter — ONE letter, sent to everyone on the list.
 *
 *   node scripts/render-campaign-letter.ts out/searches/<file>.csv [out.docx]
 *
 * Identical copy to every recipient rules out the per-prospect opening line,
 * because a sentence about one firm's site is false for the next. So this
 * letter is grounded in the corpus instead of the individual: we audited the
 * whole market, and every number below is true of the market no matter who
 * opens it.
 *
 * That constraint turns out to buy something. The letter asserts nothing about
 * its reader, so it cannot be wrong about them — it can go to all of them, not
 * just the ones with a measured gap. And the thing it withholds is the reader's
 * own result, which we do hold. Curiosity about a real number someone already
 * has about you is a stronger reason to reply than any deadline we could invent.
 */

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/render-campaign-letter.ts <csv> [out.docx]');

const parsed = parseSearchBaseName(basename(file));
const leads = parseEnrichedCsv(await readFile(file, 'utf8'));
const corpus = computeCorpus(leads);

const title = (s: string): string =>
  s.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

const market = marketLabel(parsed?.location ?? '');
const rawNiche = parsed?.niche ?? '';
// The trade's own words, so one letter reads as written for each of them:
// "every dental clinic", not "every dental clinic company"; a roofer's
// visitor is not "an owner or a tenant".
const niche = countableNiche(rawNiche);
const nichePlural = pluralNiche(rawNiche);
const looker = lookerFor(rawNiche);
const checkedOn = checkDate(parsed?.when ?? null) ?? 'the day we ran it';

/** Slots the engine cannot fill. Left visible rather than guessed at. */
const SENDER = '[SENDER NAME]';
const ROLE = '[TITLE]';
const PHONE = '[PHONE]';
const ADDRESS = '[POSTAL ADDRESS — legally required]';
const UNSUB = '[unsubscribe link]';

// Every figure the letter quotes, computed here rather than typed. The slowest
// response is not part of the corpus type — it is only ever used as colour in
// this one sentence, so it is derived locally instead of widening that shape.
const timed = leads
  .filter((l) => l.reachable === 'yes' && typeof l.ttfb === 'number')
  .map((l) => l.ttfb as number)
  .sort((a, b) => a - b);
const slowest = timed.length > 0 ? (timed[timed.length - 1] as number) : null;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}`;

if (corpus.n === 0) throw new Error(`${file} has no audited rows — run the audit first.`);

// This letter opens by claiming we surveyed a market. Below the bar that
// benchmarkFor already draws, the claim outruns the evidence: "we checked 7
// roofing contractors" is not a market study, and a reader who knows there are
// forty firms in town learns only that we did not look very hard.
if (corpus.n < MIN_CORPUS) {
  throw new Error(
    `${file} has only ${corpus.n} audited row(s). This letter claims a survey of a market, ` +
      `and ${MIN_CORPUS} is the floor for that claim being worth making. Audit a wider box ` +
      `or more terms first.`,
  );
}

const SUBJECTS = [
  `we checked ${corpus.n} ${nichePlural} in ${market}`,
  `${corpus.down} of ${corpus.n} ${market} ${nichePlural} had no working site`,
  `what we found checking every ${niche} in ${market}`,
];

const findings = marketFindings(corpus, slowest);

/**
 * The letter. Logical paragraphs, not pre-wrapped lines — Word reflows to the
 * page and a plain-text export wraps at a column, and neither wants the other's
 * line breaks baked in.
 */
const LETTER = [
  'Hi there,',

  `On ${checkedOn} we checked the public website of every ${niche} we could find ` +
    `listed on Google Maps in and around ${market} — ${corpus.n} of them. We wanted to see ` +
    `what ${looker} actually runs into when they look one of you up.`,

  findings,

  `We have the individual result for every firm on that list, including yours. If you want ` +
    `yours, reply "send it" and I will write it up — what we checked, what it measured, and ` +
    `what I would fix first. No charge, no call, and I will not follow up unless you ask me to.`,

  `I am ${SENDER} — I run Rekreate Digital. We build the site and the systems behind it, ` +
    `hand you the keys, and stay on call when something breaks. You own it outright. That is ` +
    `the whole model.`,

  SENDER,
  `${ROLE}, Rekreate Digital`,
  PHONE,
];

const FOOTER = [
  'Rekreate Digital',
  ADDRESS,
  `You are getting this because your company is listed publicly in ${market}. If you would ` +
    `rather not hear from me, ${UNSUB} and I will remove you permanently — one click, no ` +
    `reply needed.`,
];

/**
 * Where each number in the letter came from, so it can be checked before it is
 * sent. Every one of these is the first thing a recipient could disprove.
 */
const PROVENANCE: string[] = [
  `${corpus.n} audited — rows in ${basename(file)} whose site was actually fetched. ` +
    `${leads.length} were harvested; the difference is sites whose own robots.txt disallowed us.`,
  `${corpus.down} did not load — reachable = no.`,
  `${corpus.up} loaded — reachable = yes.`,
  `${secs(corpus.medianTtfbMs ?? 0)}s median — middle time-to-first-byte across the ${corpus.up} that answered.`,
  ...(slowest !== null ? [`${secs(slowest)}s slowest — highest time-to-first-byte in the same set.`] : []),
  `${corpus.viewportBad} not built for phones — no mobile viewport, among sites that loaded.`,
  `${corpus.httpsBad} still on http — no HTTPS after redirects, among sites that loaded.`,
];

const heading = `Campaign letter — ${title(nichePlural)}, ${market}`;

const NOTE =
  `One letter, sent to everyone. It makes no claim about the recipient, only about the ` +
  `market, so it is safe to send to all ${leads.length} rows on the list rather than only ` +
  `the ones with a measured gap. Regenerate rather than edit — every number comes from the ` +
  `audit, and a re-audit moves them.`;

// ------------------------------------------------------------------ render

function renderDocx(): Buffer {
  const out: DocxParagraph[] = [
    { text: heading, style: 'Title' },
    { text: NOTE, style: 'Meta' },

    { text: 'Subject line', style: 'Heading1' },
    ...SUBJECTS.map((s, i): DocxParagraph => ({ text: `${i + 1}.  ${s}`, style: 'Mono' })),

    { text: 'The letter', style: 'Heading1' },
    ...LETTER.map((p): DocxParagraph => ({ text: p, style: 'Mono' })),
    { text: '--', style: 'Mono' },
    ...FOOTER.map((p): DocxParagraph => ({ text: p, style: 'Mono' })),

    { text: 'Where every number comes from', style: 'Heading1', pageBreakBefore: true },
    {
      text:
        'These are the sentences a recipient can check, so they are the sentences worth ' +
        'checking first. Each figure below is computed from the audit, never typed.',
    },
    ...PROVENANCE.map((p): DocxParagraph => ({ text: `•  ${p}` })),

    { text: 'Before sending', style: 'Heading1' },
    {
      text:
        `Fill ${SENDER}, ${ROLE}, ${PHONE} and ${ADDRESS}. The postal address is required by ` +
        `CAN-SPAM and there is no version of this send without one. ${UNSUB} should be the ` +
        `sending platform's native token so opt-outs suppress automatically.`,
    },
    {
      text:
        'The offer in paragraph three is a promise to send a real per-firm write-up. Those ' +
        'exist — one per prospect, from the same audit — so a reply can be answered the same ' +
        'day. Do not send this until you are ready to honour that.',
    },
  ];

  return buildDocx(out);
}

function renderText(): string {
  return [
    heading,
    '',
    NOTE,
    '',
    'SUBJECT LINE',
    ...SUBJECTS.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'THE LETTER',
    '',
    ...LETTER.flatMap((p) => [p, '']),
    '--',
    ...FOOTER,
    '',
    'WHERE EVERY NUMBER COMES FROM',
    ...PROVENANCE.map((p) => `  - ${p}`),
    '',
  ].join('\n');
}

const outPath = process.argv[3] ?? `out/letters/${basename(file, '.csv')}-campaign.docx`;
await mkdir(dirname(outPath), { recursive: true });

if (['.txt', '.md'].includes(extname(outPath).toLowerCase())) {
  await writeFile(outPath, renderText(), 'utf8');
} else {
  await writeFile(outPath, renderDocx());
}

console.log(`\n  Campaign letter written to ${outPath}`);
console.log(`  One letter, safe for all ${leads.length} rows (${corpus.n} audited)\n`);

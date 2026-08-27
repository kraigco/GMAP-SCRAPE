import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { buildDocx } from '../src/export/docx.ts';
import type { DocxParagraph } from '../src/export/docx.ts';

/**
 * The global campaign letter — one format, every niche, every country.
 *
 *   node scripts/render-global-letter.ts [out.docx|out.txt]
 *
 * Deliberately NOT built from an audited corpus, unlike the market letter next
 * to it. A corpus figure is true of one niche in one city ("215 property
 * management companies in Philadelphia") and false everywhere else, so a letter
 * that must go anywhere cannot carry one.
 *
 * That removes the measured grounding the other letters lean on, and the
 * replacement is not a softer claim — it is a smaller one. The letter says
 * nothing about the recipient at all. It names a pattern we see, states what we
 * build, and asks. Nobody's tool spend, stack or inefficiency is asserted here,
 * because we have never measured any of it and the reader would know.
 *
 * Contractions throughout, on purpose. This is a letter from a person, and
 * "they have quietly become" is how nobody speaks.
 */

const CONTACT = {
  company: 'Rekreate Digital',
  address:
    '570 Prudencio St., Rubyville Subd., Barangay 160 (Baesa), ' +
    '1400 Caloocan City, Metro Manila, Philippines',
  phone: '+63 956 064 2329',
  email: 'admin@rekreatedigital.com',
};

const SUBJECTS = [
  'how many tools is your team paying for?',
  "you're renting software you could own",
  'the second-biggest line item',
];

/**
 * Logical paragraphs, not pre-wrapped lines — Word reflows to the page and a
 * plain-text export wraps at a column, and neither wants the other's breaks.
 */
const LETTER = [
  'Hi [First name],',

  'Most of the companies we talk to are paying for somewhere between eight and twenty ' +
    'separate tools. A CRM, a scheduler, a form builder, an automation layer stitching three ' +
    'of them together, a reporting add-on because none of them report properly, and two or ' +
    'three nobody remembers signing up for.',

  "Each was a sensible decision on its own. Together they've quietly become one of the " +
    "largest line items in the business — and they still don't quite talk to each other.",

  'We build the thing that replaces them: one system, shaped around how your business ' +
    'actually runs, that you own outright. Not a licence — the code and the data are yours. ' +
    'We build it, you own it, and we stay on to run it.',

  'The arithmetic is usually what lands. Software you rent costs the same next year and the ' +
    'year after, forever, and you can never change it. A custom build is a one-time cost plus ' +
    'support, and it stops climbing.',

  "Tell me the three tools your team complains about most and I'll tell you straight whether " +
    "replacing them is worth it. If it isn't, I'll say so. That answer is free and it costs " +
    'you one reply.',
];

/** The sender's name goes on the blank line. Left empty on instruction. */
const SIGNATURE = ['', CONTACT.company, `${CONTACT.phone} · ${CONTACT.email}`];

const FOOTER = [
  CONTACT.company,
  CONTACT.address,
  "You're receiving this because your business is listed publicly online. If you'd rather " +
    "not hear from me, [unsubscribe] and I'll remove you permanently — one click, no reply " +
    'needed.',
];

const BEFORE_SENDING = [
  'The signature line above the company name is blank — put the sender name there. It is the ' +
    'only slot left, and a signature that opens with a company rather than a person is the ' +
    'first thing a cold reader distrusts.',
  '[First name] needs a fallback in the sending tool, or a recipient with no first name on ' +
    'file gets "Hi ,". "there" is the usual one.',
  '[unsubscribe] should be the sending platform native token so opt-outs suppress ' +
    'automatically. A "reply no" instruction depends on somebody remembering.',
];

/**
 * Sending worldwide is several different legal regimes, not one.
 *
 * The letter is identical everywhere; the permission to send it is not. This is
 * the note that stops one global blast being sent into the strictest of them.
 */
const REGIONS = [
  'United States — CAN-SPAM. Cold B2B is permitted with accurate headers, a working opt-out ' +
    'and a real postal address. The Caloocan address satisfies it; it does not have to be a ' +
    'US one.',
  'Canada — CASL. Consent is required BEFORE sending, and the penalties are severe. Do not ' +
    'put Canadian addresses in a cold blast without checking your basis first.',
  'EU and UK — GDPR. Needs a legitimate-interest basis and a line saying where you got their ' +
    'details. The footer says "listed publicly online", which is that line — keep it true.',
  'Australia — Spam Act. Consent-based, similar in spirit to CASL.',
  'Segment the list by region and send the strict ones separately, or not at all. One global ' +
    'blast is governed by the strictest jurisdiction inside it.',
];

const NOT_DOING = [
  'It never says the reader is overspending, badly served, or inefficient. We have not ' +
    'measured their stack, their spend or their tooling, and they know their own numbers ' +
    'better than we do. The letter describes a pattern we see and asks whether it fits — a ' +
    'question a stranger can answer without being told what their own business is like.',
  'It quotes no statistic. "Most of the companies we talk to" is our own experience and is ' +
    'defensible; a percentage would be a number neither we nor the reader could check.',
  'It offers to talk itself out of the sale. "If it isn\'t, I\'ll say so" is the cheapest ' +
    'credibility available in cold email, and it costs nothing when it is meant.',
  'It carries no deadline, no limited slots and no expiring discount. The reason to reply is ' +
    'that the arithmetic is real, not that a clock is running.',
];

function renderDocx(): Buffer {
  const out: DocxParagraph[] = [
    { text: 'Cold email — Rekreate Digital', style: 'Title' },
    {
      text:
        'One letter, one format, every niche and every country. It makes no claim about the ' +
        'recipient, which is what lets it go to all of them unchanged.',
      style: 'Meta',
    },

    { text: 'Subject line', style: 'Heading1' },
    ...SUBJECTS.map((s, i): DocxParagraph => ({ text: `${i + 1}.  ${s}`, style: 'Mono' })),

    { text: 'The email', style: 'Heading1' },
    ...LETTER.map((p): DocxParagraph => ({ text: p, style: 'Mono' })),
    ...SIGNATURE.map((p): DocxParagraph => ({ text: p, style: 'Mono' })),
    { text: '--', style: 'Mono' },
    ...FOOTER.map((p): DocxParagraph => ({ text: p, style: 'Mono' })),

    { text: 'Before sending', style: 'Heading1', pageBreakBefore: true },
    ...BEFORE_SENDING.map((p): DocxParagraph => ({ text: `•  ${p}` })),

    { text: 'Sending worldwide', style: 'Heading1' },
    ...REGIONS.map((p): DocxParagraph => ({ text: `•  ${p}` })),

    { text: 'What this letter deliberately does not do', style: 'Heading1' },
    ...NOT_DOING.map((p): DocxParagraph => ({ text: `•  ${p}` })),
  ];

  return buildDocx(out);
}

function renderText(): string {
  return [
    'COLD EMAIL — REKREATE DIGITAL',
    '',
    'SUBJECT LINE',
    ...SUBJECTS.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'THE EMAIL',
    '',
    ...LETTER.flatMap((p) => [p, '']),
    ...SIGNATURE,
    '',
    '--',
    ...FOOTER,
    '',
    'BEFORE SENDING',
    ...BEFORE_SENDING.map((p) => `  - ${p}`),
    '',
    'SENDING WORLDWIDE',
    ...REGIONS.map((p) => `  - ${p}`),
    '',
    'WHAT THIS LETTER DELIBERATELY DOES NOT DO',
    ...NOT_DOING.map((p) => `  - ${p}`),
    '',
  ].join('\n');
}

const outPath = process.argv[2] ?? 'out/letters/rekreate-cold-email.docx';
await mkdir(dirname(outPath), { recursive: true });

if (['.txt', '.md'].includes(extname(outPath).toLowerCase())) {
  await writeFile(outPath, renderText(), 'utf8');
} else {
  await writeFile(outPath, renderDocx());
}

console.log(`\n  Written to ${outPath}\n`);

/**
 * `npm run verify:contacts` — re-checks every website, email and phone number
 * on the sheet and writes a list of what is broken.
 *
 * Separate from `npm run verify`, which answers "are OUR credentials working".
 * This one answers "is THEIR contact data still good", which is a different
 * question asked on a different schedule: credentials break at once and loudly,
 * prospect data rots quietly over months.
 *
 * Costs no Places quota. It fetches the prospects' own sites and asks a public
 * DNS resolver; neither touches Google's billed APIs.
 *
 *   node src/cli/verify-contacts.ts                 # read the sheet
 *   node src/cli/verify-contacts.ts --limit 100
 *   node src/cli/verify-contacts.ts --out report.md
 */
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const { loadEnv } = await import('../config/env.ts');
const { fetchStoredLeads } = await import('../export/sheets.ts');
const { verifyContacts, renderReport } = await import('../verify/contacts.ts');

const env = loadEnv();

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const limit = Number(flag('limit') ?? 500);
const out = flag('out') ?? 'out/contact-verification.md';

console.log('\nReading the sheet…');
const stored = await fetchStoredLeads(
  { url: env.SHEETS_WEBAPP_URL ?? '', token: env.SHEETS_INGEST_TOKEN ?? '' },
  { limit },
);

if (!stored.ok) {
  console.error(`\n  Could not read the sheet — ${stored.error}`);
  console.error('  Run `npm run verify` first; this needs the same Web App deployment.\n');
  process.exit(1);
}

if (stored.leads.length === 0) {
  console.error('\n  The sheet returned no rows. Nothing to check.\n');
  process.exit(1);
}

console.log(`  ${stored.leads.length} leads (of ${stored.total} in the sheet)\n`);

const withSite = stored.leads.filter((l) => l.website && l.website !== 'unknown').length;
console.log(`Probing ${withSite} websites — this touches machines we do not own, so it is deliberately unhurried.`);

const { report } = await verifyContacts(stored.leads, {
  onProgress: (done, total) => {
    if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`);
  },
});

console.log(`\nChecking ${report.emailsTested} email addresses…`);

const today = new Date().toISOString().slice(0, 10);
writeFileSync(out, renderReport(report, today));

const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const count = (n: number): string => (n > 0 ? red(String(n)) : green('0'));

console.log('\n  ' + count(report.brokenSites.length) + ` of ${report.sitesTested} websites did not load`);
console.log('  ' + count(report.badEmails.length) + ` of ${report.emailsTested} email addresses cannot receive mail`);
console.log('  ' + count(report.badPhones.length) + ` of ${report.phonesTested} phone numbers are malformed`);

if (report.uncheckedEmails.length > 0) {
  // Loud on purpose. A silent block of unchecked domains is how "all 202 are
  // dead" happened: the check failing must never read as the data failing.
  console.log(
    `  \x1b[33m${report.uncheckedEmails.length}\x1b[0m domains could not be checked at all — ` +
      'that is our lookup failing, not their mail. Re-run.',
  );
}
console.log(`  ${report.blockedSites.length} sites block us in robots.txt (status unknown by choice)`);
console.log(`\n  Written to ${out}\n`);

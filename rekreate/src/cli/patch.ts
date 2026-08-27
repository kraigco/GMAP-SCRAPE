/**
 * `npm run patch` — correct one field on one lead, or a batch from a file.
 *
 * This exists because the upsert cannot do it safely. `pushLeads` rewrites
 * every column a scrape owns, including `last_seen` and `google_refreshed_at`,
 * so using it to clear one email would record a Google refresh that never
 * happened — and that timestamp is what the 30-day cache rule is measured from.
 *
 *   node src/cli/patch.ts --id ChIJ… --column email --value ""
 *   node src/cli/patch.ts --file fixes.json
 *   node src/cli/patch.ts --file fixes.json --dry-run
 *
 * The file is a JSON array of { placeId, column, value }.
 *
 * Prints a before/after for every cell, and says plainly when a cell already
 * held the value asked for — "applied" on an unchanged cell invites you to
 * believe something happened.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { LeadPatch, PatchableColumn } from '../export/sheets.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

const { loadEnv } = await import('../config/env.ts');
const { patchLeads } = await import('../export/sheets.ts');

const env = loadEnv();
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? null);
};
const dryRun = argv.includes('--dry-run');

const PATCHABLE: PatchableColumn[] = [
  'name', 'address', 'phone', 'email', 'email_alt', 'website', 'review_status', 'notes',
];

function usage(problem: string): never {
  console.error(`\n  ${problem}\n`);
  console.error('  node src/cli/patch.ts --id <place_id> --column <column> --value "<value>"');
  console.error('  node src/cli/patch.ts --file <patches.json>\n');
  console.error(`  Patchable columns: ${PATCHABLE.join(', ')}`);
  console.error('  Timestamps and derived columns (hook, score) are deliberately not patchable.\n');
  process.exit(1);
}

let patches: LeadPatch[];

const file = flag('file');
if (file) {
  if (!existsSync(file)) usage(`No such file: ${file}`);
  try {
    patches = JSON.parse(readFileSync(file, 'utf8')) as LeadPatch[];
  } catch (err) {
    usage(`${file} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(patches)) usage(`${file} must hold a JSON array of patches`);
} else {
  const id = flag('id');
  const column = flag('column');
  const value = flag('value');
  if (!id) usage('Missing --id');
  if (!column) usage('Missing --column');
  if (value === null) usage('Missing --value (use --value "" to clear a cell)');
  patches = [{ placeId: id, column: column as PatchableColumn, value }];
}

// Catch a bad column here rather than after a round trip. The Web App checks
// too — this is the fast, offline half of the same rule.
for (const p of patches) {
  if (!PATCHABLE.includes(p.column)) {
    usage(`"${p.column}" is not patchable. Allowed: ${PATCHABLE.join(', ')}`);
  }
}

console.log(`\n  ${patches.length} patch(es):\n`);
for (const p of patches) {
  const shown = p.value === '' ? '(clear)' : p.value;
  console.log(`    ${p.placeId.slice(0, 22)}…  ${p.column} → ${shown}`);
}

if (dryRun) {
  console.log('\n  --dry-run: nothing was sent.\n');
  process.exit(0);
}

const result = await patchLeads(patches, {
  url: env.SHEETS_WEBAPP_URL ?? '',
  token: env.SHEETS_INGEST_TOKEN ?? '',
});

if (!result.ok) {
  console.error(`\n  \x1b[31mRejected\x1b[0m — ${result.error}`);
  console.error('  Nothing was written: the Web App validates the whole batch before writing any of it.\n');
  process.exit(1);
}

console.log('');
for (const a of result.applied) {
  const mark = a.changed ? '\x1b[32m✓\x1b[0m' : '\x1b[33m·\x1b[0m';
  const before = a.before === '' ? '(empty)' : a.before;
  const after = a.after === '' ? '(empty)' : a.after;
  console.log(
    a.changed
      ? `  ${mark} ${a.column}: ${before} → ${after}`
      : `  ${mark} ${a.column}: already ${after} — unchanged`,
  );
}
console.log(`\n  ${result.changed} of ${result.applied.length} cell(s) actually changed.\n`);

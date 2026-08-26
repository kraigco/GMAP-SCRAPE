import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseEnrichedCsv } from '../src/export/csv.ts';
import { parseSearchBaseName } from '../src/export/search-file.ts';
import { buildHook, checkDate } from '../src/pitch/hooks.ts';

/**
 * Read a saved search and print the opening line each lead would get.
 *
 * Outreach copy is the one output nobody should take on trust from a test
 * suite — it goes to real people. This prints it, so it can be read before it
 * is sent.
 *
 *   node scripts/preview-hooks.ts out/searches/<file>.csv [limit]
 */

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/preview-hooks.ts <csv> [limit]');
const limit = Number(process.argv[3] ?? 8);

const leads = parseEnrichedCsv(await readFile(file, 'utf8'));
const meta = parseSearchBaseName(basename(file));
const context = { niche: meta?.niche ?? '', checkedOn: checkDate(meta?.when ?? null) };

console.log(`\n${leads.length} leads — niche "${context.niche}", checked ${context.checkedOn ?? 'date unknown'}\n`);

for (const lead of leads.slice(0, limit)) {
  const hook = buildHook(lead, context);
  console.log(`  ${lead.name}`);
  console.log(`    signals: ${lead.signals.join(', ') || '(none)'}`);
  console.log(hook.text ? `    "${hook.text}"` : `    (no hook — ${hook.reason})`);
  console.log('');
}

const all = leads.map((lead) => buildHook(lead, context));
const counts = new Map<string, number>();
for (const hook of all) {
  const key = hook.text ? hook.basis : 'no hook';
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

console.log(`${all.filter((h) => h.text).length} of ${leads.length} leads have an opening line\n`);
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}
console.log('');

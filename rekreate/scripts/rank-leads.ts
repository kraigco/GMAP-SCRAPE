import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnrichedCsv } from '../src/export/csv.ts';
import type { Lead } from '../src/lead/signals.ts';

/**
 * Print the saved leads in the order the scoring says to work them.
 *
 * The sibling of preview-hooks.ts, and it exists for the same reason: three
 * outreach faults and a whole class of hidden audit gap were found by reading
 * real output, and none of them by reading assertions. A ranking is exactly the
 * kind of thing that passes every unit test and is still obviously wrong the
 * moment a human looks at the top of the list.
 *
 *   node scripts/rank-leads.ts                 all saved searches, top 20
 *   node scripts/rank-leads.ts <csv> [limit]   one file
 */

const SEARCH_DIR = 'out/searches';

async function load(): Promise<Map<string, Lead>> {
  const arg = process.argv[2];
  const files = arg && arg.endsWith('.csv')
    ? [arg]
    : (await readdir(SEARCH_DIR)).filter((f) => f.endsWith('.csv')).map((f) => join(SEARCH_DIR, f));

  // Keyed on place_id so the same business collected by two searches is counted
  // once. Later files win: a re-audit is newer than what it re-audited.
  const byId = new Map<string, Lead>();
  for (const file of files) {
    for (const lead of parseEnrichedCsv(await readFile(file, 'utf8'))) byId.set(lead.id, lead);
  }
  return byId;
}

const limit = Number(process.argv[3] ?? 20);
const leads = [...(await load()).values()].sort((a, b) => b.score.total - a.score.total);

const bands = { hot: 0, warm: 0, cool: 0, cold: 0 };
for (const lead of leads) bands[lead.score.band] += 1;

console.log(`\n${leads.length} leads — ${bands.hot} hot, ${bands.warm} warm, ${bands.cool} cool, ${bands.cold} cold\n`);

for (const lead of leads.slice(0, limit)) {
  const reach = lead.email || lead.phone || 'NO WAY TO REACH THEM';
  console.log(`${String(lead.score.total).padStart(3)}  ${lead.score.band.padEnd(4)}  ${lead.name.slice(0, 44)}`);
  console.log(`      ${reach}`);
  console.log(`      ${lead.score.reasons.join(' · ')}\n`);
}

// The number that decides whether this list is an email campaign or a call
// sheet, printed every time so nobody sizes an ESP plan off the hook count.
const reachable = leads.filter((l) => l.email).length;
console.log(`${reachable} of ${leads.length} have an email address; the rest are phone calls.`);

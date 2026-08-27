import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnrichedCsv } from '../src/export/csv.ts';
import { findDuplicates } from '../src/lead/duplicates.ts';
import type { Lead } from '../src/lead/signals.ts';

/**
 * Show which saved leads would receive the same message twice.
 *
 * Prints the grouping and what each group shares, so the rule can be argued
 * with rather than trusted. Nothing is written or deleted — this reports.
 *
 *   node scripts/find-duplicates.ts
 */

const SEARCH_DIR = 'out/searches';

const byId = new Map<string, Lead>();
for (const file of (await readdir(SEARCH_DIR)).filter((f) => f.endsWith('.csv'))) {
  for (const lead of parseEnrichedCsv(await readFile(join(SEARCH_DIR, file), 'utf8'))) {
    byId.set(lead.id, lead);
  }
}

const leads = [...byId.values()];
const clusters = findDuplicates(leads);
const redundant = clusters.reduce((total, c) => total + c.ids.length - 1, 0);

console.log(`\n${leads.length} leads · ${clusters.length} group(s) reaching the same contact`);
console.log(`${redundant} duplicate send(s) this prevents\n`);

for (const cluster of clusters) {
  console.log(`  shares ${cluster.sharedBy}: ${cluster.value}`);
  for (const id of cluster.ids) {
    const lead = byId.get(id);
    if (!lead) continue;
    console.log(`     ${String(lead.score.total).padStart(3)}  ${lead.name.slice(0, 52)}`);
  }
  console.log('');
}

if (clusters.length === 0) console.log('  Nothing shares a contact route.\n');

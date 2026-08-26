import type { BBox } from '../../lib/bbox.ts';

/**
 * Keywords and markets live here, never in code (rules file, §niches).
 * Changing what we search for must never mean touching a pipeline file.
 */

export type Market = {
  id: string;
  label: string;
  bbox: BBox;
};

export type NicheConfig = {
  id: string;
  label: string;
  keywords: string[];
  markets: Market[];
};

/**
 * Each keyword is a separate sweep of the whole market — Text Search matches on
 * the query text, so "property management company" and "HOA management company"
 * surface genuinely different businesses. Overlap between them is expected and
 * handled by deduping on place_id, not by trying to pick disjoint terms.
 *
 * Cost scales linearly with this list. Eight keywords over a market that tiles
 * to ~40 boxes is the worst case the plan budgets for.
 */
export const propertyManagement: NicheConfig = {
  id: 'property-management',
  label: 'Property management companies',
  keywords: [
    'property management company',
    'residential property management',
    'commercial property management',
    'apartment management company',
    'rental management company',
    'HOA management company',
    'condo association management',
    'real estate management company',
  ],
  markets: [
    {
      id: 'philadelphia-core',
      label: 'Philadelphia (city proper)',
      bbox: { swLat: 39.867, swLng: -75.28, neLat: 40.138, neLng: -74.956 },
    },
    {
      id: 'philadelphia-metro',
      label: 'Greater Philadelphia — Montgomery, Delaware, Bucks, Camden',
      bbox: { swLat: 39.68, swLng: -75.61, neLat: 40.44, neLng: -74.72 },
    },
  ],
};

export const niches: Record<string, NicheConfig> = {
  [propertyManagement.id]: propertyManagement,
};

export function resolveNiche(id: string): NicheConfig {
  const niche = niches[id];
  if (!niche) {
    throw new Error(`Unknown niche "${id}". Available: ${Object.keys(niches).join(', ')}`);
  }
  return niche;
}

export function resolveMarket(niche: NicheConfig, id: string): Market {
  const market = niche.markets.find((m) => m.id === id);
  if (!market) {
    throw new Error(
      `Unknown market "${id}" for niche "${niche.id}". Available: ${niche.markets.map((m) => m.id).join(', ')}`,
    );
  }
  return market;
}

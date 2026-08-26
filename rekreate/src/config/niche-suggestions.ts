/**
 * Niches worth suggesting.
 *
 * Not an arbitrary list of trades — every entry is a local business that
 * (a) depends on being found and booked online, and (b) is small enough that
 * its website is often genuinely neglected. That is the shape of prospect this
 * pipeline is built to find, so the suggestions encode the ICP rather than
 * just filling a dropdown.
 */

export type NicheSuggestion = {
  term: string;
  /** Why this niche tends to produce workable leads. */
  note: string;
  /** Surfaced as a one-click chip rather than buried in the list. */
  featured?: boolean;
};

export const NICHE_SUGGESTIONS: NicheSuggestion[] = [
  { term: 'property management', note: 'Matches the Two River Development case study', featured: true },
  { term: 'dentist', note: 'Booking-driven, high competition, often dated sites', featured: true },
  { term: 'roofing contractor', note: 'Trade work bought on trust and reviews', featured: true },
  { term: 'law firm', note: 'High value per client, conservative web presence', featured: true },
  { term: 'med spa', note: 'Booking and package sales, image-led' },
  { term: 'chiropractor', note: 'Repeat appointments, local search dependent' },
  { term: 'HVAC contractor', note: 'Emergency demand — slow sites lose the call' },
  { term: 'plumber', note: 'Same-day intent, mobile-first or nothing' },
  { term: 'electrician', note: 'Licensed trade, referral heavy' },
  { term: 'landscaping company', note: 'Seasonal, quote-request driven' },
  { term: 'general contractor', note: 'Long sales cycle, portfolio matters' },
  { term: 'auto repair shop', note: 'Local monopoly potential, weak booking' },
  { term: 'veterinarian', note: 'Recurring visits, appointment led' },
  { term: 'accounting firm', note: 'Seasonal peaks, document-heavy intake' },
  { term: 'insurance agency', note: 'Quote forms are the whole funnel' },
  { term: 'real estate agency', note: 'Listing-led, often on rigid platforms' },
  { term: 'moving company', note: 'Quote-driven, heavy comparison shopping' },
  { term: 'self storage facility', note: 'Availability and pricing must be visible' },
  { term: 'gym', note: 'Membership sign-up is the conversion' },
  { term: 'hair salon', note: 'Booking apps common, sites often stale' },
  { term: 'physical therapy clinic', note: 'Referral plus search, insurance questions' },
  { term: 'daycare', note: 'Trust-led, parents research heavily' },
  { term: 'pest control', note: 'Urgent intent, recurring contracts' },
  { term: 'cleaning service', note: 'Recurring revenue, quote forms' },
];

export const FEATURED_NICHES = NICHE_SUGGESTIONS.filter((n) => n.featured);

/**
 * Starting points shown before anyone types. Live autocomplete covers the
 * whole world; these only exist so the empty box is not a blank stare.
 *
 * Rekreate works from Manila and sells into the US, so both belong here — and
 * the rest are simply large metros where local-service businesses cluster.
 * Nothing anywhere restricts search to these; type any place on earth.
 */
export type LocationSeed = { place: string; region: string };

export const LOCATION_SEEDS: LocationSeed[] = [
  // Home
  { place: 'Metro Manila', region: 'Philippines' },
  { place: 'Makati', region: 'Philippines' },
  { place: 'Quezon City', region: 'Philippines' },
  { place: 'Cebu City', region: 'Philippines' },

  // First target market
  { place: 'Philadelphia, PA', region: 'United States' },
  { place: 'Montgomery County, PA', region: 'United States' },
  { place: 'Camden, NJ', region: 'United States' },
  { place: 'Wilmington, DE', region: 'United States' },

  { place: 'London', region: 'United Kingdom' },
  { place: 'Manchester', region: 'United Kingdom' },
  { place: 'Birmingham', region: 'United Kingdom' },
  { place: 'Toronto', region: 'Canada' },
  { place: 'Vancouver', region: 'Canada' },
  { place: 'Calgary', region: 'Canada' },
  { place: 'Sydney', region: 'Australia' },
  { place: 'Melbourne', region: 'Australia' },
  { place: 'Auckland', region: 'New Zealand' },
  { place: 'Singapore', region: 'Singapore' },
  { place: 'Dubai', region: 'United Arab Emirates' },
];

/** Flat list, kept for callers that only need the strings. */
export const LOCATION_SUGGESTIONS: string[] = LOCATION_SEEDS.map((s) => s.place);

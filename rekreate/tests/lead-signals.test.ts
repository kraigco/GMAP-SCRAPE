import { describe, expect, it } from 'vitest';
import { deriveSignals, LOW_RATING, THIN_REVIEW_COUNT, type LeadFacts } from '../src/lead/signals.ts';

/**
 * The two signals added after auditing the real 388-lead corpus.
 *
 * Both exist to turn something we already measured into something a salesperson
 * can filter on. Both are also easy to over-claim, and over-claiming is the one
 * failure this project treats as unacceptable — these emails go to people who
 * know their own business. So the tests here are mostly about when the signal
 * must STAY SILENT.
 */

function lead(over: Partial<LeadFacts> = {}): LeadFacts {
  return {
    id: 'p1', name: 'Firm', address: '', phone: '', website: 'https://acme.test',
    host: 'acme.test', email: 'info@acme.test', emailAlt: [],
    rating: 4.6, reviews: 40, businessStatus: 'OPERATIONAL', primaryType: '',
    lat: null, lng: null, reachable: 'yes', https: 'yes', ttfb: 400,
    viewport: 'yes', contactForm: 'yes', finalUrl: 'https://acme.test/',
    auditError: '', audited: true,
    ...over,
  };
}

describe('no-contact-form', () => {
  it('is raised when the audit finished looking and found none', () => {
    expect(deriveSignals(lead({ contactForm: 'no' }))).toContain('no-contact-form');
  });

  it('is NOT raised on unknown — the search may never have reached the page', () => {
    // This is the whole point of the fix. Before it, 117 of 268 loaded sites
    // sat on 'unknown' and the distinction did not exist to be tested.
    expect(deriveSignals(lead({ contactForm: 'unknown' }))).not.toContain('no-contact-form');
  });

  it('is not raised for a site that has one', () => {
    expect(deriveSignals(lead({ contactForm: 'yes' }))).not.toContain('no-contact-form');
  });
});

describe('low-rating', () => {
  it('is raised when enough people voted to make the score mean something', () => {
    const signals = deriveSignals(lead({ rating: 1.9, reviews: 26 }));
    expect(signals).toContain('low-rating');
  });

  it('stays silent on a bad score from too few reviews', () => {
    // Two unhappy customers out of three is noise, not a business problem, and
    // a filter that says otherwise sends someone chasing a lead that is not there.
    const signals = deriveSignals(lead({ rating: 2.0, reviews: THIN_REVIEW_COUNT - 1 }));
    expect(signals).not.toContain('low-rating');
    expect(signals).toContain('thin-reviews');
  });

  it('stays silent on an unrated business rather than assuming the worst', () => {
    expect(deriveSignals(lead({ rating: null, reviews: null }))).not.toContain('low-rating');
  });

  it('does not fire exactly at the bar', () => {
    expect(deriveSignals(lead({ rating: LOW_RATING, reviews: 200 }))).not.toContain('low-rating');
    expect(deriveSignals(lead({ rating: LOW_RATING - 0.1, reviews: 200 }))).toContain('low-rating');
  });
});

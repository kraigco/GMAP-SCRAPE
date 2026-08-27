import { describe, expect, it } from 'vitest';
import { countableNiche, lookerFor, pluralNiche } from '../src/pitch/niche-language.ts';

/**
 * One campaign letter goes to every trade, so these few words are the only
 * thing standing between "written for us" and "written for someone else and
 * reused". They are also the words most likely to read as machine output if
 * they are got wrong.
 */

describe('countableNiche', () => {
  it('leaves a niche that is already countable alone', () => {
    expect(countableNiche('dental-clinic')).toBe('dental clinic');
    expect(countableNiche('roofing-contractor')).toBe('roofing contractor');
    expect(countableNiche('law firm')).toBe('law firm');
  });

  it('gives a mass noun the head noun it needs to be counted', () => {
    // "every property management" is not a thing you can count.
    expect(countableNiche('property-management')).toBe('property management company');
    expect(countableNiche('roofing')).toBe('roofing company');
    expect(countableNiche('landscaping')).toBe('landscaping company');
  });

  it('treats the saved id and its free-text form identically', () => {
    expect(countableNiche('property-management')).toBe(countableNiche('property management'));
  });

  it('falls back rather than emitting an empty phrase', () => {
    expect(countableNiche('')).toBe('business');
    expect(countableNiche('   ')).toBe('business');
  });
});

describe('pluralNiche', () => {
  it('pluralises the endings that actually occur in trade names', () => {
    expect(pluralNiche('dental-clinic')).toBe('dental clinics');
    expect(pluralNiche('roofing-contractor')).toBe('roofing contractors');
    expect(pluralNiche('property-management')).toBe('property management companies');
  });

  it('handles sibilant and consonant-y endings', () => {
    expect(pluralNiche('med spa')).toBe('med spas');
    expect(pluralNiche('car wash')).toBe('car washes');
    expect(pluralNiche('bakery')).toBe('bakeries');
  });

  it('does not turn a vowel-y ending into -ies', () => {
    expect(pluralNiche('attorney')).toBe('attorneys');
  });

  it('falls back rather than emitting an empty phrase', () => {
    expect(pluralNiche('')).toBe('businesses');
  });
});

describe('lookerFor', () => {
  it('describes the visitor in the trade own terms', () => {
    expect(lookerFor('property-management')).toBe('an owner or a tenant');
    expect(lookerFor('dental-clinic')).toBe('someone deciding where to book');
    expect(lookerFor('roofing-contractor')).toBe('someone with a problem that will not wait');
    expect(lookerFor('law firm')).toBe('a prospective client checking you out before they call');
  });

  it('falls back to a customer rather than guessing at an unknown trade', () => {
    expect(lookerFor('artisanal candle maker')).toBe('a prospective customer');
    expect(lookerFor('')).toBe('a prospective customer');
  });

  it('agrees with the hook audience for the same niche', () => {
    // A niche classified one way for its opening line and another way for its
    // letter would put two different voices in the same envelope.
    expect(lookerFor('property-management')).toBe(lookerFor('property management'));
  });
});

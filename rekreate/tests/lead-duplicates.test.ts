import { describe, expect, it } from 'vitest';
import { collapseDuplicates, findDuplicates, normaliseHost, ownsDomain } from '../src/lead/duplicates.ts';
import { withDerived, type Lead, type LeadFacts } from '../src/lead/signals.ts';

/**
 * Every case below is taken from the real 388-lead corpus, because the obvious
 * rule — match on the business name — was measured against that corpus and
 * found to be wrong in both directions at once: it merged four sets of genuine
 * separate branches, and missed the pairs that actually share an inbox.
 */

function lead(over: Partial<LeadFacts> & { id: string; name: string }): Lead {
  return withDerived({
    address: '', phone: '', website: '', host: '', email: '', emailAlt: [],
    rating: 4.5, reviews: 40, businessStatus: 'OPERATIONAL', primaryType: '',
    lat: null, lng: null, reachable: 'yes', https: 'yes', ttfb: 400,
    viewport: 'yes', contactForm: 'yes', finalUrl: '', auditError: '', audited: true,
    ...over,
  });
}

describe('what it groups', () => {
  it('groups two branches that publish the same address', () => {
    // Affinity Dental Makati and Ortigas, both info@affinitydentalclinics.com.
    const leads = [
      lead({ id: 'a', name: 'Affinity Dental Clinics Makati', email: 'info@affinitydentalclinics.com' }),
      lead({ id: 'b', name: 'Affinity Dental Clinics Ortigas', email: 'info@affinitydentalclinics.com' }),
    ];
    const [cluster] = findDuplicates(leads);
    expect(cluster?.ids).toEqual(['a', 'b']);
    expect(cluster?.sharedBy).toBe('email');
  });

  it('groups two listings on one phone line, however it is punctuated', () => {
    const leads = [
      lead({ id: 'a', name: 'Matthew J Grace - Real Estate', phone: '(267) 984-7348' }),
      lead({ id: 'b', name: 'mattmanngroup', phone: '267-984-7348' }),
    ];
    expect(findDuplicates(leads)[0]?.sharedBy).toBe('phone');
  });

  it('groups offices on a firm\'s own domain even with different phones', () => {
    const leads = [
      lead({ id: 'a', name: 'Lindy Properties', website: 'https://www.lindyproperty.com/', phone: '215 549 3909' }),
      lead({ id: 'b', name: 'Lindy Communities', website: 'https://lindyproperty.com/x', phone: '215 886 8030' }),
    ];
    const [cluster] = findDuplicates(leads);
    expect(cluster?.sharedBy).toBe('website');
    expect(cluster?.value).toBe('lindyproperty.com');
  });
});

describe('what it must NOT group', () => {
  it('leaves eleven clinics alone for sharing a Facebook page', () => {
    // The measured case that makes a naive website rule dangerous.
    const leads = [
      lead({ id: 'a', name: 'Iconic Smile Dental Clinic', website: 'https://facebook.com/iconic' }),
      lead({ id: 'b', name: 'Ramirez Dental Clinic', website: 'https://facebook.com/ramirez' }),
      lead({ id: 'c', name: 'SmileHQ Dental Clinic', website: 'https://www.facebook.com/hq' }),
    ];
    expect(findDuplicates(leads)).toEqual([]);
  });

  it('leaves clinics alone for appearing in the same directory', () => {
    const leads = [
      lead({ id: 'a', name: 'Ivory Smile Dental Clinic Makati Branch', website: 'https://cebudentalimplants.com/a' }),
      lead({ id: 'b', name: 'SA19 Letooth Dental Clinic - Makati', website: 'https://cebudentalimplants.com/b' }),
    ];
    expect(findDuplicates(leads)).toEqual([]);
  });

  it('keeps two real branches of one firm apart when nothing is shared', () => {
    // Renzi in Moorestown NJ and Elkins Park PA: same name, own phone each.
    // Two offices, two managers, two calls — merging loses a prospect.
    const leads = [
      lead({ id: 'a', name: 'Renzi Property Management', phone: '(856) 914-0916' }),
      lead({ id: 'b', name: 'Renzi Property Management', phone: '(800) 514-3235' }),
    ];
    expect(findDuplicates(leads)).toEqual([]);
  });

  it('ignores a two-letter host, which matches far too much to be evidence', () => {
    const leads = [
      lead({ id: 'a', name: 'Concierge Property Management, LLC', website: 'https://fb.me/a' }),
      lead({ id: 'b', name: 'Princesa-Arriola Dental Clinic', website: 'https://fb.me/b' }),
    ];
    expect(findDuplicates(leads)).toEqual([]);
  });
});

describe('ownsDomain', () => {
  it('accepts a domain whose label is in the name', () => {
    expect(ownsDomain('BrightSmile Avenue Dental Clinic', 'brightsmileavenue.com')).toBe(true);
  });

  it('accepts an abbreviated domain the name\'s first word explains', () => {
    expect(ownsDomain('Philly Property Management LLC', 'phillypm.com')).toBe(true);
    expect(ownsDomain('Chevron Realty Management LLC', 'chevronprop.com')).toBe(true);
  });

  it('rejects a domain with nothing to do with the name', () => {
    expect(ownsDomain('SmileON Dental Clinic', 'cebudentalimplants.com')).toBe(false);
    expect(ownsDomain('Iconic Smile Dental Clinic', 'facebook.com')).toBe(false);
  });
});

describe('reporting and collapsing', () => {
  it('reports a pair once, under its strongest evidence', () => {
    // Shares an email AND a domain. Reported as email, and only once, or the
    // "duplicate sends prevented" count is inflated.
    const leads = [
      lead({ id: 'a', name: 'Philly Property Management LLC', email: 'thephillypm@gmail.com', website: 'https://phillypm.com' }),
      lead({ id: 'b', name: 'Philly Property Management Montgomery County', email: 'thephillypm@gmail.com', website: 'https://phillypm.com' }),
    ];
    const clusters = findDuplicates(leads);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sharedBy).toBe('email');
  });

  it('keeps the higher-scoring member when collapsing', () => {
    const leads = [
      lead({ id: 'weak', name: 'Acme Makati', email: 'info@acme.test', reviews: 2, phone: '' }),
      lead({ id: 'strong', name: 'Acme Ortigas', email: 'info@acme.test', reviews: 400, phone: '555' }),
    ];
    expect(collapseDuplicates(leads).map((l) => l.id)).toEqual(['strong']);
  });

  it('returns the list untouched when nothing is shared', () => {
    const leads = [lead({ id: 'a', name: 'A', phone: '1' }), lead({ id: 'b', name: 'B', phone: '2' })];
    expect(collapseDuplicates(leads)).toHaveLength(2);
  });

  it('normalises a host the way two listings of one site would differ', () => {
    expect(normaliseHost('https://WWW.Acme.com/contact?x=1')).toBe('acme.com');
  });
});

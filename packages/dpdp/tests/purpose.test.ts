import { describe, it, expect } from 'vitest';
import { PurposeRegistry } from '../src/purpose/purpose-registry.js';
import type { RegisteredPurpose, ConsentPurpose } from '../src/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makePurpose(overrides?: Partial<RegisteredPurpose>): RegisteredPurpose {
  return {
    purposeId: 'email-access',
    name: 'Email Access',
    description: 'Read and send emails on behalf of the user',
    requiredScopes: ['email:read', 'email:send'],
    legalBasis: 'consent',
    dataCategories: ['email', 'contacts'],
    retentionPeriod: '1 year',
    thirdPartySharing: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('PurposeRegistry', () => {
  describe('register and get', () => {
    it('registers and retrieves a purpose by ID', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose());

      const purpose = registry.get('email-access');
      expect(purpose).toBeDefined();
      expect(purpose!.name).toBe('Email Access');
      expect(purpose!.requiredScopes).toEqual(['email:read', 'email:send']);
    });

    it('returns undefined for non-existent purpose', () => {
      const registry = new PurposeRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('overwrites purpose with same ID on re-register', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose({ name: 'Original' }));
      registry.register(makePurpose({ name: 'Updated' }));

      const purpose = registry.get('email-access');
      expect(purpose!.name).toBe('Updated');
    });

    it('stores a defensive copy (original mutation does not affect stored)', () => {
      const registry = new PurposeRegistry();
      const original = makePurpose();
      registry.register(original);

      // Mutate the original object
      original.name = 'Mutated';

      const stored = registry.get('email-access');
      expect(stored!.name).toBe('Email Access');
    });
  });

  describe('listAll', () => {
    it('returns empty array when no purposes registered', () => {
      const registry = new PurposeRegistry();
      expect(registry.listAll()).toEqual([]);
    });

    it('returns all registered purposes', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose({ purposeId: 'p1', name: 'Purpose 1' }));
      registry.register(makePurpose({ purposeId: 'p2', name: 'Purpose 2' }));
      registry.register(makePurpose({ purposeId: 'p3', name: 'Purpose 3' }));

      const all = registry.listAll();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.purposeId).sort()).toEqual(['p1', 'p2', 'p3']);
    });
  });

  describe('getScopesForPurpose', () => {
    it('returns scopes for a registered purpose', () => {
      const registry = new PurposeRegistry();
      registry.register(
        makePurpose({
          purposeId: 'calendar',
          requiredScopes: ['calendar:read', 'calendar:write'],
        }),
      );

      expect(registry.getScopesForPurpose('calendar')).toEqual([
        'calendar:read',
        'calendar:write',
      ]);
    });

    it('returns undefined for unregistered purpose', () => {
      const registry = new PurposeRegistry();
      expect(registry.getScopesForPurpose('missing')).toBeUndefined();
    });

    it('returns empty array for purpose with no required scopes', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose({ purposeId: 'no-scopes', requiredScopes: [] }));
      expect(registry.getScopesForPurpose('no-scopes')).toEqual([]);
    });
  });

  describe('toConsentPurpose', () => {
    it('converts registered purpose to ConsentPurpose', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose());

      const cp = registry.toConsentPurpose('email-access');
      expect(cp).toBeDefined();
      expect(cp!.purposeId).toBe('email-access');
      expect(cp!.name).toBe('Email Access');
      expect(cp!.description).toBe('Read and send emails on behalf of the user');
      expect(cp!.legalBasis).toBe('consent');
      expect(cp!.dataCategories).toEqual(['email', 'contacts']);
      expect(cp!.retentionPeriod).toBe('1 year');
      expect(cp!.thirdPartySharing).toBe(false);
    });

    it('returns undefined for non-existent purpose', () => {
      const registry = new PurposeRegistry();
      expect(registry.toConsentPurpose('missing')).toBeUndefined();
    });

    it('includes thirdParties when present', () => {
      const registry = new PurposeRegistry();
      registry.register(
        makePurpose({
          purposeId: 'sharing',
          thirdPartySharing: true,
          thirdParties: ['Analytics Corp', 'Ad Network'],
        }),
      );

      const cp = registry.toConsentPurpose('sharing');
      expect(cp!.thirdPartySharing).toBe(true);
      expect(cp!.thirdParties).toEqual(['Analytics Corp', 'Ad Network']);
    });

    it('omits thirdParties when not present', () => {
      const registry = new PurposeRegistry();
      registry.register(makePurpose({ purposeId: 'no-third' }));

      const cp = registry.toConsentPurpose('no-third');
      expect(cp!.thirdParties).toBeUndefined();
    });

    it('maps all fields correctly for complex purpose', () => {
      const registry = new PurposeRegistry();
      registry.register({
        purposeId: 'complex',
        name: 'Complex Processing',
        description: 'Multiple data categories with third parties',
        requiredScopes: ['data:read', 'data:write', 'data:export'],
        legalBasis: 'legitimate-interest',
        dataCategories: ['personal', 'financial', 'health'],
        retentionPeriod: '5 years',
        thirdPartySharing: true,
        thirdParties: ['Partner A', 'Partner B'],
      });

      const cp = registry.toConsentPurpose('complex');
      expect(cp!.legalBasis).toBe('legitimate-interest');
      expect(cp!.dataCategories).toEqual(['personal', 'financial', 'health']);
      expect(cp!.retentionPeriod).toBe('5 years');
      expect(cp!.thirdParties).toHaveLength(2);
    });
  });

  describe('multiple registries are independent', () => {
    it('registrations in one registry do not affect another', () => {
      const r1 = new PurposeRegistry();
      const r2 = new PurposeRegistry();

      r1.register(makePurpose({ purposeId: 'only-in-r1' }));

      expect(r1.get('only-in-r1')).toBeDefined();
      expect(r2.get('only-in-r1')).toBeUndefined();
      expect(r2.listAll()).toHaveLength(0);
    });
  });
});

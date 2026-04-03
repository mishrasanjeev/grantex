import { describe, it, expect } from 'vitest';
import {
  PurposeRegistry,
  enforcePurpose,
  checkPurposeCompliance,
  PurposeViolationError,
} from '../src/index.js';
import type { DPDPConsentRecord, RegisteredPurpose } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeRecord(overrides?: Partial<DPDPConsentRecord>): DPDPConsentRecord {
  return {
    recordId: 'rec_001',
    grantId: 'grant_abc',
    dataPrincipalId: 'principal_1',
    dataFiduciaryId: 'fid_1',
    dataFiduciaryName: 'Acme Corp',
    purposes: [
      {
        purposeId: 'email-access',
        name: 'Email Access',
        description: 'Read and send emails',
        legalBasis: 'consent',
        dataCategories: ['email'],
        retentionPeriod: '1 year',
        thirdPartySharing: false,
      },
    ],
    scopes: ['email:read', 'email:send'],
    consentNoticeId: 'notice_1',
    consentNoticeHash: 'hash123',
    consentGivenAt: new Date(),
    consentMethod: 'explicit-click',
    processingExpiresAt: new Date(Date.now() + 86400000),
    retentionUntil: new Date(Date.now() + 86400000 * 365),
    consentProof: { signedAt: new Date(), signature: 'sig' },
    status: 'active',
    accessCount: 0,
    actions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('purpose-enforcer', () => {
  it('purpose enforcement passes when scopes match', () => {
    const registry = new PurposeRegistry();
    registry.register(makePurpose());

    // Grant has all required scopes — should not throw
    expect(() =>
      enforcePurpose(['email:read', 'email:send', 'calendar:read'], 'email-access', registry),
    ).not.toThrow();
  });

  it('purpose enforcement fails when scopes missing', () => {
    const registry = new PurposeRegistry();
    registry.register(makePurpose());

    // Grant is missing email:send
    expect(() =>
      enforcePurpose(['email:read'], 'email-access', registry),
    ).toThrow(PurposeViolationError);

    try {
      enforcePurpose(['email:read'], 'email-access', registry);
    } catch (err) {
      const e = err as PurposeViolationError;
      expect(e.missingScopes).toEqual(['email:send']);
      expect(e.code).toBe('PURPOSE_VIOLATION');
    }
  });

  it('purpose registry maps purposes to scopes correctly', () => {
    const registry = new PurposeRegistry();

    registry.register(makePurpose({ purposeId: 'email', requiredScopes: ['email:read'] }));
    registry.register(
      makePurpose({
        purposeId: 'calendar',
        name: 'Calendar Access',
        requiredScopes: ['calendar:read', 'calendar:write'],
      }),
    );

    expect(registry.getScopesForPurpose('email')).toEqual(['email:read']);
    expect(registry.getScopesForPurpose('calendar')).toEqual(['calendar:read', 'calendar:write']);
    expect(registry.getScopesForPurpose('nonexistent')).toBeUndefined();

    const all = registry.listAll();
    expect(all).toHaveLength(2);
  });

  it('checkPurposeCompliance validates record purpose definitions', () => {
    // Valid record
    const validRecord = makeRecord();
    expect(checkPurposeCompliance(validRecord)).toEqual([]);

    // Record with missing purpose fields
    const badRecord = makeRecord({
      purposes: [
        {
          purposeId: '',
          name: '',
          description: '',
          legalBasis: 'consent',
          dataCategories: [],
          retentionPeriod: '',
          thirdPartySharing: false,
        },
      ],
    });
    const errors = checkPurposeCompliance(badRecord);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('purposeId'))).toBe(true);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('checkPurposeCompliance rejects withdrawn records', () => {
    const withdrawnRecord = makeRecord({ status: 'withdrawn' });
    const errors = checkPurposeCompliance(withdrawnRecord);
    expect(errors.some((e) => e.includes('withdrawn'))).toBe(true);
  });
});

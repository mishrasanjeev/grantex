import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withdrawConsent,
  ConsentRegistry,
  WithdrawalError,
  checkPurposeCompliance,
} from '../src/index.js';
import type { DPDPConsentRecord } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(): DPDPConsentRecord {
  return {
    recordId: 'rec_001',
    grantId: 'grant_abc',
    dataPrincipalId: 'principal_1',
    dataFiduciaryId: 'fid_1',
    dataFiduciaryName: 'Acme Corp',
    purposes: [
      {
        purposeId: 'p1',
        name: 'Email Access',
        description: 'Read and send emails',
        legalBasis: 'consent',
        dataCategories: ['email'],
        retentionPeriod: '1 year',
        thirdPartySharing: false,
      },
    ],
    scopes: ['email:read'],
    consentNoticeId: 'notice_1',
    consentNoticeHash: 'hash123',
    consentGivenAt: new Date('2026-01-01T00:00:00Z'),
    consentMethod: 'explicit-click',
    processingExpiresAt: new Date('2027-01-01T00:00:00Z'),
    retentionUntil: new Date('2028-01-01T00:00:00Z'),
    consentProof: { signedAt: new Date('2026-01-01T00:00:00Z'), signature: 'sig' },
    status: 'active',
    accessCount: 5,
    actions: [
      {
        actionId: 'act_1',
        timestamp: new Date('2026-03-01T00:00:00Z'),
        action: 'email:read',
        agentId: 'agent_x',
        result: 'success',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withdrawal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('withdrawal updates status to withdrawn immediately', async () => {
    const withdrawnAt = new Date().toISOString();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            recordId: 'rec_001',
            status: 'withdrawn',
            withdrawnAt,
            grantRevoked: false,
            dataDeleted: false,
          }),
      }),
    );

    const confirmation = await withdrawConsent('rec_001', 'No longer needed', {
      apiKey: 'test-key',
      baseUrl: 'https://api.test.local',
    });

    expect(confirmation.status).toBe('withdrawn');
    expect(confirmation.recordId).toBe('rec_001');
    expect(confirmation.withdrawnAt).toBeInstanceOf(Date);
  });

  it('withdrawal with revokeGrant=true revokes grant token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            recordId: 'rec_001',
            status: 'withdrawn',
            withdrawnAt: new Date().toISOString(),
            grantRevoked: true,
            dataDeleted: false,
          }),
      }),
    );

    const confirmation = await withdrawConsent('rec_001', 'Revoking access', {
      revokeGrant: true,
      apiKey: 'test-key',
      baseUrl: 'https://api.test.local',
    });

    expect(confirmation.grantRevoked).toBe(true);

    // Verify request body included revokeGrant flag
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.revokeGrant).toBe(true);
  });

  it('agent action rejected after withdrawal', () => {
    const registry = new ConsentRegistry();
    const record = makeRecord();
    registry.register(record);

    // Withdraw
    registry.markWithdrawn('rec_001', 'User requested withdrawal');

    const withdrawn = registry.get('rec_001')!;
    expect(withdrawn.status).toBe('withdrawn');

    // Purpose compliance check should fail for withdrawn records
    const errors = checkPurposeCompliance(withdrawn);
    expect(errors.some((e) => e.includes('withdrawn'))).toBe(true);
  });

  it('withdrawal is recorded with timestamp', async () => {
    const beforeWithdrawal = new Date();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            recordId: 'rec_001',
            status: 'withdrawn',
            withdrawnAt: new Date().toISOString(),
            grantRevoked: false,
            dataDeleted: false,
          }),
      }),
    );

    const confirmation = await withdrawConsent('rec_001', 'Testing', {
      apiKey: 'test-key',
      baseUrl: 'https://api.test.local',
    });

    expect(confirmation.withdrawnAt.getTime()).toBeGreaterThanOrEqual(
      beforeWithdrawal.getTime(),
    );
  });
});

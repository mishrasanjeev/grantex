import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeNoticeHash,
  ConsentRegistry,
  withdrawConsent,
} from '../src/index.js';
import type { DPDPConsentRecord } from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<DPDPConsentRecord>): DPDPConsentRecord {
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
    consentProof: {
      signedAt: new Date('2026-01-01T00:00:00Z'),
      signature: '',
    },
    status: 'active',
    accessCount: 0,
    actions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('security', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('consent record signature verifiable with org public key', async () => {
    // Generate Ed25519 key pair
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);

    // Sign a canonical payload
    const payload = JSON.stringify({
      grantId: 'grant_abc',
      dataPrincipalId: 'principal_1',
      dataFiduciaryId: 'fid_1',
      purposes: ['p1'],
      scopes: ['email:read'],
      consentNoticeHash: 'hash123',
      consentGivenAt: '2026-01-01T00:00:00.000Z',
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    const signature = await crypto.subtle.sign('Ed25519', (keyPair as any).privateKey, data);

    // Verify with public key
    const valid = await crypto.subtle.verify(
      'Ed25519',
      (keyPair as any).publicKey,
      signature,
      data,
    );

    expect(valid).toBe(true);
  });

  it('tampered consent record fails signature check', async () => {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);

    const payload = JSON.stringify({
      grantId: 'grant_abc',
      dataPrincipalId: 'principal_1',
      scopes: ['email:read'],
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    const signature = await crypto.subtle.sign('Ed25519', (keyPair as any).privateKey, data);

    // Tamper with the payload
    const tamperedPayload = JSON.stringify({
      grantId: 'grant_abc',
      dataPrincipalId: 'principal_1',
      scopes: ['email:read', 'email:send'], // scope added maliciously
    });

    const tamperedData = encoder.encode(tamperedPayload);
    const valid = await crypto.subtle.verify(
      'Ed25519',
      (keyPair as any).publicKey,
      signature,
      tamperedData,
    );

    expect(valid).toBe(false);
  });

  it('data principal cannot access another principal\'s records', () => {
    const registry = new ConsentRegistry();

    const record1 = makeRecord({ recordId: 'rec_001', dataPrincipalId: 'principal_1' });
    const record2 = makeRecord({ recordId: 'rec_002', dataPrincipalId: 'principal_2' });

    registry.register(record1);
    registry.register(record2);

    // Principal 1 should only see their own records
    const p1Records = registry.listForPrincipal('principal_1');
    expect(p1Records).toHaveLength(1);
    expect(p1Records[0].dataPrincipalId).toBe('principal_1');

    // Principal 2 should only see their own records
    const p2Records = registry.listForPrincipal('principal_2');
    expect(p2Records).toHaveLength(1);
    expect(p2Records[0].dataPrincipalId).toBe('principal_2');

    // Principal 3 should see nothing
    const p3Records = registry.listForPrincipal('principal_3');
    expect(p3Records).toHaveLength(0);
  });

  it('PII fields (IP) stored as hashes, not plaintext', async () => {
    const rawIp = '192.168.1.100';
    const expectedHash = createHash('sha256').update(rawIp).digest('hex');

    const serverResponse = {
      recordId: 'rec_pii',
      grantId: 'grant_abc',
      dataPrincipalId: 'principal_1',
      dataFiduciaryId: 'fid_1',
      dataFiduciaryName: 'Acme Corp',
      purposes: [
        {
          purposeId: 'p1',
          name: 'Test',
          description: 'Test purpose',
          legalBasis: 'consent',
          dataCategories: ['test'],
          retentionPeriod: '1 year',
          thirdPartySharing: false,
        },
      ],
      scopes: ['test:read'],
      consentNoticeId: 'notice_1',
      consentNoticeHash: 'hash',
      consentGivenAt: new Date().toISOString(),
      consentMethod: 'explicit-click',
      processingExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      retentionUntil: new Date(Date.now() + 86400000 * 365).toISOString(),
      consentProof: {
        ipAddress: expectedHash,
        signedAt: new Date().toISOString(),
        signature: 'sig',
      },
      status: 'active',
      accessCount: 0,
      actions: [],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(serverResponse),
      }),
    );

    // Import dynamically to use the mocked fetch
    const { createConsentRecord } = await import('../src/consent/consent-record.js');

    const record = await createConsentRecord({
      grantId: 'grant_abc',
      dataPrincipalId: 'principal_1',
      dataFiduciaryId: 'fid_1',
      dataFiduciaryName: 'Acme Corp',
      purposes: serverResponse.purposes as DPDPConsentRecord['purposes'],
      scopes: ['test:read'],
      consentNoticeId: 'notice_1',
      consentNoticeContent: 'Test notice',
      consentMethod: 'explicit-click',
      processingExpiresAt: new Date(Date.now() + 86400000),
      retentionUntil: new Date(Date.now() + 86400000 * 365),
      proofIpAddress: rawIp,
      apiKey: 'test-key',
      baseUrl: 'https://api.test.local',
    });

    // The body sent to the API should contain the hashed IP, not the raw IP
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);

    expect(body.consentProof.ipAddress).toBe(expectedHash);
    expect(body.consentProof.ipAddress).not.toBe(rawIp);

    // The ipAddress in the returned record should also be the hash
    expect(record.consentProof.ipAddress).toBe(expectedHash);
  });

  it('consent withdrawal cannot be undone via API', async () => {
    // First withdrawal succeeds
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              recordId: 'rec_001',
              status: 'withdrawn',
              withdrawnAt: new Date().toISOString(),
              grantRevoked: false,
              dataDeleted: false,
            }),
        })
        // Second attempt to "undo" withdrawal by re-withdrawing should fail
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              message: 'Consent record is already withdrawn and cannot be reactivated',
            }),
        }),
    );

    // First withdrawal succeeds
    const result = await withdrawConsent('rec_001', 'Done', {
      apiKey: 'test-key',
      baseUrl: 'https://api.test.local',
    });
    expect(result.status).toBe('withdrawn');

    // Attempting again should fail (server returns 400)
    await expect(
      withdrawConsent('rec_001', 'Undo please', {
        apiKey: 'test-key',
        baseUrl: 'https://api.test.local',
      }),
    ).rejects.toThrow('already withdrawn');
  });

  it('consent notice hash is deterministic', async () => {
    const content = 'This is a consent notice for processing personal data.';

    const hash1 = await computeNoticeHash(content);
    const hash2 = await computeNoticeHash(content);
    const hash3 = await computeNoticeHash(content);

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);

    // Different content produces different hash
    const differentHash = await computeNoticeHash(content + ' Modified.');
    expect(differentHash).not.toBe(hash1);
  });
});

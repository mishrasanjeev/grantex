import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createConsentRecord,
  computeNoticeHash,
  ConsentRegistry,
} from '../src/index.js';
import type { CreateConsentRecordOptions, DPDPConsentRecord } from '../src/index.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const MOCK_RECORD: DPDPConsentRecord = {
  recordId: 'rec_001',
  grantId: 'grant_abc',
  dataPrincipalId: 'principal_1',
  dataFiduciaryId: 'fid_1',
  dataFiduciaryName: 'Acme Corp',
  purposes: [
    {
      purposeId: 'p1',
      name: 'Email Access',
      description: 'Read and send emails on behalf of the user',
      legalBasis: 'consent',
      dataCategories: ['email', 'contacts'],
      retentionPeriod: '1 year',
      thirdPartySharing: false,
    },
  ],
  scopes: ['email:read', 'email:send'],
  consentNoticeId: 'notice_1',
  consentNoticeHash: 'abc123hash',
  consentGivenAt: new Date('2026-01-01T00:00:00Z'),
  consentMethod: 'explicit-click',
  processingExpiresAt: new Date('2027-01-01T00:00:00Z'),
  retentionUntil: new Date('2028-01-01T00:00:00Z'),
  consentProof: {
    signedAt: new Date('2026-01-01T00:00:00Z'),
    signature: 'ed25519sig==',
  },
  status: 'active',
  accessCount: 0,
  actions: [],
};

function mockFetchSuccess(data: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function makeOptions(overrides?: Partial<CreateConsentRecordOptions>): CreateConsentRecordOptions {
  return {
    grantId: 'grant_abc',
    dataPrincipalId: 'principal_1',
    dataFiduciaryId: 'fid_1',
    dataFiduciaryName: 'Acme Corp',
    purposes: [
      {
        purposeId: 'p1',
        name: 'Email Access',
        description: 'Read and send emails on behalf of the user',
        legalBasis: 'consent',
        dataCategories: ['email', 'contacts'],
        retentionPeriod: '1 year',
        thirdPartySharing: false,
      },
    ],
    scopes: ['email:read', 'email:send'],
    consentNoticeId: 'notice_1',
    consentNoticeContent: 'We will process your email data for agent access.',
    consentMethod: 'explicit-click',
    processingExpiresAt: new Date('2027-01-01T00:00:00Z'),
    retentionUntil: new Date('2028-01-01T00:00:00Z'),
    apiKey: 'test-api-key',
    baseUrl: 'https://api.test.local',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('consent-record', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates consent record linked to grant token', async () => {
    const serverResponse = {
      ...MOCK_RECORD,
      consentGivenAt: MOCK_RECORD.consentGivenAt.toISOString(),
      processingExpiresAt: MOCK_RECORD.processingExpiresAt.toISOString(),
      retentionUntil: MOCK_RECORD.retentionUntil.toISOString(),
      consentProof: {
        ...MOCK_RECORD.consentProof,
        signedAt: MOCK_RECORD.consentProof.signedAt.toISOString(),
      },
    };

    vi.stubGlobal('fetch', mockFetchSuccess(serverResponse));

    const record = await createConsentRecord(makeOptions());

    expect(record.recordId).toBe('rec_001');
    expect(record.grantId).toBe('grant_abc');
    expect(record.dataPrincipalId).toBe('principal_1');
    expect(record.status).toBe('active');

    // Verify fetch was called with correct URL
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.test.local/v1/dpdp/consent-records');

    // Verify body includes grantId link
    const body = JSON.parse(fetchCall[1].body);
    expect(body.grantId).toBe('grant_abc');
  });

  it('stores Ed25519 signature over consent record', async () => {
    // Generate an Ed25519 key pair using Web Crypto API
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);

    const serverResponse = {
      ...MOCK_RECORD,
      consentGivenAt: MOCK_RECORD.consentGivenAt.toISOString(),
      processingExpiresAt: MOCK_RECORD.processingExpiresAt.toISOString(),
      retentionUntil: MOCK_RECORD.retentionUntil.toISOString(),
      consentProof: {
        signedAt: new Date().toISOString(),
        signature: 'test-sig-value',
      },
    };

    vi.stubGlobal('fetch', mockFetchSuccess(serverResponse));

    const record = await createConsentRecord(
      makeOptions({ signingKey: (keyPair as any).privateKey }),
    );

    // The server response has the signature
    expect(record.consentProof.signature).toBeTruthy();

    // The body sent to the API should include a signature in consentProof
    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.consentProof.signature).toBeTruthy();
    expect(body.consentProof.signature.length).toBeGreaterThan(0);
  });

  it('rejects creation without mandatory purpose fields', async () => {
    await expect(
      createConsentRecord(
        makeOptions({
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
        }),
      ),
    ).rejects.toThrow('missing mandatory fields');
  });

  it('stores consent notice hash (SHA-256)', async () => {
    const noticeContent = 'We will process your email data for agent access.';
    const hash = await computeNoticeHash(noticeContent);

    // SHA-256 produces 64 hex characters
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Hash should be deterministic
    const hash2 = await computeNoticeHash(noticeContent);
    expect(hash).toBe(hash2);

    // Verify the hash is sent to the server
    const serverResponse = {
      ...MOCK_RECORD,
      consentNoticeHash: hash,
      consentGivenAt: MOCK_RECORD.consentGivenAt.toISOString(),
      processingExpiresAt: MOCK_RECORD.processingExpiresAt.toISOString(),
      retentionUntil: MOCK_RECORD.retentionUntil.toISOString(),
      consentProof: {
        ...MOCK_RECORD.consentProof,
        signedAt: MOCK_RECORD.consentProof.signedAt.toISOString(),
      },
    };

    vi.stubGlobal('fetch', mockFetchSuccess(serverResponse));

    await createConsentRecord(
      makeOptions({ consentNoticeContent: noticeContent }),
    );

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.consentNoticeHash).toBe(hash);
  });

  it('consent record is immutable after creation', () => {
    const registry = new ConsentRegistry();
    registry.register(MOCK_RECORD);

    // Attempting to register the same record again should throw
    expect(() => registry.register(MOCK_RECORD)).toThrow('immutable');

    // The record returned should be frozen
    const retrieved = registry.get('rec_001');
    expect(retrieved).toBeDefined();
    expect(Object.isFrozen(retrieved)).toBe(true);
  });
});

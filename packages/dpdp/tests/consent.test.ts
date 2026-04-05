import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeNoticeHash,
  validateNotice,
  createConsentNotice,
} from '../src/consent/consent-notice.js';
import { ConsentRegistry } from '../src/consent/consent-registry.js';
import { DpdpError } from '../src/errors.js';
import type { ConsentNotice, DPDPConsentRecord } from '../src/types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeNotice(overrides?: Partial<ConsentNotice>): ConsentNotice {
  return {
    noticeId: 'notice_01',
    language: 'en',
    version: '1.0',
    title: 'Data Processing Notice',
    content: 'We process your data for the following purposes.',
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
    dataFiduciaryContact: 'privacy@example.com',
    contentHash: 'hash_placeholder',
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
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  consent-notice tests                                               */
/* ------------------------------------------------------------------ */

describe('consent-notice', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('computeNoticeHash', () => {
    it('produces a 64-char hex SHA-256 hash', async () => {
      const hash = await computeNoticeHash('test content');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces deterministic output', async () => {
      const h1 = await computeNoticeHash('same input');
      const h2 = await computeNoticeHash('same input');
      expect(h1).toBe(h2);
    });

    it('produces different hashes for different content', async () => {
      const h1 = await computeNoticeHash('content A');
      const h2 = await computeNoticeHash('content B');
      expect(h1).not.toBe(h2);
    });

    it('handles empty string', async () => {
      const hash = await computeNoticeHash('');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles Unicode content', async () => {
      const hash = await computeNoticeHash('हम आपका डेटा प्रोसेस करते हैं');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('validateNotice', () => {
    it('returns empty array for valid notice', () => {
      const errors = validateNotice(makeNotice());
      expect(errors).toEqual([]);
    });

    it('reports missing noticeId', () => {
      const errors = validateNotice(makeNotice({ noticeId: '' }));
      expect(errors).toContain('noticeId is required');
    });

    it('reports missing language', () => {
      const errors = validateNotice(makeNotice({ language: '' }));
      expect(errors).toContain('language is required');
    });

    it('reports missing version', () => {
      const errors = validateNotice(makeNotice({ version: '' }));
      expect(errors).toContain('version is required');
    });

    it('reports missing title', () => {
      const errors = validateNotice(makeNotice({ title: '' }));
      expect(errors).toContain('title is required');
    });

    it('reports missing content', () => {
      const errors = validateNotice(makeNotice({ content: '' }));
      expect(errors).toContain('content is required');
    });

    it('reports missing dataFiduciaryContact', () => {
      const errors = validateNotice(makeNotice({ dataFiduciaryContact: '' }));
      expect(errors).toContain('dataFiduciaryContact is required');
    });

    it('reports missing contentHash', () => {
      const errors = validateNotice(makeNotice({ contentHash: '' }));
      expect(errors).toContain('contentHash is required');
    });

    it('reports when purposes array is empty', () => {
      const errors = validateNotice(makeNotice({ purposes: [] }));
      expect(errors).toContain('At least one purpose must be specified');
    });

    it('reports missing purpose fields', () => {
      const errors = validateNotice(
        makeNotice({
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
      );

      expect(errors.some((e) => e.includes('purposeId'))).toBe(true);
      expect(errors.some((e) => e.includes('name'))).toBe(true);
      expect(errors.some((e) => e.includes('description'))).toBe(true);
    });

    it('reports multiple errors at once', () => {
      const errors = validateNotice(
        makeNotice({ noticeId: '', language: '', version: '' }),
      );
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('createConsentNotice', () => {
    it('sends correct request body to the API', async () => {
      const serverResponse = makeNotice({ noticeId: 'notice_from_server' });

      let capturedBody: Record<string, unknown> | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return {
            ok: true,
            json: () => Promise.resolve(serverResponse),
          };
        }),
      );

      const result = await createConsentNotice({
        language: 'en',
        version: '1.0',
        title: 'Data Processing Notice',
        content: 'We process your data.',
        purposes: [
          {
            purposeId: 'p1',
            name: 'Email',
            description: 'Read email',
            legalBasis: 'consent',
            dataCategories: ['email'],
            retentionPeriod: '1 year',
            thirdPartySharing: false,
          },
        ],
        dataFiduciaryContact: 'privacy@example.com',
        apiKey: 'test-key',
        baseUrl: 'https://api.test.local',
      });

      expect(result.noticeId).toBe('notice_from_server');
      expect(capturedBody!.language).toBe('en');
      expect(capturedBody!.contentHash).toBeTruthy();
      expect(typeof capturedBody!.contentHash).toBe('string');
    });

    it('throws DpdpError for invalid notice', async () => {
      await expect(
        createConsentNotice({
          language: 'en',
          version: '1.0',
          title: '',
          content: '',
          purposes: [],
          dataFiduciaryContact: '',
          apiKey: 'key',
          baseUrl: 'https://api.test.local',
        }),
      ).rejects.toThrow(DpdpError);
    });

    it('throws DpdpError on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ message: 'Internal error' }),
        })),
      );

      await expect(
        createConsentNotice({
          language: 'en',
          version: '1.0',
          title: 'Notice',
          content: 'Content',
          purposes: [
            {
              purposeId: 'p1',
              name: 'Purpose',
              description: 'Desc',
              legalBasis: 'consent',
              dataCategories: ['data'],
              retentionPeriod: '1y',
              thirdPartySharing: false,
            },
          ],
          dataFiduciaryContact: 'contact@test.com',
          apiKey: 'key',
          baseUrl: 'https://api.test.local',
        }),
      ).rejects.toThrow(DpdpError);
    });

    it('includes grievanceOfficer when provided', async () => {
      const serverResponse = makeNotice();

      let capturedBody: Record<string, unknown> | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string);
          return {
            ok: true,
            json: () => Promise.resolve(serverResponse),
          };
        }),
      );

      await createConsentNotice({
        language: 'en',
        version: '1.0',
        title: 'Notice',
        content: 'Content',
        purposes: [
          {
            purposeId: 'p1',
            name: 'Purpose',
            description: 'Desc',
            legalBasis: 'consent',
            dataCategories: ['data'],
            retentionPeriod: '1y',
            thirdPartySharing: false,
          },
        ],
        dataFiduciaryContact: 'contact@test.com',
        grievanceOfficer: {
          name: 'Officer Name',
          email: 'grievance@test.com',
          address: '123 Street',
        },
        apiKey: 'key',
        baseUrl: 'https://api.test.local',
      });

      expect(capturedBody!.grievanceOfficer).toEqual({
        name: 'Officer Name',
        email: 'grievance@test.com',
        address: '123 Street',
      });
    });
  });
});

/* ------------------------------------------------------------------ */
/*  consent-registry tests                                             */
/* ------------------------------------------------------------------ */

describe('consent-registry', () => {
  it('registers and retrieves a record by ID', () => {
    const registry = new ConsentRegistry();
    const record = makeRecord();
    registry.register(record);

    const retrieved = registry.get('rec_001');
    expect(retrieved).toBeDefined();
    expect(retrieved!.recordId).toBe('rec_001');
    expect(retrieved!.grantId).toBe('grant_abc');
  });

  it('freezes registered records (immutable)', () => {
    const registry = new ConsentRegistry();
    registry.register(makeRecord());

    const retrieved = registry.get('rec_001');
    expect(Object.isFrozen(retrieved)).toBe(true);
  });

  it('rejects duplicate registration', () => {
    const registry = new ConsentRegistry();
    registry.register(makeRecord());

    expect(() => registry.register(makeRecord())).toThrow('immutable');
  });

  it('returns undefined for non-existent record', () => {
    const registry = new ConsentRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('lists records for a given principal', () => {
    const registry = new ConsentRegistry();
    registry.register(makeRecord({ recordId: 'r1', dataPrincipalId: 'alice' }));
    registry.register(makeRecord({ recordId: 'r2', dataPrincipalId: 'alice' }));
    registry.register(makeRecord({ recordId: 'r3', dataPrincipalId: 'bob' }));

    const aliceRecords = registry.listForPrincipal('alice');
    expect(aliceRecords).toHaveLength(2);
    expect(aliceRecords.map((r) => r.recordId).sort()).toEqual(['r1', 'r2']);

    const bobRecords = registry.listForPrincipal('bob');
    expect(bobRecords).toHaveLength(1);
    expect(bobRecords[0]!.recordId).toBe('r3');
  });

  it('returns empty array for principal with no records', () => {
    const registry = new ConsentRegistry();
    expect(registry.listForPrincipal('unknown')).toEqual([]);
  });

  it('marks a record as withdrawn', () => {
    const registry = new ConsentRegistry();
    registry.register(makeRecord({ recordId: 'w1', status: 'active' }));

    registry.markWithdrawn('w1', 'User requested deletion');

    const updated = registry.get('w1');
    expect(updated!.status).toBe('withdrawn');
    expect(updated!.withdrawnReason).toBe('User requested deletion');
    expect(updated!.withdrawnAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(updated)).toBe(true);
  });

  it('throws when marking non-existent record as withdrawn', () => {
    const registry = new ConsentRegistry();
    expect(() => registry.markWithdrawn('missing', 'reason')).toThrow('not found');
  });

  describe('getStats', () => {
    it('counts all record statuses', () => {
      const registry = new ConsentRegistry();
      registry.register(makeRecord({ recordId: 'r1', dataPrincipalId: 'a', status: 'active' }));
      registry.register(makeRecord({ recordId: 'r2', dataPrincipalId: 'b', status: 'active' }));
      registry.register(makeRecord({ recordId: 'r3', dataPrincipalId: 'a', status: 'expired' }));
      registry.register(makeRecord({ recordId: 'r4', dataPrincipalId: 'c', status: 'withdrawn' }));

      const stats = registry.getStats();
      expect(stats.totalRecords).toBe(4);
      expect(stats.activeRecords).toBe(2);
      expect(stats.expiredRecords).toBe(1);
      expect(stats.withdrawnRecords).toBe(1);
      expect(stats.principalCount).toBe(3);
    });

    it('returns zeros for empty registry', () => {
      const registry = new ConsentRegistry();
      const stats = registry.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.activeRecords).toBe(0);
      expect(stats.withdrawnRecords).toBe(0);
      expect(stats.expiredRecords).toBe(0);
      expect(stats.principalCount).toBe(0);
    });

    it('updates stats after withdrawal', () => {
      const registry = new ConsentRegistry();
      registry.register(makeRecord({ recordId: 'r1', status: 'active' }));

      let stats = registry.getStats();
      expect(stats.activeRecords).toBe(1);
      expect(stats.withdrawnRecords).toBe(0);

      registry.markWithdrawn('r1', 'reason');

      stats = registry.getStats();
      expect(stats.activeRecords).toBe(0);
      expect(stats.withdrawnRecords).toBe(1);
    });
  });
});

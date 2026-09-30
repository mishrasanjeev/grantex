/**
 * A consent record is not created when its proof cannot be signed: the
 * record would claim evidence it does not carry. It used to be stored with
 * consentProof {type: 'none'}.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const signing = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/lib/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/crypto.js')>();
  return {
    ...actual,
    signWithEd25519: vi.fn(async (...args: Parameters<typeof actual.signWithEd25519>) => {
      if (signing.fail) throw new Error('Ed25519 key not initialized');
      return actual.signWithEd25519(...args);
    }),
  };
});

const { buildTestApp, seedAuth, authHeader, sqlMock, TEST_GRANT } = await import('./helpers.js');
const { initEdKey } = await import('../src/lib/crypto.js');

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  await initEdKey();
});

function seedLookups() {
  seedAuth();
  sqlMock.mockResolvedValueOnce([{
    id: TEST_GRANT.id, scopes: ['read'], principal_id: 'user_123', status: 'active',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }]);
  sqlMock.mockResolvedValueOnce([{ id: 'notice_TEST', version: '1.0', content_hash: 'abc123hash' }]);
}

const payload = {
  grantId: TEST_GRANT.id,
  dataPrincipalId: 'user_123',
  purposes: [{ code: 'analytics', description: 'Usage analytics' }],
  consentNoticeId: 'data-processing-v1',
  processingExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

describe('POST /v1/dpdp/consent-records when the proof cannot be signed', () => {
  it('answers 503 and creates no record', async () => {
    signing.fail = true;
    try {
      seedLookups();
      const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(), payload });

      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('CONSENT_PROOF_UNAVAILABLE');
      expect(sqlMock.begin).not.toHaveBeenCalled();
      const statements = sqlMock.mock.calls.map((args) => (Array.isArray(args[0]) ? (args[0] as string[]).join('?') : ''));
      expect(statements.some((text) => /INSERT\s+INTO\s+dpdp_consent_records/i.test(text))).toBe(false);
    } finally {
      signing.fail = false;
    }
  });

  it('creates the record when signing works', async () => {
    seedLookups();
    const res = await app.inject({ method: 'POST', url: '/v1/dpdp/consent-records', headers: authHeader(), payload });

    expect(res.statusCode).toBe(201);
    expect(res.json().consentProof.type).toBe('JWS-EdDSA');
  });
});

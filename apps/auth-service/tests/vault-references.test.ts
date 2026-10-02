import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, buildTestApp, mockRedis, seedAuth, sqlMock } from './helpers.js';

// The credential itself is never read by these tests; the crypto seam keeps it legible.
vi.mock('../src/lib/vault-crypto.js', () => ({
  encrypt: vi.fn((val: string) => `encrypted:${val}`),
  decrypt: vi.fn((val: string) => val.replace('encrypted:', '')),
}));

let app: FastifyInstance;

const GRANT_ID = 'grnt_VAULTREF01';
const REFERENCE = 'vcr_01J9ZK3X6Q0Z6W7F0X2Y1V8K3M';

async function grantToken(): Promise<string> {
  const { signGrantToken } = await import('../src/lib/crypto.js');
  return signGrantToken({
    sub: 'user_123',
    agt: 'did:grantex:ag_01',
    dev: 'dev_TEST',
    scp: ['vault:google:exchange'],
    jti: 'tok_VAULTREF01',
    grnt: GRANT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

function seedActiveToken(): void {
  sqlMock.mockResolvedValueOnce([
    { is_revoked: false, expires_at: new Date(Date.now() + 3600_000).toISOString(), grant_status: 'active' },
  ]);
}

const CREDENTIAL_ROW = {
  id: 'vault_1',
  access_token: 'encrypted:ya29.real_token',
  refresh_token: null,
  token_expires_at: '2026-04-01T00:00:00Z',
  credential_type: 'oauth2',
  metadata: { email: 'test@example.com' },
};

function referenceRow(over: Record<string, unknown> = {}) {
  return {
    id: REFERENCE,
    grant_id: GRANT_ID,
    principal_id: 'user_123',
    agent_did: 'did:grantex:ag_01',
    service: 'google',
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    access_token: 'encrypted:ya29.real_token',
    credential_type: 'oauth2',
    token_expires_at: '2026-04-01T00:00:00Z',
    metadata: {},
    ...over,
  };
}

beforeAll(async () => {
  app = await buildTestApp();
  process.env['VAULT_CREDENTIAL_REFERENCES_ENABLED'] = 'true';
});

afterAll(() => {
  delete process.env['VAULT_CREDENTIAL_REFERENCES_ENABLED'];
});

describe('POST /v1/vault/credentials/exchange with delivery: reference', () => {
  it('returns a reference bound to the grant and never the credential', async () => {
    const token = await grantToken();
    seedActiveToken();
    sqlMock.mockResolvedValueOnce([CREDENTIAL_ROW]);
    sqlMock.mockResolvedValueOnce([]); // INSERT INTO vault_credential_references

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: { service: 'google', delivery: 'reference' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credentialRef).toMatch(/^vcr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body).not.toHaveProperty('accessToken');
    expect(body.service).toBe('google');
    expect(body.credentialType).toBe('oauth2');
    expect(new Date(body.referenceExpiresAt).getTime()).toBeGreaterThan(Date.now());
    // The row binds the reference to the grant, the principal and the vault row.
    const insert = sqlMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO vault_credential_references'));
    expect(insert).toBeDefined();
    expect(insert!.slice(1)).toEqual(expect.arrayContaining([body.credentialRef, 'dev_TEST', 'vault_1', GRANT_ID, 'user_123', 'google']));
  });

  it('is refused while references are disabled instead of answering with the credential', async () => {
    delete process.env['VAULT_CREDENTIAL_REFERENCES_ENABLED'];
    try {
      const token = await grantToken();
      seedActiveToken();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/vault/credentials/exchange',
        headers: { authorization: `Bearer ${token}` },
        payload: { service: 'google', delivery: 'reference' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('CREDENTIAL_REFERENCE_DISABLED');
      expect(res.json()).not.toHaveProperty('accessToken');
    } finally {
      process.env['VAULT_CREDENTIAL_REFERENCES_ENABLED'] = 'true';
    }
  });

  it('refuses an unknown delivery', async () => {
    const token = await grantToken();
    seedActiveToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: { service: 'google', delivery: 'carrier-pigeon' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('still returns the credential for the default delivery', async () => {
    const token = await grantToken();
    seedActiveToken();
    sqlMock.mockResolvedValueOnce([CREDENTIAL_ROW]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/exchange',
      headers: { authorization: `Bearer ${token}` },
      payload: { service: 'google' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBe('ya29.real_token');
    expect(res.json()).not.toHaveProperty('credentialRef');
  });
});

describe('POST /v1/vault/credentials/resolve', () => {
  it('resolves a live reference for its grant and records the resolution', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([referenceRow()]);
    mockRedis.get.mockResolvedValueOnce(null);
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([]); // UPDATE ... resolved_count

    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBe('ya29.real_token');
    expect(body.service).toBe('google');
    expect(body.grantId).toBe(GRANT_ID);
    expect(body.principalId).toBe('user_123');
    expect(body.agentDid).toBe('did:grantex:ag_01');
    const update = sqlMock.mock.calls.find((call) => String(call[0]).includes('resolved_count'));
    expect(update).toBeDefined();
  });

  it('refuses a reference issued to another grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([referenceRow()]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: 'grnt_OTHER' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('GRANT_MISMATCH');
    expect(res.json()).not.toHaveProperty('accessToken');
  });

  it('refuses an expired reference', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([referenceRow({ expires_at: new Date(Date.now() - 1_000).toISOString() })]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe('CREDENTIAL_REFERENCE_EXPIRED');
  });

  it('refuses a reference whose grant was revoked, in the cache or in the grant row', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([referenceRow()]);
    mockRedis.get.mockResolvedValueOnce('1');
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    let res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('GRANT_INACTIVE');

    seedAuth();
    sqlMock.mockResolvedValueOnce([referenceRow()]);
    mockRedis.get.mockResolvedValueOnce(null);
    sqlMock.mockResolvedValueOnce([{ status: 'revoked' }]);
    res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('GRANT_INACTIVE');
    expect(res.json()).not.toHaveProperty('accessToken');
  });

  it('answers 404 for a reference outside the developer account and 400 for a malformed body', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });
    expect(missing.statusCode).toBe(404);

    seedAuth();
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      headers: authHeader(),
      payload: { credentialRef: 'not-a-reference', grantId: GRANT_ID },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBe('BAD_REQUEST');
  });

  it('needs the developer API key, not a grant token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/vault/credentials/resolve',
      payload: { credentialRef: REFERENCE, grantId: GRANT_ID },
    });
    expect(res.statusCode).toBe(401);
  });
});

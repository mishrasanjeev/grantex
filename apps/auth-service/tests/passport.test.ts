import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { gzipSync } from 'node:zlib';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = new Date();
const future = new Date(Date.now() + 86400_000);
const past = new Date(Date.now() - 86400_000);

const TEST_GRANT_WITH_MPP_SCOPES = {
  id: 'grnt_MPP01',
  scopes: ['payments:mpp:inference', 'payments:mpp:compute', 'payments:mpp:general'],
  principal_id: 'user_123',
  status: 'active',
  expires_at: future.toISOString(),
  delegation_depth: 0,
};

const TEST_PASSPORT = {
  id: 'urn:grantex:passport:01PASSPORT01',
  developer_id: TEST_DEVELOPER.id,
  agent_id: TEST_AGENT.id,
  grant_id: 'grnt_MPP01',
  status: 'active',
  expires_at: future,
  issued_at: now,
  status_list_idx: 0,
};

const TEST_CREDENTIAL_JSON = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://grantex.dev/contexts/mpp/v1',
  ],
  type: ['VerifiableCredential', 'AgentPassportCredential'],
  id: 'urn:grantex:passport:01PASSPORT01',
  issuer: 'did:web:grantex.dev',
  credentialSubject: {
    id: TEST_AGENT.did,
    type: 'AIAgent',
    humanPrincipal: 'did:grantex:user_123',
    grantId: 'grnt_MPP01',
    allowedMPPCategories: ['inference'],
    maxTransactionAmount: { amount: 100, currency: 'USDC' },
  },
};

const TEST_ENCODED_CREDENTIAL = Buffer.from(
  JSON.stringify(TEST_CREDENTIAL_JSON),
).toString('base64url');

function createEmptyEncodedList(): string {
  const bits = Buffer.alloc(16384, 0);
  return gzipSync(bits).toString('base64url');
}

// ── POST /v1/passport/issue ─────────────────────────────────────────────────

describe('POST /v1/passport/issue', () => {
  it('issues a passport credential successfully', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant lookup
    sqlMock.mockResolvedValueOnce([TEST_GRANT_WITH_MPP_SCOPES]);
    // Budget check
    sqlMock.mockResolvedValueOnce([]);
    // getOrCreateStatusList
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_PP01', nextIndex: 0, next_index: 0 }]);
    // UPDATE next_index
    sqlMock.mockResolvedValueOnce([]);
    // INSERT mpp_passports
    sqlMock.mockResolvedValueOnce([]);
    // INSERT verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference', 'compute'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.passportId).toBeDefined();
    expect(body.passportId).toMatch(/^urn:grantex:passport:/);
    expect(body.credential).toBeDefined();
    expect(body.credential.type).toContain('AgentPassportCredential');
    expect(body.encodedCredential).toBeDefined();
    expect(body.expiresAt).toBeDefined();
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        // missing grantId, allowedMPPCategories, maxTransactionAmount
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid MPP categories', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference', 'teleportation'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain('Invalid MPP categories');
    expect(res.json().message).toContain('teleportation');
  });

  it('returns 400 when agent not found', async () => {
    seedAuth();
    // Agent lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: 'ag_NONEXISTENT',
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_AGENT');
  });

  it('returns 400 when grant not found', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_NONEXISTENT',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_GRANT');
  });

  it('returns 400 when grant is revoked', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant lookup — revoked
    sqlMock.mockResolvedValueOnce([{ ...TEST_GRANT_WITH_MPP_SCOPES, status: 'revoked' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_GRANT');
    expect(res.json().message).toContain('revoked');
  });

  it('returns 400 when grant lacks required MPP scopes', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant with only inference scope
    sqlMock.mockResolvedValueOnce([{
      ...TEST_GRANT_WITH_MPP_SCOPES,
      scopes: ['payments:mpp:inference'],
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference', 'compute'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('SCOPE_INSUFFICIENT');
    expect(res.json().message).toContain('payments:mpp:compute');
  });

  it('returns 400 when maxTransactionAmount exceeds remaining budget', async () => {
    seedAuth();
    // Agent lookup
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    // Grant lookup
    sqlMock.mockResolvedValueOnce([TEST_GRANT_WITH_MPP_SCOPES]);
    // Budget check — remaining is less than requested
    sqlMock.mockResolvedValueOnce([{ remaining_budget: '50.00' }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('AMOUNT_EXCEEDS_BUDGET');
  });

  it('returns 422 for invalid expiresIn format', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
        expiresIn: 'not-a-duration',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('INVALID_EXPIRY');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/issue',
      payload: {
        agentId: TEST_AGENT.id,
        grantId: 'grnt_MPP01',
        allowedMPPCategories: ['inference'],
        maxTransactionAmount: { amount: 100, currency: 'USDC' },
      },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── GET /v1/passports ───────────────────────────────────────────────────────

describe('GET /v1/passports', () => {
  it('lists passports without filters', async () => {
    seedAuth();
    // The passport list query uses nested sql`` fragments for conditionals;
    // each fragment invocation consumes one sqlMock slot. With no filters,
    // 3 empty sql`` fragments + 1 outer query = 4 mock calls total.
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status)
    sqlMock.mockResolvedValueOnce([TEST_PASSPORT]); // outer query result

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].passportId).toBe(TEST_PASSPORT.id);
    expect(body[0].agentId).toBe(TEST_AGENT.id);
    expect(body[0].status).toBe('active');
  });

  it('filters by agentId', async () => {
    seedAuth();
    // With agentId filter: 1 sql`` for agentId condition + 2 empty sql``
    // fragments for grantId/status + 1 outer query
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId condition)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status)
    sqlMock.mockResolvedValueOnce([TEST_PASSPORT]); // outer query result

    const res = await app.inject({
      method: 'GET',
      url: `/v1/passports?agentId=${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('filters by grantId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId condition)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status)
    sqlMock.mockResolvedValueOnce([TEST_PASSPORT]); // outer query result

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports?grantId=grnt_MPP01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it('filters by status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status condition)
    sqlMock.mockResolvedValueOnce([{ ...TEST_PASSPORT, status: 'revoked' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports?status=revoked',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0].status).toBe('revoked');
  });

  it('marks expired passports in response', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status)
    sqlMock.mockResolvedValueOnce([{ ...TEST_PASSPORT, status: 'active', expires_at: past }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0].status).toBe('expired');
  });

  it('returns empty array when no passports match', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (agentId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (grantId)
    sqlMock.mockResolvedValueOnce([]); // sql`` fragment (status)
    sqlMock.mockResolvedValueOnce([]); // outer query result

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/passports',
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── GET /v1/passport/:id ────────────────────────────────────────────────────

describe('GET /v1/passport/:id', () => {
  it('returns a passport by ID', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...TEST_PASSPORT,
      credential_jwt: 'eyJ...',
      encoded_credential: TEST_ENCODED_CREDENTIAL,
      revoked_at: null,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/passport/${TEST_PASSPORT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.type).toContain('AgentPassportCredential');
    expect(body.credentialSubject).toBeDefined();
  });

  it('returns 404 when passport not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/passport/urn:grantex:passport:NONEXISTENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('marks expired passports in get response', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...TEST_PASSPORT,
      status: 'active',
      expires_at: past,
      credential_jwt: 'eyJ...',
      encoded_credential: TEST_ENCODED_CREDENTIAL,
      revoked_at: null,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/passport/${TEST_PASSPORT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('expired');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/passport/${TEST_PASSPORT.id}`,
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── POST /v1/passport/:id/revoke ────────────────────────────────────────────

describe('POST /v1/passport/:id/revoke', () => {
  it('revokes an active passport', async () => {
    seedAuth();
    // Passport lookup
    sqlMock.mockResolvedValueOnce([{
      id: TEST_PASSPORT.id,
      status: 'active',
      status_list_idx: 0,
    }]);
    // UPDATE mpp_passports
    sqlMock.mockResolvedValueOnce([]);
    // UPDATE verifiable_credentials
    sqlMock.mockResolvedValueOnce([]);
    // SELECT status list
    const encodedList = createEmptyEncodedList();
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_PP01',
      encoded_list: encodedList,
    }]);
    // UPDATE status list
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/passport/${TEST_PASSPORT.id}/revoke`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revoked).toBe(true);
    expect(body.revokedAt).toBeDefined();
  });

  it('returns success for already revoked passport', async () => {
    seedAuth();
    // Passport lookup — already revoked
    sqlMock.mockResolvedValueOnce([{
      id: TEST_PASSPORT.id,
      status: 'revoked',
      status_list_idx: 0,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/passport/${TEST_PASSPORT.id}/revoke`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revoked).toBe(true);
    expect(body.revokedAt).toBeDefined();
  });

  it('returns 404 when passport not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/passport/urn:grantex:passport:NONEXISTENT/revoke',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/passport/${TEST_PASSPORT.id}/revoke`,
    });

    expect(res.statusCode).toBe(401);
  });
});

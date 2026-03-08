import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { initKeys, getKeyPair } from '../src/lib/crypto.js';
import { SignJWT, decodeJwt } from 'jose';
import { gzipSync } from 'node:zlib';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = new Date();
const future = new Date(Date.now() + 86400_000);

const TEST_VC = {
  id: 'vc_TEST01',
  grant_id: 'grnt_TEST01',
  developer_id: TEST_DEVELOPER.id,
  principal_id: 'user_123',
  agent_did: TEST_AGENT.did,
  credential_type: 'AgentGrantCredential',
  format: 'vc-jwt',
  credential_jwt: 'eyJ...',
  status: 'active',
  status_list_idx: 0,
  issued_at: now,
  expires_at: future,
  revoked_at: null,
};

function createEmptyEncodedList(): string {
  const bits = Buffer.alloc(16384, 0);
  return gzipSync(bits).toString('base64url');
}

async function createSignedVcJwt(overrides: Record<string, unknown> = {}): Promise<string> {
  const { privateKey, kid } = getKeyPair();
  const exp = overrides['exp'] as number | undefined ?? Math.floor(Date.now() / 1000) + 86400;
  const iat = overrides['iat'] as number | undefined ?? Math.floor(Date.now() / 1000);

  return new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://grantex.dev/ns/credentials/v1'],
      type: ['VerifiableCredential', 'AgentGrantCredential'],
      credentialSubject: {
        id: TEST_AGENT.did,
        type: 'AIAgent',
        principalId: 'user_123',
        developerId: TEST_DEVELOPER.id,
        grantId: 'grnt_TEST01',
        scopes: ['read'],
        delegationDepth: 0,
      },
      credentialStatus: {
        id: 'https://grantex.dev/v1/credentials/status/vcsl_TEST#0',
        type: 'StatusList2021Entry',
        statusPurpose: 'revocation',
        statusListIndex: '0',
        statusListCredential: 'https://grantex.dev/v1/credentials/status/vcsl_TEST',
      },
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer('did:web:grantex.dev')
    .setSubject(TEST_AGENT.did)
    .setJti('vc_TEST01')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

// ── GET /v1/credentials/:id ─────────────────────────────────────────────────

describe('GET /v1/credentials/:id', () => {
  it('returns a credential by ID', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_VC]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/vc_TEST01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('vc_TEST01');
    expect(body.grantId).toBe('grnt_TEST01');
    expect(body.credentialType).toBe('AgentGrantCredential');
    expect(body.format).toBe('vc-jwt');
    expect(body.status).toBe('active');
  });

  it('returns 404 when credential not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/vc_NONEXISTENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('returns 404 for credential belonging to another developer', async () => {
    seedAuth();
    // Query scoped to developer_id, so it returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/vc_OTHER_DEV',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/vc_TEST01',
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── GET /v1/credentials ─────────────────────────────────────────────────────

describe('GET /v1/credentials', () => {
  it('lists credentials without filters', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_VC]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].id).toBe('vc_TEST01');
  });

  it('filters by grantId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_VC]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials?grantId=grnt_TEST01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toHaveLength(1);
  });

  it('filters by principalId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_VC]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials?principalId=user_123',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toHaveLength(1);
  });

  it('filters by status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...TEST_VC, status: 'revoked', revoked_at: now }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials?status=revoked',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const cred = res.json().credentials[0];
    expect(cred.status).toBe('revoked');
  });

  it('returns empty array when no credentials match', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toEqual([]);
  });
});

// ── POST /v1/credentials/verify ─────────────────────────────────────────────

describe('POST /v1/credentials/verify', () => {
  it('returns valid for a properly signed VC-JWT', async () => {
    const vcJwt = await createSignedVcJwt();

    // Status list lookup for revocation check → not found (no revocation)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: vcJwt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.vcId).toBe('vc_TEST01');
    expect(body.payload).toBeDefined();
  });

  it('returns invalid for expired VC-JWT', async () => {
    const vcJwt = await createSignedVcJwt({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: vcJwt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.expired).toBe(true);
  });

  it('returns invalid for revoked VC-JWT (status list bit set)', async () => {
    const vcJwt = await createSignedVcJwt();

    // Status list with bit 0 set (revoked)
    const bits = Buffer.alloc(16384, 0);
    bits[0]! |= 1 << 7; // Set bit 0 (MSB-first)
    const encodedList = gzipSync(bits).toString('base64url');

    sqlMock.mockResolvedValueOnce([{
      encoded_list: encodedList,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: vcJwt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
    expect(body.revoked).toBe(true);
  });

  it('returns invalid for invalid signature', async () => {
    const { generateKeyPair } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256');
    const fakeJwt = await new SignJWT({ vc: {} })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('did:web:fake.dev')
      .setSubject('did:fake:agent')
      .setJti('vc_FAKE')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: fakeJwt },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(false);
  });

  it('returns 400 when credential is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('does not require authentication (skipAuth)', async () => {
    const vcJwt = await createSignedVcJwt();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: vcJwt },
      // No auth header
    });

    expect(res.statusCode).toBe(200);
  });
});

// ── GET /v1/credentials/status/:listId ──────────────────────────────────────

describe('GET /v1/credentials/status/:listId', () => {
  it('returns a StatusList2021 credential', async () => {
    const encodedList = createEmptyEncodedList();
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_LIST1',
      developer_id: TEST_DEVELOPER.id,
      encoded_list: encodedList,
      purpose: 'revocation',
      size: 131072,
      updated_at: now,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/status/vcsl_LIST1',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toContain('StatusList2021Credential');
    expect(body.issuer).toBe('did:web:grantex.dev');
    expect(body.credentialSubject.type).toBe('StatusList2021');
    expect(body.credentialSubject.statusPurpose).toBe('revocation');
    expect(body.credentialSubject.encodedList).toBe(encodedList);
  });

  it('returns 404 for non-existent status list', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/status/vcsl_MISSING',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('does not require authentication (skipAuth)', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/credentials/status/vcsl_TEST',
      // No auth header
    });

    // 404 not 401 — means auth was skipped
    expect(res.statusCode).toBe(404);
  });
});

// ── Token exchange with credentialFormat ─────────────────────────────────────

const validAuthRequest = {
  id: 'areq_VC_TEST',
  agent_id: TEST_AGENT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read', 'write'],
  expires_in: '24h',
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  status: 'approved',
  agent_did: TEST_AGENT.did,
  code_challenge: null,
};

describe('POST /v1/token with credentialFormat', () => {
  it('returns only grantToken without credentialFormat (backward compat)', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validAuthRequest]);  // Auth request lookup
    sqlMock.mockResolvedValueOnce([]);  // INSERT grants
    sqlMock.mockResolvedValueOnce([]);  // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);  // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);  // UPDATE auth_requests
    sqlMock.mockResolvedValueOnce([]);  // Budget check

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-compat', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.grantToken).toBeDefined();
    expect(body.verifiableCredential).toBeUndefined();
  });

  it('returns verifiableCredential with credentialFormat=vc-jwt', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validAuthRequest]);  // Auth request lookup
    sqlMock.mockResolvedValueOnce([]);  // INSERT grants
    sqlMock.mockResolvedValueOnce([]);  // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);  // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);  // UPDATE auth_requests
    sqlMock.mockResolvedValueOnce([]);  // Budget check

    // VC issuance SQL calls:
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_TOK1', next_index: 0 }]);  // getOrCreateStatusList
    sqlMock.mockResolvedValueOnce([]);  // UPDATE next_index
    sqlMock.mockResolvedValueOnce([]);  // INSERT verifiable_credentials

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-vc', agentId: TEST_AGENT.id, credentialFormat: 'vc-jwt' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.grantToken).toBeDefined();
    expect(body.verifiableCredential).toBeDefined();
    expect(typeof body.verifiableCredential).toBe('string');

    // Verify the VC-JWT structure
    const vcPayload = decodeJwt(body.verifiableCredential);
    expect(vcPayload.iss).toBe('did:web:grantex.dev');
    expect(vcPayload['vc']).toBeDefined();
  });

  it('returns both grantToken and verifiableCredential with credentialFormat=both', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([validAuthRequest]);  // Auth request lookup
    sqlMock.mockResolvedValueOnce([]);  // INSERT grants
    sqlMock.mockResolvedValueOnce([]);  // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);  // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);  // UPDATE auth_requests
    sqlMock.mockResolvedValueOnce([]);  // Budget check

    // VC issuance SQL calls:
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_BOTH', next_index: 5 }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-both', agentId: TEST_AGENT.id, credentialFormat: 'both' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.grantToken).toBeDefined();
    expect(body.verifiableCredential).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    expect(body.grantId).toBeDefined();
  });
});

// ── VC revocation via grant revocation ──────────────────────────────────────

describe('VC revocation cascade', () => {
  it('revokes VCs when grant is revoked (via revokeVCsByGrantIds)', async () => {
    // This tests the revokeVCsByGrantIds function directly
    const { revokeVCsByGrantIds } = await import('../src/lib/vc.js');

    // SELECT active VCs
    sqlMock.mockResolvedValueOnce([
      { id: 'vc_CASCADE1', status_list_idx: 0 },
      { id: 'vc_CASCADE2', status_list_idx: 1 },
    ]);
    // UPDATE VCs to revoked
    sqlMock.mockResolvedValueOnce([]);
    // SELECT status list
    const encodedList = createEmptyEncodedList();
    sqlMock.mockResolvedValueOnce([{
      id: 'vcsl_CASCADE',
      encoded_list: encodedList,
    }]);
    // UPDATE status list
    sqlMock.mockResolvedValueOnce([]);

    await revokeVCsByGrantIds(['grnt_CASCADE1'], TEST_DEVELOPER.id);

    // Verify SQL was called the right number of times
    expect(sqlMock).toHaveBeenCalledTimes(4);
  });

  it('handles revocation with no matching VCs gracefully', async () => {
    const { revokeVCsByGrantIds } = await import('../src/lib/vc.js');

    // SELECT active VCs → empty
    sqlMock.mockResolvedValueOnce([]);

    await revokeVCsByGrantIds(['grnt_NOVCS'], TEST_DEVELOPER.id);

    // Only one SQL call (the SELECT)
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function generateTestPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const validAuthRequest = {
  id: 'areq_PKCE',
  agent_id: TEST_AGENT.id,
  principal_id: 'user_123',
  developer_id: TEST_DEVELOPER.id,
  scopes: ['read'],
  expires_in: '24h',
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  status: 'approved',
  agent_did: TEST_AGENT.did,
  code_challenge: null,
};

describe('PKCE — POST /v1/authorize', () => {
  it('accepts codeChallenge and codeChallengeMethod S256', async () => {
    const { challenge } = generateTestPkce();
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent lookup
    sqlMock.mockResolvedValueOnce([]);                       // policy lookup
    sqlMock.mockResolvedValueOnce([]);                       // insert

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it('rejects non-S256 codeChallengeMethod', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        principalId: 'user_123',
        scopes: ['read'],
        codeChallenge: 'some-challenge',
        codeChallengeMethod: 'plain',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('S256');
  });
});

describe('PKCE — POST /v1/token', () => {
  it('succeeds when codeVerifier matches stored challenge', async () => {
    const { verifier, challenge } = generateTestPkce();
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validAuthRequest, code_challenge: challenge }]);
    sqlMock.mockResolvedValueOnce([]); // INSERT grants
    sqlMock.mockResolvedValueOnce([]); // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]); // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]); // UPDATE auth_requests consumed

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'pkce-code', agentId: TEST_AGENT.id, codeVerifier: verifier },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ grantToken: string }>().grantToken).toBeDefined();
  });

  it('returns 400 when codeVerifier is missing but challenge was stored', async () => {
    const { challenge } = generateTestPkce();
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validAuthRequest, code_challenge: challenge }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'pkce-code', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('codeVerifier');
  });

  it('returns 400 when codeVerifier does not match', async () => {
    const { challenge } = generateTestPkce();
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validAuthRequest, code_challenge: challenge }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'pkce-code', agentId: TEST_AGENT.id, codeVerifier: 'wrong-verifier' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('Invalid codeVerifier');
  });

  it('succeeds without codeVerifier when no challenge was stored', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...validAuthRequest, code_challenge: null }]);
    sqlMock.mockResolvedValueOnce([]); // INSERT grants
    sqlMock.mockResolvedValueOnce([]); // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]); // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]); // UPDATE auth_requests consumed

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'no-pkce-code', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { signGrantToken, initKeys } from '../src/lib/crypto.js';
import { decodeJwt } from 'jose';

let app: FastifyInstance;
let parentToken: string;

const SUB_AGENT = {
  id: 'ag_SUBAGENT01',
  did: 'did:grantex:ag_SUBAGENT01',
  developer_id: TEST_DEVELOPER.id,
  name: 'Sub Agent',
  description: 'A sub agent',
  scopes: ['read'],
  status: 'active',
};

beforeAll(async () => {
  app = await buildTestApp();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  parentToken = await signGrantToken({
    sub: 'user_123',
    agt: TEST_AGENT.did,
    dev: TEST_DEVELOPER.id,
    scp: ['read', 'write'],
    jti: 'tok_PARENT01',
    grnt: 'grnt_PARENT01',
    exp,
  });
});

describe('POST /v1/grants/delegate', () => {
  it('creates a delegated grant token for a sub-agent', async () => {
    seedAuth();
    // Redis: parent token not revoked
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    // INSERT grants
    sqlMock.mockResolvedValueOnce([]);
    // INSERT grant_tokens
    sqlMock.mockResolvedValueOnce([]);
    // INSERT refresh_tokens
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
        expiresIn: '1h',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      grantToken: string;
      expiresAt: string;
      scopes: string[];
      grantId: string;
    }>();
    expect(typeof body.grantToken).toBe('string');
    expect(body.scopes).toEqual(['read']);
    expect(typeof body.grantId).toBe('string');

    // Verify delegation claims
    const claims = decodeJwt(body.grantToken);
    expect(claims['agt']).toBe(SUB_AGENT.did);
    expect(claims['parentAgt']).toBe(TEST_AGENT.did);
    expect(claims['parentGrnt']).toBe('grnt_PARENT01');
    expect(claims['delegationDepth']).toBe(1);
  });

  it('returns 400 when requested scopes exceed parent scopes', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['admin'],  // not in parent's scp
        expiresIn: '1h',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string }>();
    expect(body.message).toMatch(/exceed parent/);
  });

  it('returns 400 when parent grant is revoked in Redis', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValueOnce('1'); // parent token revoked

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: SUB_AGENT.id,
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string }>();
    expect(body.message).toMatch(/revoked/);
  });

  it('returns 404 when sub-agent is not found', async () => {
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    // Sub-agent lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_NONEXISTENT',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when required fields are missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: { subAgentId: SUB_AGENT.id }, // missing parentGrantToken + scopes
    });

    expect(res.statusCode).toBe(400);
  });
});

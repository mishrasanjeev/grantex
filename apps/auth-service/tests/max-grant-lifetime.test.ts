import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

const mutable = config as unknown as { maxGrantLifetimeSeconds: number | null };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  mutable.maxGrantLifetimeSeconds = null;
});

async function authorize(expiresIn: string) {
  seedAuth();
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([{ count: '0' }]);
  sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([]);
  return app.inject({
    method: 'POST',
    url: '/v1/authorize',
    headers: authHeader(),
    payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['read'], expiresIn },
  });
}

describe('MAX_GRANT_LIFETIME_SECONDS', () => {
  it('is unset by default, so any valid expiresIn is accepted as before', async () => {
    expect(config.maxGrantLifetimeSeconds).toBeNull();
    expect((await authorize('3650d')).statusCode).toBe(201);
  });

  it('rejects an authorization request whose grant would outlive the maximum', async () => {
    mutable.maxGrantLifetimeSeconds = 86_400;
    const res = await authorize('2d');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toBe('expiresIn exceeds the maximum grant lifetime of 86400 seconds');
  });

  it('accepts a grant lifetime up to the maximum', async () => {
    mutable.maxGrantLifetimeSeconds = 86_400;
    expect((await authorize('24h')).statusCode).toBe(201);
  });
});

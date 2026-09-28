// SPDX-License-Identifier: Apache-2.0
/**
 * The agent key routes with the database mocked: authentication, input
 * validation and ownership refusals that happen before any key is touched.
 * Behaviour against a real database is in agent-keys-postgres.integration.test.ts.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

let app: FastifyInstance;

const ED25519 = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>;
const THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';
const base = `/v1/agents/${TEST_AGENT.id}/keys`;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

const routes: Array<{ method: 'GET' | 'POST' | 'PUT'; url: string; payload?: Record<string, unknown> }> = [
  { method: 'GET', url: base },
  { method: 'POST', url: base, payload: { publicJwk: ED25519 } },
  { method: 'PUT', url: `/v1/agents/${TEST_AGENT.id}/declared-rails`, payload: { declaredRails: [] } },
  { method: 'POST', url: `${base}/${THUMBPRINT}/challenge` },
  { method: 'POST', url: `${base}/${THUMBPRINT}/prove`, payload: { proof: 'a.b.c' } },
  { method: 'POST', url: `${base}/${THUMBPRINT}/rotate`, payload: { replacementThumbprint: THUMBPRINT.replace('k', 'j') } },
  { method: 'POST', url: `${base}/${THUMBPRINT}/compromise`, payload: {} },
];

describe('agent key routes', () => {
  it('require a developer API key', async () => {
    for (const route of routes) {
      const res = await app.inject({ method: route.method, url: route.url, ...(route.payload ? { payload: route.payload } : {}) });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('answer 404 for an agent the developer does not own', async () => {
    for (const route of routes) {
      seedAuth();
      sqlMock.mockResolvedValueOnce([]); // the agent lookup, scoped by developer
      const res = await app.inject({
        method: route.method, url: route.url, headers: authHeader(), ...(route.payload ? { payload: route.payload } : {}),
      });
      expect(res.statusCode, `${route.method} ${route.url}: ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('refuse a malformed thumbprint in the path', async () => {
    for (const action of ['challenge', 'prove', 'rotate', 'compromise']) {
      seedAuth();
      const res = await app.inject({
        method: 'POST', url: `${base}/not-a-thumbprint/${action}`, headers: authHeader(), payload: {},
      });
      expect(res.statusCode, action).toBe(400);
    }
  });

  it('refuse a private key, a key-agreement key and a missing key before touching the database', async () => {
    for (const publicJwk of [
      { ...ED25519, d: 'private' },
      { ...ED25519, crv: 'X25519' },
      undefined,
      'jwk',
    ]) {
      seedAuth();
      const res = await app.inject({
        method: 'POST', url: base, headers: authHeader(), payload: publicJwk === undefined ? {} : { publicJwk },
      });
      expect(res.statusCode, JSON.stringify(publicJwk)).toBe(400);
      expect(sqlMock).toHaveBeenCalledTimes(1); // authentication only
      sqlMock.mockClear();
    }
  });

  it('refuse an unknown rail and a repeated one', async () => {
    for (const declaredRails of [['card'], ['ap2', 'ap2'], 'ap2', undefined]) {
      seedAuth();
      const res = await app.inject({
        method: 'PUT', url: `/v1/agents/${TEST_AGENT.id}/declared-rails`, headers: authHeader(),
        payload: declaredRails === undefined ? {} : { declaredRails },
      });
      expect(res.statusCode, JSON.stringify(declaredRails)).toBe(400);
    }
  });

  it('refuse a rotation without a valid replacement or with an out-of-range overlap', async () => {
    for (const payload of [
      {},
      { replacementThumbprint: 'short' },
      { replacementThumbprint: THUMBPRINT },
      { replacementThumbprint: THUMBPRINT.replace('k', 'j'), overlapSeconds: -1 },
      { replacementThumbprint: THUMBPRINT.replace('k', 'j'), overlapSeconds: 1.5 },
      { replacementThumbprint: THUMBPRINT.replace('k', 'j'), overlapSeconds: 30 * 86_400 + 1 },
    ]) {
      seedAuth();
      const res = await app.inject({
        method: 'POST', url: `${base}/${THUMBPRINT}/rotate`, headers: authHeader(), payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('refuse a prove call without a proof', async () => {
    seedAuth();
    const res = await app.inject({ method: 'POST', url: `${base}/${THUMBPRINT}/prove`, headers: authHeader(), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'key_unproven' });
  });

  it('refuse an overlong compromise reason', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: `${base}/${THUMBPRINT}/compromise`, headers: authHeader(), payload: { reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });
});

// SPDX-License-Identifier: Apache-2.0
/**
 * AGENT_KEY_HISTORY_MIRROR_ENABLED on POST and PATCH /v1/agents, with the
 * database mocked: which statements each flag state sends.
 *
 * Off (the default, and any value but exactly 'true'), the routes send the
 * statements they sent before the agent key history existed, and nothing that
 * touches agent_keys. On, the same agent write is followed, in the same
 * transaction, by the history mirror. Behaviour against a real database is
 * in agent-keys-postgres.integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

let app: FastifyInstance;

const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYLefJXI2v-AXGNENLwL8Y6R1TsA5G4nsiq8PZQ', use: 'sig' };
const agentRow = { ...TEST_AGENT, public_jwk: publicJwk, key_thumbprint: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k' };

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The SQL text of every statement sent after authentication, whitespace collapsed. */
function statements(): string[] {
  return sqlMock.mock.calls
    .slice(1)
    .map((call) => (Array.isArray(call[0]) ? (call[0] as string[]).join('$') : String(call[0])).replace(/\s+/g, ' ').trim());
}

async function postAgent() {
  return app.inject({
    method: 'POST', url: '/v1/agents', headers: authHeader(),
    payload: { name: 'Nimbus Shopper 2.4', scopes: ['read'], publicJwk },
  });
}

async function patchKey() {
  return app.inject({ method: 'PATCH', url: `/v1/agents/${TEST_AGENT.id}`, headers: authHeader(), payload: { publicJwk } });
}

describe('POST and PATCH /v1/agents with the history mirror off', () => {
  for (const value of [undefined, 'false', 'TRUE', '1', ' true']) {
    it(`sends only the agents statements (AGENT_KEY_HISTORY_MIRROR_ENABLED=${String(value)})`, async () => {
      if (value !== undefined) vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', value);

      seedAuth();
      sqlMock.mockResolvedValueOnce([]);               // advisory lock
      sqlMock.mockResolvedValueOnce([]);               // subscription
      sqlMock.mockResolvedValueOnce([{ count: '0' }]); // agent count
      sqlMock.mockResolvedValueOnce([agentRow]);       // INSERT
      const created = await postAgent();
      expect(created.statusCode, created.body).toBe(201);
      const posted = statements();
      expect(posted).toHaveLength(4);
      expect(posted[3]).toMatch(/^INSERT INTO agents /);
      expect(posted.join('\n')).not.toContain('agent_keys');

      sqlMock.mockClear();
      sqlMock.begin.mockClear();
      seedAuth();
      sqlMock.mockResolvedValueOnce([agentRow]);       // UPDATE
      const patched = await patchKey();
      expect(patched.statusCode, patched.body).toBe(200);
      // One statement, outside any transaction, exactly as before.
      expect(sqlMock.begin).not.toHaveBeenCalled();
      const updates = statements();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatch(/^UPDATE agents SET did = COALESCE\(/);
      expect(updates[0]).not.toContain('agent_keys');
    });
  }
});

describe('POST and PATCH /v1/agents with the history mirror on', () => {
  it('POST mirrors the key into agent_keys in the same transaction', async () => {
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);               // advisory lock
    sqlMock.mockResolvedValueOnce([]);               // subscription
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // agent count
    sqlMock.mockResolvedValueOnce([agentRow]);       // INSERT agents
    sqlMock.mockResolvedValueOnce([{ declared_rails: [] }]);
    sqlMock.mockResolvedValueOnce([]);               // compromised_agent_keys
    sqlMock.mockResolvedValueOnce([]);               // agent_keys, FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);               // INSERT agent_keys
    const created = await postAgent();
    expect(created.statusCode, created.body).toBe(201);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    const sent = statements();
    expect(sent.some((text) => text.startsWith('INSERT INTO agent_keys'))).toBe(true);
  });

  it('PATCH locks the agent, updates it and mirrors the key, in one transaction', async () => {
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ key_thumbprint: 'previous_thumbprint_value_000000000000000000' }]);
    sqlMock.mockResolvedValueOnce([agentRow]);       // UPDATE agents
    sqlMock.mockResolvedValueOnce([{ declared_rails: [] }]);
    sqlMock.mockResolvedValueOnce([]);               // compromised_agent_keys
    sqlMock.mockResolvedValueOnce([]);               // agent_keys, FOR UPDATE
    sqlMock.mockResolvedValueOnce([]);               // INSERT agent_keys
    sqlMock.mockResolvedValueOnce([]);               // the replaced key ends
    const patched = await patchKey();
    expect(patched.statusCode, patched.body).toBe(200);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    const sent = statements();
    expect(sent[0]).toMatch(/FOR UPDATE$/);
    expect(sent.some((text) => text.startsWith('INSERT INTO agent_keys'))).toBe(true);
    expect(sent.at(-1)).toMatch(/^UPDATE agent_keys SET status = 'rotated'/);
  });

  it('PATCH refuses a key another agent holds in its history, as AGENT_KEY_CONFLICT', async () => {
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ key_thumbprint: null }]);
    sqlMock.mockResolvedValueOnce([agentRow]);
    sqlMock.mockResolvedValueOnce([{ declared_rails: [] }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_OTHER', status: 'active', in_overlap: false }]);
    const patched = await patchKey();
    expect(patched.statusCode, patched.body).toBe(409);
    expect(patched.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });
  });

  it('PATCH refuses a key reported compromised, and a non-P-256 key under a payments rail', async () => {
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ key_thumbprint: null }]);
    sqlMock.mockResolvedValueOnce([agentRow]);
    sqlMock.mockResolvedValueOnce([{ declared_rails: [] }]);
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]); // compromised_agent_keys
    const compromised = await patchKey();
    expect(compromised.statusCode, compromised.body).toBe(409);
    expect(compromised.json()).toMatchObject({ code: 'key_not_active' });

    sqlMock.mockClear();
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ key_thumbprint: null }]);
    sqlMock.mockResolvedValueOnce([agentRow]);
    sqlMock.mockResolvedValueOnce([{ declared_rails: ['ap2'] }]);
    const rail = await patchKey();
    expect(rail.statusCode, rail.body).toBe(400);
    expect(rail.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

beforeAll(() => {
  process.env['AGENT_LIFECYCLE_STATES_ENABLED'] = 'true';
});

afterAll(() => {
  delete process.env['AGENT_LIFECYCLE_STATES_ENABLED'];
});

describe('POST /v1/agents', () => {
  const publicJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: '11qYAYLefJXI2v-AXGNENLwL8Y6R1TsA5G4nsiq8PZQ',
    use: 'sig',
  };

  it('registers an agent and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);               // advisory lock
    sqlMock.mockResolvedValueOnce([]);              // subscription lookup → free plan
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // agent count → 0
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);     // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'My Agent', description: 'A test agent', scopes: ['read'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ agentId: string; did: string; name: string }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
    expect(body.did).toBe(TEST_AGENT.did);
    expect(body.name).toBe(TEST_AGENT.name);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
  });

  it('registers a draft agent when asked, and refuses any other starting state', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, status: 'draft' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Draft Agent', status: 'draft' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('draft');
    const insert = sqlMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO agents'));
    expect(insert!.slice(1)).toContain('draft');

    seedAuth();
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Retired Agent', status: 'retired' },
    });
    expect(refused.statusCode).toBe(400);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
  });

  it('returns 402 when plan agent limit is reached', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);                 // advisory lock
    sqlMock.mockResolvedValueOnce([{ plan: 'free' }]); // subscription → free plan
    sqlMock.mockResolvedValueOnce([{ count: '500' }]);   // 500 agents already (free limit)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'One Too Many', scopes: [] },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json<{ code: string }>().code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('returns 400 when name is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { description: 'No name' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a missing JSON body', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when scopes is not an array', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Agent', scopes: 'read' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects duplicate OAuth scope tokens', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Agent', scopes: ['read', 'read'] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when an Agent Key belongs to another instance', async () => {
    seedAuth();
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'idx_agents_key_thumbprint_unique',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Duplicate Key Agent', scopes: ['read'], publicJwk },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });
  });

  it('registers exact redirect, resource, and public-key constraints', async () => {
    seedAuth();
    const keyedAgent = {
      ...TEST_AGENT,
      did: `did:web:grantex.dev:agents:${TEST_AGENT.id}`,
      redirect_uris: ['https://client.example/callback'],
      resource_servers: ['https://api.example/resource'],
      public_jwk: publicJwk,
      key_thumbprint: 'registered-thumbprint',
    };
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);
    sqlMock.mockResolvedValueOnce([keyedAgent]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: {
        name: 'Bound Agent',
        scopes: ['read'],
        redirectUris: ['https://client.example/callback'],
        resourceServers: ['https://api.example/resource'],
        publicJwk,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      did: keyedAgent.did,
      redirectUris: keyedAgent.redirect_uris,
      resourceServers: keyedAgent.resource_servers,
      publicJwk,
      keyThumbprint: 'registered-thumbprint',
      keyBindingConfigured: true,
    });
  });

  it('rejects private key material in publicJwk', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: { name: 'Unsafe Agent', publicJwk: { ...publicJwk, d: 'private' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('private key field');
  });

  it('rejects key-agreement keys that cannot verify agent proofs', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: authHeader(),
      payload: {
        name: 'Wrong Key Type',
        publicJwk: { ...publicJwk, crv: 'X25519' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Ed25519');
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'Agent' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/agents', () => {
  it('returns list of agents', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: Array<{ agentId: string }> }>();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.agentId).toBe(TEST_AGENT.id);
  });

  it('returns empty list when no agents', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: unknown[] }>();
    expect(body.agents).toHaveLength(0);
  });
});

describe('GET /v1/agents/:id', () => {
  it('returns agent by id', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([TEST_AGENT]);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ agentId: string }>();
    expect(body.agentId).toBe(TEST_AGENT.id);
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/agents/:id', () => {
  it('registers exact callback URIs on an existing agent', async () => {
    seedAuth();
    const redirectUris = ['https://client.example/first', 'https://client.example/second'];
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, redirect_uris: redirectUris }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { redirectUris },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().redirectUris).toEqual(redirectUris);
  });

  it('rejects unsafe callback schemes without updating the agent', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { redirectUris: ['javascript:alert(1)'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(sqlMock.mock.calls.some((call) => String(call[0]).includes('UPDATE agents'))).toBe(false);
  });

  it('updates agent fields', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, name: 'Updated Name' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { name: 'Updated Name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ name: string }>();
    expect(body.name).toBe('Updated Name');
  });

  it('returns 404 when patching a non-existent agent', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // UPDATE returns no rows

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/ag_NONEXISTENT',
      headers: authHeader(),
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('returns 400 when no fields provided', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('retires an active agent, recording when, and announces the change', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]); // the current state
    const retiredAt = new Date().toISOString();
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, status: 'retired', retired_at: retiredAt, status_reason: 'decommissioned' }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { status: 'retired', statusReason: 'decommissioned' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('retired');
    expect(res.json().retiredAt).toBe(retiredAt);
    expect(res.json().statusReason).toBe('decommissioned');
    const update = sqlMock.mock.calls.find((call) => String(call[0]).includes('UPDATE agents'));
    expect(String(update![0])).toContain('retired_at');
  });

  it('revokes an agent grant tree in the same transaction as suspension', async () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    seedAuth();
    sqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      if (query.includes('SELECT status FROM agents')) return [{ status: 'active' }];
      if (query.includes('UPDATE agents')) return [{ ...TEST_AGENT, status: 'suspended' }];
      if (query.includes("UPDATE grants SET status = 'revoked'")) {
        return [{ id: 'grnt_parent', expires_at: expiresAt }, { id: 'grnt_child', expires_at: expiresAt }];
      }
      return [];
    });

    const res = await app.inject({
      method: 'PATCH', url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(), payload: { status: 'suspended', statusReason: 'operator action' },
    });

    expect(res.statusCode).toBe(200);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    const queries = sqlMock.mock.calls.map(([parts]) => String(parts));
    expect(queries.findIndex((query) => query.includes('UPDATE agents'))).toBeLessThan(
      queries.findIndex((query) => query.includes("UPDATE grants SET status = 'revoked'")),
    );
    const revoke = sqlMock.mock.calls.find(([parts]) => String(parts).includes("UPDATE grants SET status = 'revoked'"));
    expect(revoke?.slice(1)).toContain(TEST_DEVELOPER.id);
    expect(revoke?.slice(1)).toContain(TEST_AGENT.id);
    expect(queries.join('\n')).toContain('DELETE FROM grant_suspensions');
    expect(mockRedis.set).toHaveBeenCalledWith('revoked:grant:grnt_parent', '1', 'EX', expect.any(Number));
    expect(mockRedis.set).toHaveBeenCalledWith('revoked:grant:grnt_child', '1', 'EX', expect.any(Number));
  });

  it('fails the status change when the grant sweep fails', async () => {
    seedAuth();
    sqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      if (query.includes('SELECT status FROM agents')) return [{ status: 'active' }];
      if (query.includes('UPDATE agents')) return [{ ...TEST_AGENT, status: 'retired' }];
      if (query.includes("UPDATE grants SET status = 'revoked'")) throw new Error('grant sweep unavailable');
      return [];
    });

    const res = await app.inject({
      method: 'PATCH', url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(), payload: { status: 'retired' },
    });

    expect(res.statusCode).toBe(500);
    expect(mockRedis.set).not.toHaveBeenCalledWith(expect.stringContaining('revoked:grant:'), '1', 'EX', expect.any(Number));
  });

  it('sweeps old grants before a suspended agent becomes active again', async () => {
    seedAuth();
    sqlMock.mockImplementation(async (parts: TemplateStringsArray) => {
      const query = parts.join('');
      if (query.includes('SELECT status FROM agents')) return [{ status: 'suspended' }];
      if (query.includes('UPDATE agents')) return [{ ...TEST_AGENT, status: 'active' }];
      return [];
    });

    const res = await app.inject({
      method: 'PATCH', url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(), payload: { status: 'active' },
    });

    expect(res.statusCode).toBe(200);
    expect(sqlMock.mock.calls.some(([parts]) => String(parts).includes("UPDATE grants SET status = 'revoked'"))).toBe(true);
  });

  it('refuses a transition the lifecycle does not allow, before any write', async () => {
    for (const [from, to] of [['retired', 'active'], ['draft', 'suspended'], ['retired', 'suspended']]) {
      sqlMock.mockReset();
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ status: from }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/agents/${TEST_AGENT.id}`,
        headers: authHeader(),
        payload: { status: to },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('AGENT_STATUS_TRANSITION');
      expect(sqlMock.mock.calls.some((call) => String(call[0]).includes('UPDATE agents'))).toBe(false);
    }
  });

  it('activates a draft and lets a suspended agent resume', async () => {
    for (const [from, to] of [['draft', 'active'], ['suspended', 'active'], ['active', 'suspended'], ['active', 'active']]) {
      sqlMock.mockReset();
      sqlMock.mockResolvedValue([]);
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ status: from }]);
      sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, status: to }]);
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/agents/${TEST_AGENT.id}`,
        headers: authHeader(),
        payload: { status: to },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(to);
    }
  });

  it('answers 409 when the status changed between the check and the write', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ status: 'active' }]);
    sqlMock.mockResolvedValueOnce([]); // the conditional UPDATE matched no row: another change won
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { status: 'retired' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('AGENT_STATUS_CONFLICT');
    const update = sqlMock.mock.calls.find((call) => String(call[0]).includes('UPDATE agents'));
    expect(String(update![0])).toContain('status = ');
    expect(update!.slice(1)).toContain('active');
  });

  it('keeps the recorded reason on a same-state request and replaces it on a change', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ status: 'suspended' }]);
    sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, status: 'suspended', status_reason: 'incident 42' }]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    const update = sqlMock.mock.calls.find((call) => String(call[0]).includes('UPDATE agents'));
    expect(String(update![0])).toContain('= status THEN status_reason');
  });

  it('keeps the routes as before while lifecycle states are off', async () => {
    delete process.env['AGENT_LIFECYCLE_STATES_ENABLED'];
    try {
      seedAuth();
      const refused = await app.inject({
        method: 'PATCH',
        url: `/v1/agents/${TEST_AGENT.id}`,
        headers: authHeader(),
        payload: { status: 'retired', statusReason: 'decommissioned' },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().message).toBe('status must be active or suspended');

      sqlMock.mockReset();
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ ...TEST_AGENT, status: 'suspended' }]);
      const suspended = await app.inject({
        method: 'PATCH',
        url: `/v1/agents/${TEST_AGENT.id}`,
        headers: authHeader(),
        payload: { status: 'suspended', statusReason: 'ignored while off' },
      });
      expect(suspended.statusCode).toBe(200);
      // No state read before the write, and the reason is not sent.
      expect(sqlMock.mock.calls.some((call) => String(call[0]).includes('SELECT status FROM agents'))).toBe(false);
      const update = sqlMock.mock.calls.find((call) => String(call[0]).includes('UPDATE agents'));
      expect(update!.slice(1)).not.toContain('ignored while off');

      sqlMock.mockReset();
      seedAuth();
      sqlMock.mockResolvedValueOnce([]);
      sqlMock.mockResolvedValueOnce([]);
      sqlMock.mockResolvedValueOnce([{ count: '0' }]);
      sqlMock.mockResolvedValueOnce([TEST_AGENT]);
      const registered = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: authHeader(),
        payload: { name: 'Draft Agent', status: 'draft' },
      });
      expect(registered.statusCode).toBe(201);
      const insert = sqlMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO agents'));
      expect(insert!.slice(1)).toContain('active');
      expect(insert!.slice(1)).not.toContain('draft');
    } finally {
      process.env['AGENT_LIFECYCLE_STATES_ENABLED'] = 'true';
    }
  });

  it('answers 404 for a status change on an agent that does not exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/ag_NONEXISTENT',
      headers: authHeader(),
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a status reason that is too long', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { status: 'suspended', statusReason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unsupported agent statuses', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { status: 'deleted' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed patch scopes', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
      payload: { scopes: 'read' },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/agents/:id', () => {
  it('deletes agent and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // SELECT existence check
    sqlMock.mockResolvedValueOnce([]); // agent lifecycle advisory lock
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent row lock
    sqlMock.mockResolvedValueOnce([]); // prepaid-wallet financial history check
    sqlMock.mockResolvedValueOnce([]); // issued credential history check
    sqlMock.mockResolvedValueOnce([]); // DELETE budget_transactions
    sqlMock.mockResolvedValueOnce([]); // DELETE budget_allocations
    sqlMock.mockResolvedValueOnce([]); // DELETE refresh_tokens
    sqlMock.mockResolvedValueOnce([]); // DELETE grant_tokens
    sqlMock.mockResolvedValueOnce([]); // DELETE grants
    sqlMock.mockResolvedValueOnce([]); // DELETE auth_requests
    sqlMock.mockResolvedValueOnce([]); // DELETE oauth_par_requests
    sqlMock.mockResolvedValueOnce([]); // DELETE agents

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls.map((call) => String(call[0])).join('\n')).toContain('oauth_par_requests');
  });

  it('preserves prepaid-wallet evidence instead of failing a hard delete', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // SELECT existence check
    sqlMock.mockResolvedValueOnce([]); // agent lifecycle advisory lock
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent row lock
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]); // financial history exists

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${TEST_AGENT.id}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'AGENT_HAS_FINANCIAL_HISTORY' });
    expect(sqlMock.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('DELETE FROM agents');
  });

  it('preserves issued credential status and history instead of failing a hard delete', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]);
    sqlMock.mockResolvedValueOnce([]); // advisory lock
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // row lock
    sqlMock.mockResolvedValueOnce([]); // no financial history
    sqlMock.mockResolvedValueOnce([{ '?column?': 1 }]); // credential history
    const response = await app.inject({
      method: 'DELETE', url: `/v1/agents/${TEST_AGENT.id}`, headers: authHeader(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'AGENT_HAS_CREDENTIAL_HISTORY' });
    const queries = sqlMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(queries).toContain('FOR UPDATE');
    expect(queries).toContain('g.developer_id =');
    expect(queries).not.toContain('DELETE FROM grants');
    expect(queries).not.toContain('DELETE FROM agents');
  });

  it('returns 404 when agent not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // SELECT existence check → empty

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/nonexistent`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

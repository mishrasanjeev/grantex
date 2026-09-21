import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, sqlMock, TEST_ADMIN_API_KEY, TEST_DEVELOPER } from './helpers.js';
import { confirmationPhrase } from '../src/lib/revocation/emergency-stop.js';

let app: FastifyInstance;

interface SqlState {
  statements: string[];
  handlers: Array<[RegExp, unknown[]]>;
  /** Roots returned by the first scope read only: the stop sweeps until it reads none. */
  rootsOnce: unknown[] | null;
}

let state: SqlState;

function installSql(): void {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    state.statements.push(text.replace(/\s+/g, ' ').trim());
    if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
    if (state.rootsOnce !== null && /SELECT id FROM grants/.test(text)) {
      const rows = state.rootsOnce;
      state.rootsOnce = [];
      return rows;
    }
    for (const [pattern, rows] of state.handlers) {
      if (pattern.test(text)) return rows;
    }
    return [];
  });
}

const SCOPE = { type: 'agent' as const, id: 'ag_TEST01AGENTID' };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: SCOPE,
    reason: 'provider reported the company dissolved',
    confirm: confirmationPhrase(SCOPE),
    ...overrides,
  };
}

function adminHeader(): Record<string, string> {
  return { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };
}

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  state = { statements: [], handlers: [], rootsOnce: null };
  installSql();
  vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the emergency stop flag', () => {
  it('refuses the developer route and hides the admin route unless EMERGENCY_STOP_ENABLED is true', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    const developer = await app.inject({ method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body() });
    expect(developer.statusCode).toBe(403);
    expect(developer.json()).toMatchObject({ code: 'FEATURE_DISABLED' });

    const admin = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', headers: adminHeader(),
      payload: body({ developerId: TEST_DEVELOPER.id }),
    });
    expect(admin.statusCode).toBe(404);
    expect(state.statements.some((s) => s.includes('emergency_stops'))).toBe(false);
  });
});

describe('POST /v1/emergency-stop', () => {
  it('refuses without the exact confirmation phrase, without handing the phrase over', async () => {
    for (const payload of [body({ confirm: undefined }), body({ confirm: 'yes' }), body({ confirm: 'stop agent:other' })]) {
      const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload });
      expect(res.statusCode).toBe(412);
      expect(res.json()).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      // The expected phrase is not echoed: a caller who could copy it out of
      // the refusal and repeat the call has not confirmed anything.
      expect(res.json()).not.toHaveProperty('expected');
      expect(res.payload).not.toContain(confirmationPhrase(SCOPE));
    }
    expect(state.statements.some((s) => s.includes('UPDATE grants'))).toBe(false);
  });

  it('refuses a malformed scope, a missing reason and a bad dryRun', async () => {
    for (const payload of [
      body({ scope: { type: 'tenant', id: 'x' } }),
      body({ scope: { type: 'agent' } }),
      body({ reason: '' }),
      body({ dryRun: 'yes' }),
      ['not an object'],
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses to stop another developer', async () => {
    const scope = { type: 'developer' as const, id: 'dev_SOMEONE_ELSE' };
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(),
      payload: { scope, reason: 'testing', confirm: confirmationPhrase(scope) },
    });
    expect(res.statusCode).toBe(403);
    expect(state.statements.some((s) => s.includes('UPDATE grants'))).toBe(false);

    const withOtherDeveloperId = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(),
      payload: body({ developerId: 'dev_SOMEONE_ELSE' }),
    });
    expect(withOtherDeveloperId.statusCode).toBe(403);
  });

  it('reports the blast radius without revoking anything for a dry run', async () => {
    state.rootsOnce = [{ id: 'grnt_1' }, { id: 'grnt_2' }];
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body({ dryRun: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, grantsMatched: 2, grantsRevoked: 0 });
    // Recorded, so `GET /v1/emergency-stops` can answer who rehearsed a stop
    // against this tenant and when — but nothing is revoked.
    expect(state.statements.some((s) => s.includes('INSERT INTO emergency_stops'))).toBe(true);
    expect(state.statements.some((s) => s.includes('UPDATE grants'))).toBe(false);
  });

  it('records the stop and cascades over every matched grant, then sweeps again', async () => {
    state.rootsOnce = [{ id: 'grnt_1' }];
    state.handlers.push([/WITH RECURSIVE tree/, [
      { id: 'grnt_1', root_id: 'grnt_1', depth: 0, agent_id: SCOPE.id, agent_did: 'did:grantex:ag_1', principal_id: 'user_1', expires_at: new Date(Date.now() + 3_600_000) },
      { id: 'grnt_2', root_id: 'grnt_1', depth: 1, agent_id: 'ag_child', agent_did: 'did:grantex:ag_child', principal_id: 'user_1', expires_at: new Date(Date.now() + 3_600_000) },
    ]]);
    const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body() });
    expect(res.statusCode).toBe(200);
    const stop = res.json<{
      stopId: string; status: string; sweeps: number; grantsRevoked: number;
      agentsStopped: string[]; lockout: boolean;
    }>();
    expect(stop.stopId).toMatch(/^stop_/);
    expect(stop.status).toBe('completed');
    // One sweep that found the grant, one that came back empty.
    expect(stop.sweeps).toBe(2);
    expect(stop.lockout).toBe(false);
    expect(stop.grantsRevoked).toBe(2);
    expect(stop.agentsStopped.sort()).toEqual([SCOPE.id, 'ag_child'].sort());
    expect(state.statements.some((s) => s.includes('INSERT INTO emergency_stops'))).toBe(true);
    // The record is updated as the work proceeds and again at the end, so a
    // failure part way through cannot leave it reading as though nothing
    // happened.
    expect(state.statements.filter((s) => s.includes('UPDATE emergency_stops SET')).length)
      .toBeGreaterThanOrEqual(2);
    // Per-grant revocation entries and the summary entry all go on the chain.
    expect(state.statements.filter((s) => s.includes('INSERT INTO audit_entries')).length).toBe(3);
  });
});

describe('POST /v1/admin/emergency-stop', () => {
  it('needs the admin key', async () => {
    const anonymous = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', payload: body({ developerId: TEST_DEVELOPER.id }),
    });
    expect(anonymous.statusCode).toBe(401);

    const developerKey = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', headers: authHeader(),
      payload: body({ developerId: TEST_DEVELOPER.id }),
    });
    expect(developerKey.statusCode).toBe(401);
    expect(state.statements.some((s) => s.includes('UPDATE grants'))).toBe(false);
  });

  it('requires a developerId for a grant, agent or principal scope', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', headers: adminHeader(), payload: body(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('stops a whole developer, taking the developer from the scope', async () => {
    const scope = { type: 'developer' as const, id: 'dev_TENANT' };
    state.rootsOnce = [{ id: 'grnt_1' }];
    state.handlers.push([/WITH RECURSIVE tree/, [
      { id: 'grnt_1', root_id: 'grnt_1', depth: 0, agent_id: 'ag_1', agent_did: 'did:grantex:ag_1', principal_id: 'user_1', expires_at: new Date(Date.now() + 3_600_000) },
    ]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', headers: adminHeader(),
      payload: { scope, reason: 'incident 4102', confirm: confirmationPhrase(scope) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      developerId: 'dev_TENANT', grantsRevoked: 1, dryRun: false, status: 'completed', lockout: false,
    });
  });
});

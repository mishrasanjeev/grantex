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

describe('the lockout option', () => {
  function sweepOnce(): void {
    state.rootsOnce = [{ id: 'grnt_1' }];
    state.handlers.push([/WITH RECURSIVE tree/, [
      { id: 'grnt_1', root_id: 'grnt_1', depth: 0, agent_id: SCOPE.id, agent_did: 'did:grantex:ag_1', principal_id: 'user_1', expires_at: new Date(Date.now() + 3_600_000) },
    ]]);
  }

  it('refuses a lockout that is not a boolean, before anything is recorded', async () => {
    for (const lockout of ['yes', 1, null]) {
      const res = await app.inject({
        method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body({ lockout }),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(state.statements.some((s) => s.includes('emergency_stops') || s.includes('issuance_freezes'))).toBe(false);
  });

  it('records the freeze before the first sweep, and says lockout: true', async () => {
    sweepOnce();
    state.handlers.push([/INSERT INTO issuance_freezes/, [{ id: 'frz_placed' }]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body({ lockout: true }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ lockout: true, freezeId: 'frz_placed', status: 'completed', grantsRevoked: 1 });

    const freezeAt = state.statements.findIndex((s) => s.includes('INSERT INTO issuance_freezes'));
    const firstSweep = state.statements.findIndex((s) => s.includes('SELECT id FROM grants'));
    expect(freezeAt).toBeGreaterThan(-1);
    // The freeze is in force before the sweep reads the scope, so nothing
    // issued while the stop runs can outlive it.
    expect(freezeAt).toBeLessThan(firstSweep);
    // Taken exclusively by the freeze and shared by every issuance path.
    const lock = state.statements.findIndex((s) => /pg_advisory_xact_lock\(hashtextextended\(\?, 5\)\)/.test(s));
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(freezeAt);
    // The stop row carries the lockout, written in the same transaction.
    expect(state.statements.some((s) => s.includes('INSERT INTO emergency_stops') && s.includes('lockout'))).toBe(true);
    // Freeze entry, one revocation, and the summary.
    expect(state.statements.filter((s) => s.includes('INSERT INTO audit_entries')).length).toBe(3);
  });

  it('reaffirms a freeze already in force rather than stacking another', async () => {
    sweepOnce();
    // The insert conflicts with the freeze in force; that one is reused.
    state.handlers.push([/INSERT INTO issuance_freezes/, []]);
    state.handlers.push([/FROM issuance_freezes/, [{ id: 'frz_existing', placed_by: 'developer' }]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body({ lockout: true }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ lockout: true, freezeId: 'frz_existing' });
  });

  it('freezes nothing on a dry run, and says lockout: false', async () => {
    state.rootsOnce = [{ id: 'grnt_1' }];
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body({ dryRun: true, lockout: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, lockout: false });
    expect(res.json()).not.toHaveProperty('freezeId');
    expect(state.statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('leaves the freeze table alone when the stop does not ask for a lockout', async () => {
    sweepOnce();
    const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop', headers: authHeader(), payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ lockout: false });
    expect(state.statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('lets the operator place a lockout on any tenant', async () => {
    const scope = { type: 'developer' as const, id: 'dev_TENANT' };
    state.rootsOnce = [];
    state.handlers.push([/INSERT INTO issuance_freezes/, [{ id: 'frz_operator' }]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop', headers: adminHeader(),
      payload: { scope, reason: 'incident 4102', confirm: confirmationPhrase(scope), lockout: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ developerId: 'dev_TENANT', lockout: true, freezeId: 'frz_operator' });
  });
});

const FREEZE_ROW = {
  id: 'frz_1', developer_id: TEST_DEVELOPER.id, scope_type: SCOPE.type, scope_id: SCOPE.id, stop_id: 'stop_1',
  placed_by: 'developer', reason: 'incident 4102', requested_by: 'developer:dev_TEST@127.0.0.1',
  created_at: new Date('2026-09-20T10:00:00Z'), cleared_at: null, cleared_by: null, clear_reason: null,
};

function unfreezeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scope: SCOPE, reason: 'key rotated', confirm: `unfreeze ${SCOPE.type}:${SCOPE.id}`, ...overrides };
}

describe('POST /v1/emergency-stop/unfreeze', () => {
  it('is refused unless EMERGENCY_STOP_ENABLED is true', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload: unfreezeBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(state.statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('refuses without the exact phrase, without handing it over', async () => {
    for (const payload of [unfreezeBody({ confirm: undefined }), unfreezeBody({ confirm: confirmationPhrase(SCOPE) })]) {
      const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload });
      expect(res.statusCode).toBe(412);
      expect(res.json()).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      expect(res.payload).not.toContain(`unfreeze ${SCOPE.type}:${SCOPE.id}`);
    }
    expect(state.statements.some((s) => s.includes('UPDATE issuance_freezes'))).toBe(false);
  });

  it('refuses a malformed scope or reason', async () => {
    for (const payload of [
      unfreezeBody({ scope: { type: 'tenant', id: 'x' } }),
      unfreezeBody({ reason: '' }),
      ['not an object'],
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('refuses to lift another developer', async () => {
    const scope = { type: 'developer' as const, id: 'dev_SOMEONE_ELSE' };
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(),
      payload: { scope, reason: 'testing', confirm: `unfreeze developer:${scope.id}` },
    });
    expect(res.statusCode).toBe(403);
    expect(state.statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('says so when there is nothing to lift', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload: unfreezeBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FROZEN' });
  });

  it('does not let the developer key lift a freeze the operator placed', async () => {
    state.handlers.push([/FROM issuance_freezes/, [{ ...FREEZE_ROW, placed_by: 'operator', requested_by: 'admin:192.0.2.1' }]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload: unfreezeBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FREEZE_HELD_BY_OPERATOR' });
    expect(state.statements.some((s) => s.includes('UPDATE issuance_freezes'))).toBe(false);
    expect(state.statements.some((s) => s.includes('INSERT INTO audit_entries'))).toBe(false);
  });

  it('lifts a freeze the developer placed, and writes it on the audit chain', async () => {
    const cleared = new Date('2026-09-21T09:00:00Z');
    state.handlers.push([/UPDATE issuance_freezes/, [{
      ...FREEZE_ROW, cleared_at: cleared, cleared_by: 'developer:dev_TEST@127.0.0.1', clear_reason: 'key rotated',
    }]]);
    state.handlers.push([/FROM issuance_freezes/, [FREEZE_ROW]]);
    const res = await app.inject({
      method: 'POST', url: '/v1/emergency-stop/unfreeze', headers: authHeader(), payload: unfreezeBody(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      freezeId: 'frz_1', developerId: TEST_DEVELOPER.id, scope: SCOPE, stopId: 'stop_1', placedBy: 'developer',
      clearedAt: cleared.toISOString(), clearedBy: 'developer:dev_TEST@127.0.0.1', clearReason: 'key rotated',
    });
    expect(state.statements.some((s) => /pg_advisory_xact_lock\(hashtextextended\(\?, 5\)\)/.test(s))).toBe(true);
    expect(state.statements.filter((s) => s.includes('INSERT INTO audit_entries')).length).toBe(1);
  });
});

describe('POST /v1/admin/emergency-stop/unfreeze', () => {
  const scope = { type: 'developer' as const, id: 'dev_TENANT' };
  const payload = { scope, reason: 'incident closed', confirm: `unfreeze developer:${scope.id}` };

  it('is hidden unless EMERGENCY_STOP_ENABLED is true, and needs the admin key', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    const hidden = await app.inject({ method: 'POST', url: '/v1/admin/emergency-stop/unfreeze', headers: adminHeader(), payload });
    expect(hidden.statusCode).toBe(404);
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');

    const anonymous = await app.inject({ method: 'POST', url: '/v1/admin/emergency-stop/unfreeze', payload });
    expect(anonymous.statusCode).toBe(401);
    const developerKey = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop/unfreeze', headers: authHeader(), payload,
    });
    expect(developerKey.statusCode).toBe(401);
    expect(state.statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('requires a developerId for a grant, agent or principal scope', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/admin/emergency-stop/unfreeze', headers: adminHeader(), payload: unfreezeBody(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('lifts a freeze the operator placed', async () => {
    const row = {
      ...FREEZE_ROW, id: 'frz_op', developer_id: 'dev_TENANT', scope_type: 'developer', scope_id: 'dev_TENANT',
      stop_id: null, placed_by: 'operator', requested_by: 'admin:192.0.2.1',
    };
    state.handlers.push([/UPDATE issuance_freezes/, [{
      ...row, cleared_at: new Date(), cleared_by: 'admin:127.0.0.1', clear_reason: 'incident closed',
    }]]);
    state.handlers.push([/FROM issuance_freezes/, [row]]);
    const res = await app.inject({ method: 'POST', url: '/v1/admin/emergency-stop/unfreeze', headers: adminHeader(), payload });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ freezeId: 'frz_op', developerId: 'dev_TENANT', placedBy: 'operator', stopId: null });
  });
});

describe('GET /v1/emergency-stops', () => {
  it('lists the freezes still in force beside the stops', async () => {
    state.handlers.push([/FROM issuance_freezes/, [{
      ...FREEZE_ROW, scope_type: 'developer', scope_id: TEST_DEVELOPER.id, placed_by: 'operator', requested_by: 'admin:192.0.2.1',
    }]]);
    const res = await app.inject({ method: 'GET', url: '/v1/emergency-stops', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      stops: [],
      freezes: [{
        freezeId: 'frz_1', scope: { type: 'developer', id: TEST_DEVELOPER.id }, stopId: 'stop_1',
        placedBy: 'operator', frozenAt: '2026-09-20T10:00:00.000Z',
      }],
    });
  });
});

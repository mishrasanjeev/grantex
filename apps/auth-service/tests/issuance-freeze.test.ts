// SPDX-License-Identifier: Apache-2.0
/**
 * The freeze check every issuance path makes (lib/revocation/issuance-freeze.ts),
 * on its own: when it reads, what it takes, and how it fails. The paths
 * themselves are exercised against real Postgres in
 * emergency-stop-lockout-postgres.integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxSql } from '../src/db/client.js';
import type { AppLogger } from '../src/lib/logger.js';
import {
  FreezeStateUnavailableError,
  IssuanceFrozenError,
  assertIssuanceOpen,
  issuanceRefusal,
} from '../src/lib/revocation/issuance-freeze.js';
import { authHeader, buildTestApp, sqlMock, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';

interface Recorded {
  sql: TxSql;
  statements: string[];
  values: unknown[][];
}

function recordingSql(respond: (text: string) => unknown[] | Error): Recorded {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const fn = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push(text);
    values.push(params);
    const result = respond(text);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { sql: fn as unknown as TxSql, statements, values };
}

const FROZEN = { id: 'frz_1', scope_type: 'agent', scope_id: 'ag_1', stop_id: 'stop_1' };
const quiet: AppLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => quiet,
};
const SUBJECT = { developerId: 'dev_1', agentIds: ['ag_1'], principalIds: ['user_1'], grantIds: ['grnt_1'] };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('assertIssuanceOpen', () => {
  it('reads nothing unless EMERGENCY_STOP_ENABLED is true', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    const recorded = recordingSql(() => new Error('must not be called'));
    await expect(assertIssuanceOpen(recorded.sql, SUBJECT, { path: 'token', inTransaction: true, log: quiet })).resolves.toBeUndefined();
    expect(recorded.statements).toEqual([]);
  });

  it('inside a transaction, takes the shared lock before it reads', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    const recorded = recordingSql(() => []);
    await assertIssuanceOpen(recorded.sql, SUBJECT, { path: 'token', inTransaction: true, log: quiet });
    expect(recorded.statements).toHaveLength(2);
    // A separate statement, first: under READ COMMITTED a read in the same
    // statement would have taken its snapshot before the lock was granted.
    expect(recorded.statements[0]).toBe('SELECT pg_advisory_xact_lock_shared(hashtextextended(?, 5))');
    expect(recorded.values[0]).toEqual(['dev_1']);
    expect(recorded.statements[1]).toContain('FROM issuance_freezes');
    expect(recorded.statements[1]).toContain('cleared_at IS NULL');
  });

  it('outside a transaction, only reads', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    const recorded = recordingSql(() => []);
    await assertIssuanceOpen(recorded.sql, { developerId: 'dev_1', agentIds: ['ag_1'] }, { path: 'authorize', inTransaction: false, log: quiet });
    expect(recorded.statements).toHaveLength(1);
    expect(recorded.statements[0]).toContain('FROM issuance_freezes');
  });

  it('matches the developer, the agents, the principals and the lineage of the grants it is given', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    const recorded = recordingSql(() => []);
    await assertIssuanceOpen(recorded.sql, {
      developerId: 'dev_1', agentIds: ['ag_1', 'ag_1', 'ag_2'], principalIds: ['user_1'], grantIds: ['grnt_1'],
    }, { path: 'delegate', inTransaction: false, log: quiet });
    const params = recorded.values[0]!;
    expect(params).toContain('dev_1');
    expect(params).toContainEqual(['ag_1', 'ag_2']);
    expect(params).toContainEqual(['user_1']);
    expect(params).toContainEqual(['grnt_1']);
    // Ancestors of a grant count: a freeze on a grant, or on the agent or
    // principal of any grant above it, covers everything delegated beneath.
    expect(recorded.statements[0]).toContain('WITH RECURSIVE lineage');
  });

  it('refuses when a freeze covers the subject', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    const recorded = recordingSql((text) => (text.includes('FROM issuance_freezes') ? [FROZEN] : []));
    const failure = await assertIssuanceOpen(recorded.sql, SUBJECT, { path: 'token_refresh', inTransaction: true, log: quiet })
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(IssuanceFrozenError);
    expect((failure as IssuanceFrozenError).freeze).toMatchObject({ id: 'frz_1', scopeType: 'agent', stopId: 'stop_1' });
    expect(issuanceRefusal(failure)).toMatchObject({ statusCode: 403, body: { code: 'ISSUANCE_FROZEN' } });
  });

  it('fails closed, keeping the cause, when the freeze state cannot be read', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    for (const failing of ['pg_advisory_xact_lock_shared', 'FROM issuance_freezes']) {
      const cause = Object.assign(new Error('connection reset'), { code: '08006' });
      const recorded = recordingSql((text) => (text.includes(failing) ? cause : []));
      const failure = await assertIssuanceOpen(recorded.sql, SUBJECT, { path: 'token', inTransaction: true, log: quiet })
        .then(() => null, (err: unknown) => err);
      expect(failure).toBeInstanceOf(FreezeStateUnavailableError);
      expect((failure as Error).cause).toBe(cause);
      expect(issuanceRefusal(failure)).toMatchObject({ statusCode: 503, body: { code: 'FREEZE_STATE_UNAVAILABLE' } });
    }
  });

  it('leaves every other error alone', () => {
    expect(issuanceRefusal(new Error('something else'))).toBeNull();
    expect(issuanceRefusal({ statusCode: 400, code: 'BAD_REQUEST' })).toBeNull();
  });
});

describe('POST /v1/authorize and the freeze', () => {
  let app: FastifyInstance;
  let statements: string[];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    statements = [];
  });

  function install(freezeRows: unknown[] | Error): void {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
      if (text.includes('FROM issuance_freezes')) {
        if (freezeRows instanceof Error) throw freezeRows;
        return freezeRows;
      }
      return [];
    });
  }

  const payload = { agentId: 'ag_TEST01AGENTID', principalId: 'user_1', scopes: ['read'] };

  it('does not read the freeze state while EMERGENCY_STOP_ENABLED is off', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    install(new Error('must not be read'));
    const res = await app.inject({ method: 'POST', url: '/v1/authorize', headers: authHeader(), payload });
    // The unchanged path: the agent lookup finds nothing in this mock.
    expect(res.statusCode).toBe(404);
    expect(statements.some((s) => s.includes('issuance_freezes'))).toBe(false);
  });

  it('is refused under a freeze, before anything is written', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install([FROZEN]);
    const res = await app.inject({ method: 'POST', url: '/v1/authorize', headers: authHeader(), payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    expect(statements.some((s) => s.includes('INSERT INTO auth_requests'))).toBe(false);
  });

  it('is refused, not let through, when the freeze state cannot be read', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install(Object.assign(new Error('connection reset'), { code: '08006' }));
    const res = await app.inject({ method: 'POST', url: '/v1/authorize', headers: authHeader(), payload });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'FREEZE_STATE_UNAVAILABLE' });
    expect(statements.some((s) => s.includes('INSERT INTO auth_requests'))).toBe(false);
  });
});

describe('POST /v1/passport/issue and the freeze', () => {
  let app: FastifyInstance;
  let statements: string[];

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    statements = [];
  });

  const grant = {
    id: 'grnt_1', scopes: ['payments:mpp:inference'], principal_id: 'user_1', status: 'active',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), delegation_depth: 0,
  };
  const payload = {
    agentId: TEST_AGENT.id, grantId: 'grnt_1', allowedMPPCategories: ['inference'],
    maxTransactionAmount: { amount: 5, currency: 'USDC' },
  };

  /** Answers by statement; `lockedGrant` is what the grant reads as inside the write's transaction. */
  function install(options: { freezeRows?: unknown[]; lockedGrant?: unknown[] } = {}): void {
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
      if (text.includes('FROM agents')) return [{ id: TEST_AGENT.id, did: TEST_AGENT.did }];
      // Before the grant lookups: the freeze read walks the grant lineage too.
      if (text.includes('FROM issuance_freezes')) return options.freezeRows ?? [];
      if (text.includes('FOR SHARE')) return options.lockedGrant ?? [{ id: 'grnt_1' }];
      if (text.includes('FROM grants')) return [grant];
      if (text.includes('UPDATE vc_status_lists')) return [{ id: 'vcsl_1', allocated_index: 0 }];
      return [];
    });
  }

  const position = (fragment: string): number => statements.findIndex((s) => s.includes(fragment));

  it('writes the passport in one transaction that locks the grant and checks the freeze first', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install();
    const res = await app.inject({ method: 'POST', url: '/v1/passport/issue', headers: authHeader(), payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    const order = [
      position('FOR SHARE'),
      position('pg_advisory_xact_lock_shared'),
      position('FROM issuance_freezes'),
      position('INSERT INTO mpp_passports'),
      position('INSERT INTO verifiable_credentials'),
    ];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('is refused under a freeze, and writes nothing', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install({ freezeRows: [FROZEN] });
    const res = await app.inject({ method: 'POST', url: '/v1/passport/issue', headers: authHeader(), payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    expect(position('INSERT INTO mpp_passports')).toBe(-1);
    expect(position('INSERT INTO verifiable_credentials')).toBe(-1);
  });

  it('is refused when the grant is no longer active by the time it is written', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install({ lockedGrant: [] });
    const res = await app.inject({ method: 'POST', url: '/v1/passport/issue', headers: authHeader(), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_GRANT' });
    expect(position('INSERT INTO mpp_passports')).toBe(-1);
    expect(position('INSERT INTO verifiable_credentials')).toBe(-1);
  });

  it('with the stop off, reads neither the freeze nor the grant again', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    install({ lockedGrant: [] });
    const res = await app.inject({ method: 'POST', url: '/v1/passport/issue', headers: authHeader(), payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(position('issuance_freezes')).toBe(-1);
    expect(position('pg_advisory_xact_lock_shared')).toBe(-1);
    expect(position('FOR SHARE')).toBe(-1);
    expect(position('INSERT INTO mpp_passports')).toBeGreaterThanOrEqual(0);
    expect(position('INSERT INTO verifiable_credentials')).toBeGreaterThanOrEqual(0);
  });

  it('with the stop off, writes on the pool as it always did, with no transaction around the two rows', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    install();
    const inner = sqlMock.getMockImplementation()!;
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string, ...rest: unknown[]) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('INSERT INTO verifiable_credentials')) {
        statements.push(text.replace(/\s+/g, ' ').trim());
        throw new Error('credential insert failed');
      }
      return inner(strings, ...rest);
    });
    const res = await app.inject({ method: 'POST', url: '/v1/passport/issue', headers: authHeader(), payload });
    expect(res.statusCode).toBe(500);
    // The passport row was its own write, so it is not rolled back with the
    // credential's: the behaviour of the route before the lockout existed.
    expect(sqlMock.begin).not.toHaveBeenCalled();
    expect(position('INSERT INTO mpp_passports')).toBeGreaterThanOrEqual(0);
    expect(position('INSERT INTO verifiable_credentials')).toBeGreaterThan(position('INSERT INTO mpp_passports'));
  });
});

/**
 * The best-effort credential of a code exchange or a delegation is issued
 * after the grant's own transaction commits. With the emergency stop on, it
 * is written in a transaction of its own that locks the grant's row, takes
 * the lockout's shared lock and reads the freeze again before anything is
 * written. The interleavings themselves are driven against real Postgres in
 * emergency-stop-lockout-postgres.integration.test.ts.
 */
describe('a credential issued after its grant has committed', () => {
  let app: FastifyInstance;
  let statements: string[];
  let parentToken: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const { signGrantToken } = await import('../src/lib/crypto.js');
    parentToken = await signGrantToken({
      sub: 'user_1', agt: TEST_AGENT.did, dev: TEST_DEVELOPER.id, scp: ['read'],
      jti: 'tok_PARENT', grnt: 'grnt_PARENT', exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  beforeEach(() => {
    statements = [];
    vi.stubEnv('PORTABLE_WEBAUTHN_EVIDENCE_ENABLED', 'false');
  });

  const authRequest = {
    id: 'areq_1', agent_id: TEST_AGENT.id, principal_id: 'user_1', developer_id: TEST_DEVELOPER.id,
    scopes: ['read'], expires_in: '1h', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'approved', agent_did: TEST_AGENT.did, redirect_uri: null, code_challenge: null,
    agent_key_thumbprint: null,
  };

  /**
   * Answers by statement. `freezeReads` answers the freeze reads in turn,
   * the grant's own transaction first and then the credential's, and
   * `lockedGrant` is what the credential's re-read of the grant returns.
   */
  function install(options: { freezeReads?: Array<unknown[] | Error>; lockedGrant?: unknown[] } = {}): void {
    const freezeReads = [...(options.freezeReads ?? [])];
    sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      statements.push(text.replace(/\s+/g, ' ').trim());
      if (text.includes('FROM developers d')) return [TEST_DEVELOPER];
      if (text.includes('FROM auth_requests ar')) return [authRequest];
      if (text.includes('FROM grant_tokens gt')) {
        return [{ is_revoked: false, expires_at: new Date(Date.now() + 3_600_000).toISOString(), grant_status: 'active' }];
      }
      if (text.includes('FROM agents')) {
        return [{ id: 'ag_SUB', did: 'did:grantex:ag_SUB', scopes: ['read'], key_thumbprint: null }];
      }
      if (text.includes('FROM issuance_freezes')) {
        const next = freezeReads.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      }
      if (text.includes('SELECT status FROM grants')) return options.lockedGrant ?? [{ status: 'active' }];
      if (/SELECT id\s+FROM grants/.test(text) && text.includes('FOR UPDATE')) return [{ id: 'grnt_PARENT' }];
      if (text.includes('UPDATE vc_status_lists')) return [{ id: 'vcsl_1', allocated_index: 0 }];
      return [];
    });
  }

  const position = (fragment: string, from = 0): number =>
    statements.findIndex((s, index) => index >= from && s.includes(fragment));

  const exchange = () => app.inject({
    method: 'POST', url: '/v1/token', headers: authHeader(),
    payload: { code: 'code_1', agentId: TEST_AGENT.id, credentialFormat: 'vc-jwt' },
  });
  const delegate = () => app.inject({
    method: 'POST', url: '/v1/grants/delegate', headers: authHeader(),
    payload: { parentGrantToken: parentToken, subAgentId: 'ag_SUB', scopes: ['read'], credentialFormat: 'vc-jwt' },
  });

  it('on exchange, writes it in its own transaction after locking the grant and reading the freeze again', async () => {
    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    install();
    const res = await exchange();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toHaveProperty('verifiableCredential');
    expect(sqlMock.begin).toHaveBeenCalledTimes(2);
    const committed = position('UPDATE auth_requests');
    const order = [
      committed,
      position('SELECT status FROM grants', committed),
      position('pg_advisory_xact_lock_shared', committed),
      position('FROM issuance_freezes', committed),
      position('UPDATE vc_status_lists', committed),
      position('INSERT INTO verifiable_credentials', committed),
    ];
    expect(order.every((index) => index >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  for (const [name, call] of [['exchange', exchange], ['delegation', delegate]] as const) {
    it(`on ${name}, refuses with ISSUANCE_FROZEN when a lockout landed after the grant committed`, async () => {
      vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
      install({ freezeReads: [[], [FROZEN]] });
      const res = await call();
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
      expect(position('UPDATE vc_status_lists')).toBe(-1);
      expect(position('INSERT INTO verifiable_credentials')).toBe(-1);
    });

    it(`on ${name}, writes no credential for a grant that is no longer active`, async () => {
      vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
      install({ lockedGrant: [{ status: 'revoked' }] });
      const res = await call();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).not.toHaveProperty('verifiableCredential');
      expect(position('INSERT INTO verifiable_credentials')).toBe(-1);
    });

    it(`on ${name}, writes no credential when the lockout state cannot be read`, async () => {
      vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
      install({ freezeReads: [[], Object.assign(new Error('connection reset'), { code: '08006' })] });
      const res = await call();
      // The grant was committed under a lockout check that passed; only the
      // credential is left out, closed rather than issued unchecked.
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).not.toHaveProperty('verifiableCredential');
      expect(position('INSERT INTO verifiable_credentials')).toBe(-1);
    });

    it(`on ${name}, with the stop off, issues it as before: no re-read and no freeze read`, async () => {
      vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
      install({ lockedGrant: [] });
      const res = await call();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toHaveProperty('verifiableCredential');
      expect(sqlMock.begin).toHaveBeenCalledTimes(1);
      expect(position('SELECT status FROM grants')).toBe(-1);
      expect(position('issuance_freezes')).toBe(-1);
      expect(position('INSERT INTO verifiable_credentials')).toBeGreaterThanOrEqual(0);
    });
  }
});

// SPDX-License-Identifier: Apache-2.0
/**
 * The emergency stop's lockout against real Postgres, through the routes.
 *
 * A stop that asks for `lockout: true` records a freeze before it sweeps, and
 * every issuance path reads it: `POST /v1/authorize`, the code exchange,
 * refresh and delegation of the grantex protocol, the OAuth profile's pushed
 * authorization request and its authorization-code, refresh and
 * token-exchange (RFC 8693) grants, consent bundles and passports. The SQL
 * mock forwards to a real database, so the freeze, its advisory lock, the
 * grants and the audit chain are the production ones.
 *
 * A stop that does not ask for it is the sweep it always was: it says
 * `lockout: false` and the same key can mint a new grant straight afterwards.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey, matchStoredAuditHash } from '../src/lib/hash.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own. Sharing one database across
// the Postgres integration files let `CREATE INDEX CONCURRENTLY` in one file
// deadlock against another file's migration run.
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres emergency stop lockout tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const MIGRATION = '120_emergency_stop_lockout.sql';
const BASE = 'https://grantex.dev';
const RESOURCE = `${BASE}/oauth/resource`;
const REDIRECT = 'https://merchant.example/callback';
const SCOPES = ['tool:acme_kyb:read', 'payments:mpp:inference'];
const OAUTH_SCOPE = 'grantex.resource.read';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

type Sql = ReturnType<typeof postgres>;
type Scope = { type: 'grant' | 'agent' | 'principal' | 'developer'; id: string };

interface DpopKey { privateKey: CryptoKey; publicJwk: JWK; thumbprint: string }

interface Tenant {
  id: string;
  apiKey: string;
  /** Each tenant calls from its own documentation-range address, so route limits never collide. */
  ip: string;
  agentA: string;
  agentB: string;
  oauthAgent: string;
  dpop: DpopKey;
}

let sql: Sql;
let app: FastifyInstance;
let tenantCounter = 0;

/** Armed by a test: the freeze read fails, on the pool and inside transactions. */
let failFreezeReads = false;
/** Armed by a test: the stop's first scope read fails, so the sweep never finishes. */
let failSweepOnce = false;
/** Armed by a test: the next insert into verifiable_credentials fails. */
let failCredentialInsertOnce = false;
/**
 * Armed by a test: the next query whose text contains `match`, on the pool or
 * inside a transaction, says it has been reached and then waits to be
 * released.
 */
let queryHold: { match: string; reached: () => void; released: Promise<void> } | null = null;

function textOf(args: unknown[]): string {
  const first = args[0];
  return Array.isArray(first) ? first.join('?') : String(first);
}

function guard(text: string): void {
  if (failFreezeReads && text.includes('FROM issuance_freezes')) {
    throw Object.assign(new Error('could not read the freeze state: connection reset'), { code: '08006' });
  }
  if (failSweepOnce && text.includes('SELECT id FROM grants')) {
    failSweepOnce = false;
    throw Object.assign(new Error('connection reset during the sweep'), { code: '08006' });
  }
  if (failCredentialInsertOnce && text.includes('INSERT INTO verifiable_credentials')) {
    failCredentialInsertOnce = false;
    throw Object.assign(new Error('connection reset while writing the credential'), { code: '08006' });
  }
}

/** Runs the query, or holds it first when it is the one a test is waiting on. */
function held(text: string, run: () => unknown): unknown {
  const hold = queryHold;
  if (hold === null || !text.includes(hold.match)) return run();
  queryHold = null;
  hold.reached();
  return hold.released.then(() => run());
}

/** Arms `queryHold`; `atQuery` resolves when the query is reached, and `release` lets it go. */
function holdQuery(match: string): { atQuery: Promise<void>; release: () => void } {
  let reached!: () => void;
  const atQuery = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  queryHold = { match, reached, released: new Promise<void>((resolve) => { release = resolve; }) };
  return { atQuery, release };
}

function guarded<T extends object>(target: T): T {
  return new Proxy(target, {
    apply(inner, thisArg, args: unknown[]) {
      const text = textOf(args);
      guard(text);
      return held(text, () => Reflect.apply(inner as never, thisArg, args));
    },
    get: (inner, property) => Reflect.get(inner, property),
  });
}

/** Resolves as `promise` does, or with `fallback` after `ms`, whichever comes first. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves once some session is waiting for the freeze lock of `developerId`
 * (the advisory lock on `hashtextextended(developer_id, 5)`), or once
 * `cancelled` says to stop looking. pg_locks holds a bigint advisory key as
 * its high and low 32 bits.
 */
async function waitingForFreezeLock(developerId: string, cancelled: () => boolean): Promise<void> {
  while (!cancelled()) {
    const rows = await sql<{ waiting: number }[]>`
      SELECT COUNT(*)::int AS waiting
        FROM pg_locks l
       WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${developerId}, 5)`;
    if (rows[0]!.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Whether a credential's revocation bit is set in its published status list. */
async function revocationBitSet(listId: string, index: number): Promise<boolean> {
  const [list] = await sql<{ encoded_list: string }[]>`SELECT encoded_list FROM vc_status_lists WHERE id = ${listId}`;
  const bits = gunzipSync(Buffer.from(list!.encoded_list, 'base64url'));
  return ((bits[Math.floor(index / 8)]! >> (7 - (index % 8))) & 1) === 1;
}

async function createDpopKey(): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, thumbprint: await calculateJwkThumbprint(publicJwk, 'sha256') };
}

async function dpopProof(key: DpopKey, method: string, uri: string): Promise<string> {
  return new SignJWT({ htm: method, htu: uri, jti: randomUUID(), iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    .sign(key.privateKey);
}

async function newTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant: Tenant = {
    id: `dev_lock_${suffix}`,
    apiKey: `gx_test_lockout_${suffix}_key`,
    ip: `203.0.113.${tenantCounter}`,
    agentA: `ag_lock_a_${suffix}`,
    agentB: `ag_lock_b_${suffix}`,
    oauthAgent: `ag_lock_oauth_${suffix}`,
    dpop: await createDpopKey(),
  };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Lockout Test', 'sandbox')`;
  await sql`INSERT INTO agents (id, did, developer_id, name, scopes) VALUES
    (${tenant.agentA}, ${'did:grantex:' + tenant.agentA}, ${tenant.id}, 'Underwriter', ${SCOPES}),
    (${tenant.agentB}, ${'did:grantex:' + tenant.agentB}, ${tenant.id}, 'Screener', ${SCOPES})`;
  await sql`INSERT INTO agents (id, did, developer_id, name, scopes, redirect_uris, resource_servers, key_thumbprint)
            VALUES (${tenant.oauthAgent}, ${'did:grantex:' + tenant.oauthAgent}, ${tenant.id}, 'Nimbus Shopper 2.4',
                    ${[OAUTH_SCOPE]}, ${[REDIRECT]}, ${[RESOURCE]}, ${tenant.dpop.thumbprint})`;
  return tenant;
}

const developerHeaders = (tenant: Tenant) => ({ authorization: `Bearer ${tenant.apiKey}` });
const adminHeaders = () => ({ authorization: `Bearer ${TEST_ADMIN_API_KEY}` });

async function call(tenant: Tenant, method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) {
  return app.inject({
    method,
    url,
    remoteAddress: tenant.ip,
    headers: headers ?? developerHeaders(tenant),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

/** Ask for a grant; a sandbox tenant's request comes back already approved, with its code. */
async function authorize(tenant: Tenant, agentId: string, principalId: string) {
  return call(tenant, 'POST', '/v1/authorize', { agentId, principalId, scopes: SCOPES });
}

async function approvedCode(tenant: Tenant, agentId: string, principalId: string): Promise<string> {
  const res = await authorize(tenant, agentId, principalId);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ code: string }>().code;
}

async function exchange(tenant: Tenant, code: string, agentId: string) {
  return call(tenant, 'POST', '/v1/token', { code, agentId });
}

async function mintGrant(tenant: Tenant, agentId: string, principalId: string) {
  const res = await exchange(tenant, await approvedCode(tenant, agentId, principalId), agentId);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ grantToken: string; refreshToken: string; grantId: string }>();
}

async function refresh(tenant: Tenant, refreshToken: string, agentId: string) {
  return call(tenant, 'POST', '/v1/token/refresh', { refreshToken, agentId });
}

async function delegate(tenant: Tenant, parentGrantToken: string) {
  return call(tenant, 'POST', '/v1/grants/delegate', {
    parentGrantToken, subAgentId: tenant.agentB, scopes: [SCOPES[0]], expiresIn: '30m',
  });
}

async function consentBundle(tenant: Tenant, agentId: string, userId: string) {
  return call(tenant, 'POST', '/v1/consent-bundles', { agentId, userId, scopes: [SCOPES[0]], offlineTTL: '1h' });
}

async function passport(tenant: Tenant, agentId: string, grantId: string) {
  return call(tenant, 'POST', '/v1/passport/issue', {
    agentId, grantId, allowedMPPCategories: ['inference'], maxTransactionAmount: { amount: 5, currency: 'USDC' },
  });
}

const stopBody = (scope: Scope, extra: Record<string, unknown> = {}) => ({
  scope, reason: 'incident 4102: developer key leaked', confirm: `stop ${scope.type}:${scope.id}`, ...extra,
});
const unfreezeBody = (scope: Scope, extra: Record<string, unknown> = {}) => ({
  scope, reason: 'key rotated; incident 4102 closed', confirm: `unfreeze ${scope.type}:${scope.id}`, ...extra,
});

async function stop(tenant: Tenant, scope: Scope, extra: Record<string, unknown> = {}) {
  return call(tenant, 'POST', '/v1/emergency-stop', stopBody(scope, extra));
}
async function adminStop(tenant: Tenant, scope: Scope, extra: Record<string, unknown> = {}) {
  return call(tenant, 'POST', '/v1/admin/emergency-stop', stopBody(scope, extra), adminHeaders());
}
async function unfreeze(tenant: Tenant, scope: Scope, extra: Record<string, unknown> = {}) {
  return call(tenant, 'POST', '/v1/emergency-stop/unfreeze', unfreezeBody(scope, extra));
}
async function adminUnfreeze(tenant: Tenant, scope: Scope, extra: Record<string, unknown> = {}) {
  return call(tenant, 'POST', '/v1/admin/emergency-stop/unfreeze', unfreezeBody(scope, extra), adminHeaders());
}

/**
 * A lockout whose sweep did not finish: the freeze is recorded first, then
 * the stop's first read of its scope fails. The grants it would have revoked
 * are still live — which is exactly when refresh, delegation and exchange
 * have to be refused by the freeze itself rather than by a revocation.
 */
async function lockoutWithUnfinishedSweep(tenant: Tenant, scope: Scope): Promise<void> {
  failSweepOnce = true;
  try {
    const res = await stop(tenant, scope, { lockout: true });
    expect(res.statusCode, res.body).toBe(500);
  } finally {
    failSweepOnce = false;
  }
}

async function activeGrants(tenantId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM grants WHERE developer_id = ${tenantId} AND status = 'active'`;
  return Number(rows[0]!.count);
}

async function verifyChain(developerId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
    FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp, id`;
  let previous: string | null = null;
  for (const row of rows) {
    expect(row['previous_hash'] ?? null).toBe(previous);
    expect(matchStoredAuditHash({
      id: row['id'] as string,
      agentId: row['agent_id'] as string,
      agentDid: row['agent_did'] as string,
      grantId: row['grant_id'] as string,
      principalId: row['principal_id'] as string,
      developerId: row['developer_id'] as string,
      action: row['action'] as string,
      metadata: row['metadata'],
      timestamp: new Date(row['timestamp'] as string).toISOString(),
      prevHash: (row['previous_hash'] as string | null) ?? null,
      status: row['status'] as string,
    }, row['hash'] as string)).not.toBeNull();
    previous = row['hash'] as string;
  }
  return rows;
}

// --- The OAuth profile ------------------------------------------------------

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

async function oauthPost(tenant: Tenant, path: string, values: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: path,
    remoteAddress: tenant.ip,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      dpop: await dpopProof(tenant.dpop, 'POST', `${BASE}${path}`),
    },
    payload: form(values),
  });
}

async function par(tenant: Tenant, challenge: string) {
  return oauthPost(tenant, '/oauth/par', {
    response_type: 'code',
    client_id: tenant.oauthAgent,
    redirect_uri: REDIRECT,
    state: randomBytes(24).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: OAUTH_SCOPE,
    login_hint: 'shopper-01',
  });
}

/** PAR and the authorization endpoint; a sandbox tenant is redirected straight back with a code. */
async function oauthCode(tenant: Tenant): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const pushed = await par(tenant, challenge);
  expect(pushed.statusCode, pushed.body).toBe(201);
  const requestUri = pushed.json<{ request_uri: string }>().request_uri;
  const redirect = await app.inject({
    method: 'GET',
    url: `/oauth/authorize?client_id=${encodeURIComponent(tenant.oauthAgent)}&request_uri=${encodeURIComponent(requestUri)}`,
    remoteAddress: tenant.ip,
  });
  expect(redirect.statusCode, redirect.body).toBe(303);
  const code = new URL(String(redirect.headers['location'])).searchParams.get('code');
  expect(code).toBeTruthy();
  return { code: code!, verifier };
}

async function oauthExchangeCode(tenant: Tenant, code: string, verifier: string) {
  return oauthPost(tenant, '/oauth/token', {
    grant_type: 'authorization_code', code, client_id: tenant.oauthAgent, redirect_uri: REDIRECT, code_verifier: verifier,
  });
}

async function oauthRefresh(tenant: Tenant, refreshToken: string) {
  return oauthPost(tenant, '/oauth/token', {
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: tenant.oauthAgent,
  });
}

async function oauthTokenExchange(tenant: Tenant, accessToken: string) {
  return oauthPost(tenant, '/oauth/token', {
    grant_type: TOKEN_EXCHANGE,
    client_id: tenant.oauthAgent,
    subject_token: accessToken,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: ACCESS_TOKEN_TYPE,
    resource: RESOURCE,
    scope: OAUTH_SCOPE,
  });
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('emergency-lockout');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
  sql = postgres(databaseUrl, { max: 16, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 }).catch(() => undefined);
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  failFreezeReads = false;
  failSweepOnce = false;
  failCredentialInsertOnce = false;
  queryHold = null;
  vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
  sqlMock.mockImplementation(((...args: unknown[]) => {
    const text = textOf(args);
    guard(text);
    return held(text, () => (sql as unknown as (...a: unknown[]) => unknown)(...args));
  }) as never);
  // Only wrapped while a failure or a hold is armed, so ordinary
  // transactions are the untouched postgres.js handle.
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) =>
    sql.begin((tx) => cb(failFreezeReads || failCredentialInsertOnce || queryHold !== null ? guarded(tx as unknown as object) : tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  failFreezeReads = false;
  failSweepOnce = false;
  failCredentialInsertOnce = false;
  queryHold = null;
});

describePostgres('the emergency stop lockout against real Postgres', () => {
  it('a stop without lockout still says lockout: false and leaves issuance open', async () => {
    const tenant = await newTenant();
    await mintGrant(tenant, tenant.agentA, 'user_1');

    const res = await stop(tenant, { type: 'developer', id: tenant.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'completed', grantsRevoked: 1, lockout: false });
    expect(res.json()).not.toHaveProperty('freezeId');
    const freezes = await sql`SELECT id FROM issuance_freezes WHERE developer_id = ${tenant.id}`;
    expect(freezes).toHaveLength(0);

    // The same key mints a new grant straight afterwards: a sweep, not a lockout.
    const after = await mintGrant(tenant, tenant.agentA, 'user_1');
    expect(after.grantToken).toBeTruthy();
    expect(await activeGrants(tenant.id)).toBe(1);

    const listed = await call(tenant, 'GET', '/v1/emergency-stops');
    expect(listed.json()).toMatchObject({ stops: [{ lockout: false }], freezes: [] });
  }, 120_000);

  it('with lockout, revokes what exists and then refuses every new grant until it is lifted', async () => {
    const tenant = await newTenant();
    await mintGrant(tenant, tenant.agentA, 'user_1');
    // Approved before the stop, exchanged after it.
    const pendingCode = await approvedCode(tenant, tenant.agentA, 'user_2');

    const scope: Scope = { type: 'developer', id: tenant.id };
    const res = await stop(tenant, scope, { lockout: true });
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json<{ stopId: string; freezeId: string; lockout: boolean; status: string; grantsRevoked: number }>();
    expect(result).toMatchObject({ status: 'completed', grantsRevoked: 1, lockout: true });
    expect(result.freezeId).toMatch(/^frz_/);
    expect(await activeGrants(tenant.id)).toBe(0);

    const refusedAuthorize = await authorize(tenant, tenant.agentA, 'user_3');
    expect(refusedAuthorize.statusCode).toBe(403);
    expect(refusedAuthorize.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    const refusedExchange = await exchange(tenant, pendingCode, tenant.agentA);
    expect(refusedExchange.statusCode).toBe(403);
    expect(refusedExchange.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    const refusedBundle = await consentBundle(tenant, tenant.agentA, 'user_4');
    expect(refusedBundle.statusCode).toBe(403);
    expect(refusedBundle.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    // Refused, not consumed: the approved code still works once the freeze is lifted.
    const pending = await sql<{ status: string }[]>`
      SELECT status FROM auth_requests WHERE code = ${pendingCode}`;
    expect(pending[0]!.status).toBe('approved');
    expect(await activeGrants(tenant.id)).toBe(0);

    const listed = await call(tenant, 'GET', '/v1/emergency-stops');
    expect(listed.json()).toMatchObject({
      stops: [{ stopId: result.stopId, lockout: true, status: 'completed' }],
      freezes: [{ freezeId: result.freezeId, scope, stopId: result.stopId, placedBy: 'developer' }],
    });

    const wrongPhrase = await unfreeze(tenant, scope, { confirm: `stop developer:${tenant.id}` });
    expect(wrongPhrase.statusCode).toBe(412);
    expect(wrongPhrase.json()).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });

    const lifted = await unfreeze(tenant, scope);
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(lifted.json()).toMatchObject({
      freezeId: result.freezeId, developerId: tenant.id, scope, stopId: result.stopId,
      clearedBy: expect.stringMatching(new RegExp(`^developer:${tenant.id}@`)),
    });
    expect(lifted.json<{ clearedAt: string }>().clearedAt).toBeTruthy();

    // Issuance is open again.
    const restored = await exchange(tenant, pendingCode, tenant.agentA);
    expect(restored.statusCode, restored.body).toBe(201);
    await mintGrant(tenant, tenant.agentA, 'user_3');
    expect(await activeGrants(tenant.id)).toBe(2);

    // Both the freeze and its lifting are on the audit chain, which still verifies.
    const entries = await verifyChain(tenant.id);
    const frozen = entries.find((entry) => entry['action'] === 'grantex.issuance_frozen');
    const unfrozen = entries.find((entry) => entry['action'] === 'grantex.issuance_unfrozen');
    expect(frozen?.['metadata']).toMatchObject({
      freeze_id: result.freezeId, stop_id: result.stopId, scope_type: 'developer', scope_id: tenant.id,
      placed_by: 'developer', 'grantex:platform': true,
    });
    expect(unfrozen?.['metadata']).toMatchObject({
      freeze_id: result.freezeId, stop_id: result.stopId, scope_type: 'developer', scope_id: tenant.id,
      reason: 'key rotated; incident 4102 closed', 'grantex:platform': true,
    });
    expect(entries.find((entry) => entry['action'] === 'grantex.emergency_stop')?.['metadata'])
      .toMatchObject({ lockout: true, freeze_id: result.freezeId });

    // Nothing left to lift.
    const again = await unfreeze(tenant, scope);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: 'NOT_FROZEN' });
    expect((await call(tenant, 'GET', '/v1/emergency-stops')).json()).toMatchObject({ freezes: [] });
  }, 120_000);

  it('refuses refresh, delegation and passports under a lockout whose sweep did not finish', async () => {
    const tenant = await newTenant();
    const grant = await mintGrant(tenant, tenant.agentA, 'user_1');

    await lockoutWithUnfinishedSweep(tenant, { type: 'developer', id: tenant.id });
    // The stop failed after the freeze was recorded: its row says so, and
    // the grant it never reached is still live.
    const stops = await sql<{ status: string; lockout: boolean }[]>`
      SELECT status, lockout FROM emergency_stops WHERE developer_id = ${tenant.id}`;
    expect(stops.map((row) => ({ status: row.status, lockout: row.lockout })))
      .toEqual([{ status: 'failed', lockout: true }]);
    expect(await activeGrants(tenant.id)).toBe(1);
    const tokensBefore = await sql`SELECT jti FROM grant_tokens WHERE grant_id = ${grant.grantId}`;

    const refreshed = await refresh(tenant, grant.refreshToken, tenant.agentA);
    expect(refreshed.statusCode).toBe(403);
    expect(refreshed.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    const delegated = await delegate(tenant, grant.grantToken);
    expect(delegated.statusCode).toBe(403);
    expect(delegated.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    const issued = await passport(tenant, tenant.agentA, grant.grantId);
    expect(issued.statusCode).toBe(403);
    expect(issued.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });

    // Nothing was issued: no new token, no child grant, and the refresh
    // token is still unused, so lifting the freeze restores it.
    expect(await sql`SELECT jti FROM grant_tokens WHERE grant_id = ${grant.grantId}`).toHaveLength(tokensBefore.length);
    expect(await activeGrants(tenant.id)).toBe(1);
    const refreshRow = await sql<{ is_used: boolean }[]>`SELECT is_used FROM refresh_tokens WHERE id = ${grant.refreshToken}`;
    expect(refreshRow[0]!.is_used).toBe(false);

    const lifted = await unfreeze(tenant, { type: 'developer', id: tenant.id });
    expect(lifted.statusCode, lifted.body).toBe(200);

    expect((await refresh(tenant, grant.refreshToken, tenant.agentA)).statusCode).toBe(201);
    expect((await delegate(tenant, grant.grantToken)).statusCode).toBe(201);
    expect((await passport(tenant, tenant.agentA, grant.grantId)).statusCode).toBe(201);
  }, 120_000);

  it("refuses the OAuth profile's request, code, refresh and token-exchange grants under a lockout", async () => {
    const tenant = await newTenant();
    const first = await oauthCode(tenant);
    const tokens = await oauthExchangeCode(tenant, first.code, first.verifier);
    expect(tokens.statusCode, tokens.body).toBe(200);
    const { access_token: accessToken, refresh_token: refreshToken } =
      tokens.json<{ access_token: string; refresh_token: string }>();
    const pending = await oauthCode(tenant);

    await lockoutWithUnfinishedSweep(tenant, { type: 'agent', id: tenant.oauthAgent });

    const pushed = await par(tenant, pkce().challenge);
    expect(pushed.statusCode).toBe(403);
    expect(pushed.json()).toMatchObject({ error: 'access_denied' });
    const code = await oauthExchangeCode(tenant, pending.code, pending.verifier);
    expect(code.statusCode).toBe(403);
    expect(code.json()).toMatchObject({ error: 'access_denied' });
    const refreshed = await oauthRefresh(tenant, refreshToken);
    expect(refreshed.statusCode).toBe(403);
    expect(refreshed.json()).toMatchObject({ error: 'access_denied' });
    const exchanged = await oauthTokenExchange(tenant, accessToken);
    expect(exchanged.statusCode).toBe(403);
    expect(exchanged.json()).toMatchObject({ error: 'access_denied' });

    const lifted = await unfreeze(tenant, { type: 'agent', id: tenant.oauthAgent });
    expect(lifted.statusCode, lifted.body).toBe(200);

    expect((await oauthExchangeCode(tenant, pending.code, pending.verifier)).statusCode).toBe(200);
    expect((await oauthRefresh(tenant, refreshToken)).statusCode).toBe(200);
    expect((await oauthTokenExchange(tenant, accessToken)).statusCode).toBe(200);
  }, 120_000);

  it('freezes only its own scope, and never another tenant', async () => {
    const tenant = await newTenant();
    const other = await newTenant();

    expect((await stop(tenant, { type: 'agent', id: tenant.agentA }, { lockout: true })).statusCode).toBe(200);
    expect((await authorize(tenant, tenant.agentA, 'user_1')).statusCode).toBe(403);
    expect((await authorize(tenant, tenant.agentB, 'user_1')).statusCode).toBe(201);

    expect((await stop(tenant, { type: 'principal', id: 'user_9' }, { lockout: true })).statusCode).toBe(200);
    expect((await authorize(tenant, tenant.agentB, 'user_9')).statusCode).toBe(403);
    expect((await authorize(tenant, tenant.agentB, 'user_1')).statusCode).toBe(201);

    // A lockout named at another tenant's agent is recorded against the caller
    // and reaches nothing of theirs.
    expect((await stop(tenant, { type: 'agent', id: other.agentA }, { lockout: true })).statusCode).toBe(200);
    expect((await authorize(other, other.agentA, 'user_1')).statusCode).toBe(201);
    // And a developer key cannot freeze, or lift, another developer.
    expect((await stop(tenant, { type: 'developer', id: other.id }, { lockout: true })).statusCode).toBe(403);
    expect((await unfreeze(tenant, { type: 'developer', id: other.id })).statusCode).toBe(403);
    await mintGrant(other, other.agentA, 'user_9');

    // A delegation from an unfrozen agent to a frozen one is refused: the
    // child would be a new grant for the frozen agent.
    const parent = await mintGrant(tenant, tenant.agentB, 'user_1');
    const toFrozen = await call(tenant, 'POST', '/v1/grants/delegate', {
      parentGrantToken: parent.grantToken, subAgentId: tenant.agentA, scopes: [SCOPES[0]], expiresIn: '30m',
    });
    expect(toFrozen.statusCode).toBe(403);
    expect(toFrozen.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
  }, 120_000);

  it('does not let a tenant lift a lockout the operator placed', async () => {
    const tenant = await newTenant();
    const scope: Scope = { type: 'developer', id: tenant.id };

    const placed = await adminStop(tenant, scope, { lockout: true });
    expect(placed.statusCode, placed.body).toBe(200);
    expect(placed.json()).toMatchObject({ lockout: true, developerId: tenant.id });

    const byTenant = await unfreeze(tenant, scope);
    expect(byTenant.statusCode).toBe(403);
    expect(byTenant.json()).toMatchObject({ code: 'FREEZE_HELD_BY_OPERATOR' });
    expect((await authorize(tenant, tenant.agentA, 'user_1')).statusCode).toBe(403);

    const byOperator = await adminUnfreeze(tenant, scope);
    expect(byOperator.statusCode, byOperator.body).toBe(200);
    expect(byOperator.json()).toMatchObject({ clearedBy: expect.stringMatching(/^admin:/) });
    expect((await authorize(tenant, tenant.agentA, 'user_1')).statusCode).toBe(201);

    // A lockout the tenant placed becomes the operator's once the operator
    // stops the same scope with a lockout of its own.
    const agentScope: Scope = { type: 'agent', id: tenant.agentA };
    const tenantPlaced = await stop(tenant, agentScope, { lockout: true });
    const operatorPlaced = await adminStop(tenant, agentScope, { lockout: true, developerId: tenant.id });
    expect(operatorPlaced.statusCode, operatorPlaced.body).toBe(200);
    // The same freeze, reaffirmed rather than stacked.
    expect(operatorPlaced.json<{ freezeId: string }>().freezeId).toBe(tenantPlaced.json<{ freezeId: string }>().freezeId);
    expect((await unfreeze(tenant, agentScope)).statusCode).toBe(403);
    const operatorLift = await adminUnfreeze(tenant, agentScope, { developerId: tenant.id });
    expect(operatorLift.statusCode, operatorLift.body).toBe(200);
    // The operator path names the tenant for any narrower scope.
    expect((await adminUnfreeze(tenant, agentScope)).statusCode).toBe(400);
  }, 120_000);

  it('fails closed when the freeze state cannot be read', async () => {
    const tenant = await newTenant();
    const grant = await mintGrant(tenant, tenant.agentA, 'user_1');
    const pendingCode = await approvedCode(tenant, tenant.agentA, 'user_2');
    const grantsBefore = await sql`SELECT id FROM grants WHERE developer_id = ${tenant.id}`;

    failFreezeReads = true;
    for (const res of [
      await authorize(tenant, tenant.agentA, 'user_3'),
      await exchange(tenant, pendingCode, tenant.agentA),
      await refresh(tenant, grant.refreshToken, tenant.agentA),
      await delegate(tenant, grant.grantToken),
      await consentBundle(tenant, tenant.agentA, 'user_4'),
      await passport(tenant, tenant.agentA, grant.grantId),
    ]) {
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toMatchObject({ code: 'FREEZE_STATE_UNAVAILABLE' });
    }
    const pushed = await par(tenant, pkce().challenge);
    expect(pushed.statusCode).toBe(503);
    expect(pushed.json()).toMatchObject({ error: 'temporarily_unavailable' });
    failFreezeReads = false;

    // Nothing was issued while the state was unreadable.
    expect(await sql`SELECT id FROM grants WHERE developer_id = ${tenant.id}`).toHaveLength(grantsBefore.length);
    const code = await sql<{ status: string }[]>`SELECT status FROM auth_requests WHERE code = ${pendingCode}`;
    expect(code[0]!.status).toBe('approved');
    const refreshRow = await sql<{ is_used: boolean }[]>`SELECT is_used FROM refresh_tokens WHERE id = ${grant.refreshToken}`;
    expect(refreshRow[0]!.is_used).toBe(false);

    // And once it can be read again, issuance carries on.
    expect((await exchange(tenant, pendingCode, tenant.agentA)).statusCode).toBe(201);
  }, 120_000);

  /**
   * Why the freeze takes an advisory lock that every issuance path shares:
   * an exchange that read "not frozen" just before the freeze committed must
   * either be visible to the sweep that follows, or not happen at all. Here
   * the exchanges race a real stop, so some are refused and some land before
   * it; what must hold is that nothing of this developer is live afterwards.
   */
  it('leaves nothing live when exchanges race a stop with lockout', async () => {
    const tenant = await newTenant();
    const codes: string[] = [];
    for (let index = 0; index < 8; index += 1) codes.push(await approvedCode(tenant, tenant.agentA, `user_${index}`));

    const [stopped, ...exchanges] = await Promise.all([
      stop(tenant, { type: 'developer', id: tenant.id }, { lockout: true }),
      ...codes.map((code) => exchange(tenant, code, tenant.agentA)),
    ]);
    expect(stopped!.statusCode, stopped!.body).toBe(200);
    expect(stopped!.json()).toMatchObject({ lockout: true, status: 'completed' });
    for (const res of exchanges) expect([201, 403], res.body).toContain(res.statusCode);
    expect(await activeGrants(tenant.id)).toBe(0);
  }, 120_000);

  /**
   * A passport hangs off a grant that already exists, but it is still
   * something issued: an offline-verifiable credential that outlives the stop
   * unless the sweep sets its status bit. Here the passport has passed its
   * checks and is about to be written when the lockout lands. It is held there
   * until the stop has finished, or until the stop is seen waiting for it,
   * and then let go. Either way nothing of it may still verify afterwards.
   */
  it('leaves no passport live when one is being issued as a lockout lands', async () => {
    const tenant = await newTenant();
    const grant = await mintGrant(tenant, tenant.agentA, 'user_1');

    const { atQuery, release } = holdQuery('INSERT INTO mpp_passports');
    const issuing = passport(tenant, tenant.agentA, grant.grantId);
    expect(await within(atQuery.then(() => true), 30_000, false)).toBe(true);

    const stopping = stop(tenant, { type: 'developer', id: tenant.id }, { lockout: true });
    let settled = false;
    await within(Promise.race([stopping, waitingForFreezeLock(tenant.id, () => settled)]), 30_000, undefined);
    settled = true;
    release();
    const [issued, stopped] = await Promise.all([issuing, stopping]);

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'completed', lockout: true });
    // It had passed its check before the freeze, so it is issued, and then swept.
    expect(issued.statusCode, issued.body).toBe(201);
    const passportId = issued.json<{ passportId: string }>().passportId;

    expect(await activeGrants(tenant.id)).toBe(0);
    const credentials = await sql<{ id: string; status: string; status_list_id: string; status_list_idx: number }[]>`
      SELECT id, status, status_list_id, status_list_idx FROM verifiable_credentials
       WHERE developer_id = ${tenant.id}`;
    const credential = credentials.find((row) => row.id === passportId);
    expect(credential, 'the passport credential was written').toBeDefined();
    expect(credentials.filter((row) => row.status !== 'revoked')).toEqual([]);
    expect(await revocationBitSet(credential!.status_list_id, Number(credential!.status_list_idx))).toBe(true);
    const freezes = await sql`SELECT id FROM issuance_freezes WHERE developer_id = ${tenant.id} AND cleared_at IS NULL`;
    expect(freezes).toHaveLength(1);
  }, 120_000);

  /**
   * The other half of the same window: the passport read its grant as active,
   * and a stop revoked the grant before the passport was written. The grant
   * is read again, locked, in the transaction that writes the passport, so
   * the passport is refused rather than written under a revoked grant that
   * no later sweep would start from.
   */
  it('refuses a passport whose grant a stop revoked while it was being issued', async () => {
    const tenant = await newTenant();
    const grant = await mintGrant(tenant, tenant.agentA, 'user_1');

    // Held after the grant was read, before anything of the passport is written.
    const { atQuery, release } = holdQuery('UPDATE vc_status_lists');
    const issuing = passport(tenant, tenant.agentA, grant.grantId);
    expect(await within(atQuery.then(() => true), 30_000, false)).toBe(true);

    const stopped = await stop(tenant, { type: 'developer', id: tenant.id });
    release();
    const issued = await issuing;

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'completed', grantsRevoked: 1, lockout: false });
    expect(issued.statusCode, issued.body).toBe(400);
    expect(issued.json()).toMatchObject({ code: 'INVALID_GRANT' });
    expect(await sql`SELECT id FROM mpp_passports WHERE developer_id = ${tenant.id}`).toHaveLength(0);
    expect(await sql`
      SELECT id FROM verifiable_credentials WHERE developer_id = ${tenant.id} AND status <> 'revoked'`).toHaveLength(0);
  }, 120_000);

  /**
   * A credential asked for with `credentialFormat: vc-jwt` is issued after
   * the grant's transaction commits (unless portable passkey evidence is on,
   * when it is issued inside it). A lockout that lands in that gap revokes the
   * grant and sweeps its credentials, so a credential written afterwards
   * would stay verifiable, and repeating the stop would never find it: its
   * grant is already revoked. Here the credential is held at its first write
   * while the stop runs, and let go once the stop has finished or is seen
   * waiting for it. Whatever the order, nothing may still verify afterwards.
   */
  for (const route of ['exchange', 'delegation'] as const) {
    it(`leaves no live credential when a lockout lands between the ${route} grant and its credential`, async () => {
      vi.stubEnv('PORTABLE_WEBAUTHN_EVIDENCE_ENABLED', 'false');
      const tenant = await newTenant();
      const parent = route === 'delegation' ? await mintGrant(tenant, tenant.agentA, 'user_1') : undefined;
      const code = route === 'exchange' ? await approvedCode(tenant, tenant.agentA, 'user_1') : undefined;

      // The first write of the credential: its status-list slot.
      const { atQuery, release } = holdQuery('UPDATE vc_status_lists');
      const issuing = route === 'exchange'
        ? call(tenant, 'POST', '/v1/token', { code, agentId: tenant.agentA, credentialFormat: 'vc-jwt' })
        : call(tenant, 'POST', '/v1/grants/delegate', {
          parentGrantToken: parent!.grantToken, subAgentId: tenant.agentB, scopes: [SCOPES[0]], expiresIn: '30m',
          credentialFormat: 'vc-jwt',
        });
      expect(await within(atQuery.then(() => true), 30_000, false)).toBe(true);

      const stopping = stop(tenant, { type: 'developer', id: tenant.id }, { lockout: true });
      let settled = false;
      await within(Promise.race([stopping, waitingForFreezeLock(tenant.id, () => settled)]), 30_000, undefined);
      settled = true;
      release();
      const [issued, stopped] = await Promise.all([issuing, stopping]);

      expect(stopped.statusCode, stopped.body).toBe(200);
      expect(stopped.json()).toMatchObject({ status: 'completed', lockout: true });
      expect([201, 403], issued.body).toContain(issued.statusCode);
      expect(await activeGrants(tenant.id)).toBe(0);

      const credentials = await sql<{ id: string; status: string; status_list_id: string; status_list_idx: number }[]>`
        SELECT id, status, status_list_id, status_list_idx FROM verifiable_credentials
         WHERE developer_id = ${tenant.id}`;
      expect(credentials.filter((row) => row.status !== 'revoked')).toEqual([]);
      for (const row of credentials) {
        expect(await revocationBitSet(row.status_list_id, Number(row.status_list_idx)), row.id).toBe(true);
      }
      if (issued.statusCode === 201 && issued.json<{ verifiableCredential?: string }>().verifiableCredential) {
        expect(credentials, 'the credential handed out was written').toHaveLength(1);
      }
    }, 120_000);
  }

  /**
   * The same gap, with the lockout committed before the credential's turn:
   * the grant is read again, locked, with the freeze, and the credential is
   * refused with the lockout's error rather than written under a grant the
   * stop has already swept.
   */
  it('refuses the credential when a lockout committed after the grant but before its credential', async () => {
    vi.stubEnv('PORTABLE_WEBAUTHN_EVIDENCE_ENABLED', 'false');
    const tenant = await newTenant();
    const code = await approvedCode(tenant, tenant.agentA, 'user_1');

    // The re-read of the grant that opens the credential's transaction.
    const { atQuery, release } = holdQuery('SELECT status FROM grants');
    const issuing = call(tenant, 'POST', '/v1/token', { code, agentId: tenant.agentA, credentialFormat: 'vc-jwt' });
    expect(await within(atQuery.then(() => true), 30_000, false), 'the credential re-reads its grant').toBe(true);

    const stopped = await stop(tenant, { type: 'developer', id: tenant.id }, { lockout: true });
    release();
    const issued = await issuing;

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'completed', grantsRevoked: 1, lockout: true });
    expect(issued.statusCode, issued.body).toBe(403);
    expect(issued.json()).toMatchObject({ code: 'ISSUANCE_FROZEN' });
    expect(await activeGrants(tenant.id)).toBe(0);
    expect(await sql`SELECT id FROM verifiable_credentials WHERE developer_id = ${tenant.id}`).toHaveLength(0);
  }, 120_000);

  /**
   * And with a stop that is only a sweep: nothing is frozen, but the grant is
   * revoked by the time its credential's turn comes, so no credential is
   * written for it. The delegation itself was committed before the stop and
   * is answered as before, without the credential, as when best-effort
   * issuance fails.
   */
  it('writes no credential for a delegated grant a stop revoked before its credential', async () => {
    vi.stubEnv('PORTABLE_WEBAUTHN_EVIDENCE_ENABLED', 'false');
    const tenant = await newTenant();
    const parent = await mintGrant(tenant, tenant.agentA, 'user_1');

    const { atQuery, release } = holdQuery('SELECT status FROM grants');
    const issuing = call(tenant, 'POST', '/v1/grants/delegate', {
      parentGrantToken: parent.grantToken, subAgentId: tenant.agentB, scopes: [SCOPES[0]], expiresIn: '30m',
      credentialFormat: 'vc-jwt',
    });
    expect(await within(atQuery.then(() => true), 30_000, false), 'the credential re-reads its grant').toBe(true);

    const stopped = await stop(tenant, { type: 'developer', id: tenant.id });
    release();
    const issued = await issuing;

    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toMatchObject({ status: 'completed', grantsRevoked: 2, lockout: false });
    expect(issued.statusCode, issued.body).toBe(201);
    expect(issued.json()).not.toHaveProperty('verifiableCredential');
    expect(await activeGrants(tenant.id)).toBe(0);
    expect(await sql`SELECT id FROM verifiable_credentials WHERE developer_id = ${tenant.id}`).toHaveLength(0);
  }, 120_000);

  /**
   * With the emergency stop off, the passport route is the one it always
   * was: the passport and its credential row are separate writes, so a
   * failed credential insert leaves the passport behind. With it on, both are
   * written in the one transaction the lockout needs, so neither is.
   */
  it('keeps the passport writes as they were while the stop is off, and atomic while it is on', async () => {
    const tenant = await newTenant();
    const grant = await mintGrant(tenant, tenant.agentA, 'user_1');

    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'false');
    failCredentialInsertOnce = true;
    const off = await passport(tenant, tenant.agentA, grant.grantId);
    expect(off.statusCode, off.body).toBe(500);
    expect(await sql`SELECT id FROM mpp_passports WHERE developer_id = ${tenant.id}`).toHaveLength(1);
    expect(await sql`SELECT id FROM verifiable_credentials WHERE developer_id = ${tenant.id}`).toHaveLength(0);

    vi.stubEnv('EMERGENCY_STOP_ENABLED', 'true');
    failCredentialInsertOnce = true;
    const on = await passport(tenant, tenant.agentA, grant.grantId);
    expect(on.statusCode, on.body).toBe(500);
    expect(await sql`SELECT id FROM mpp_passports WHERE developer_id = ${tenant.id}`).toHaveLength(1);
    expect(await sql`SELECT id FROM verifiable_credentials WHERE developer_id = ${tenant.id}`).toHaveLength(0);
  }, 120_000);

  /**
   * Every freeze in force is reachable from the list, however many there are:
   * a page at a time, with the total alongside, rather than a silent cap.
   */
  it('pages through every freeze in force, with the total', async () => {
    const tenant = await newTenant();
    const count = 55;
    for (let index = 0; index < count; index += 1) {
      await sql`
        INSERT INTO issuance_freezes (id, developer_id, scope_type, scope_id, placed_by, reason, requested_by, created_at)
        VALUES (${`frz_page_${tenant.id}_${String(index).padStart(3, '0')}`}, ${tenant.id}, 'agent',
                ${`ag_frozen_${String(index).padStart(3, '0')}`}, 'developer', 'incident 4102', 'test',
                ${new Date(Date.UTC(2026, 8, 20, 10, 0, index))})`;
    }
    // A lifted freeze is not in force and is not counted.
    await sql`
      INSERT INTO issuance_freezes
        (id, developer_id, scope_type, scope_id, placed_by, reason, requested_by, cleared_at, cleared_by)
      VALUES (${`frz_page_${tenant.id}_lifted`}, ${tenant.id}, 'agent', 'ag_lifted', 'developer', 'incident', 'test',
              NOW(), 'test')`;

    type Page = { freezes: Array<{ freezeId: string }>; freezesTotal: number; page: number; pageSize: number };
    const first = await call(tenant, 'GET', '/v1/emergency-stops');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<Page>()).toMatchObject({ freezesTotal: count, page: 1, pageSize: 50 });
    expect(first.json<Page>().freezes).toHaveLength(50);
    const second = await call(tenant, 'GET', '/v1/emergency-stops?page=2');
    expect(second.json<Page>()).toMatchObject({ freezesTotal: count, page: 2, pageSize: 50 });
    expect(second.json<Page>().freezes).toHaveLength(count - 50);

    // The two pages together are every freeze in force, oldest first, once each.
    const ids = [...first.json<Page>().freezes, ...second.json<Page>().freezes].map((freeze) => freeze.freezeId);
    const expected = Array.from({ length: count }, (_, index) => `frz_page_${tenant.id}_${String(index).padStart(3, '0')}`);
    expect(ids).toEqual(expected);

    const whole = await call(tenant, 'GET', '/v1/emergency-stops?pageSize=200');
    expect(whole.json<Page>().freezes.map((freeze) => freeze.freezeId)).toEqual(expected);
    const past = await call(tenant, 'GET', '/v1/emergency-stops?page=9');
    expect(past.json<Page>()).toMatchObject({ freezes: [], freezesTotal: count, page: 9 });
    expect((await call(tenant, 'GET', '/v1/emergency-stops?pageSize=201')).statusCode).toBe(400);
  }, 120_000);

  /**
   * The migration on a schema that is at the previous head: every earlier
   * file applied and recorded, stops already in `emergency_stops`. It is
   * built here by applying everything and then taking this file's objects
   * and ledger row away again, then the service's own runner applies it
   * forward.
   */
  it('applies its migration forward onto a database at the previous head', async () => {
    const db = await createTestDatabase('lockout-migrate');
    const target = postgres(db.url, { max: 2, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    try {
      await runMigrations(target);
      await target`DROP TABLE issuance_freezes`;
      await target`ALTER TABLE emergency_stops DROP COLUMN lockout`;
      await target`DELETE FROM schema_migrations WHERE filename = ${MIGRATION}`;
      await target`INSERT INTO developers (id, api_key_hash, name) VALUES ('dev_before', 'hash_before', 'Before')`;
      await target`
        INSERT INTO emergency_stops (id, developer_id, scope_type, scope_id, reason, requested_by, status)
        VALUES ('stop_before', 'dev_before', 'developer', 'dev_before', 'an earlier incident', 'admin', 'completed')`;

      const summary = await runMigrations(target);
      expect(summary.applied).toEqual([MIGRATION]);
      expect(summary.changed).toEqual([]);
      expect(summary.missing).toEqual([]);

      // The stop recorded before the migration reads as what it was: a sweep.
      const before = await target<{ lockout: boolean }[]>`SELECT lockout FROM emergency_stops WHERE id = 'stop_before'`;
      expect(before[0]!.lockout).toBe(false);

      const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', MIGRATION);
      const ledger = await target<{ checksum: string }[]>`SELECT checksum FROM schema_migrations WHERE filename = ${MIGRATION}`;
      expect(ledger[0]!.checksum).toBe(createHash('sha256').update(readFileSync(file, 'utf-8'), 'utf8').digest('hex'));

      // One freeze in force per scope; a cleared one does not count.
      const insert = (id: string) => target`
        INSERT INTO issuance_freezes (id, developer_id, scope_type, scope_id, stop_id, placed_by, reason, requested_by)
        VALUES (${id}, 'dev_before', 'developer', 'dev_before', 'stop_before', 'operator', 'incident', 'admin')`;
      await insert('frz_one');
      await expect(insert('frz_two')).rejects.toThrow();
      await target`UPDATE issuance_freezes SET cleared_at = NOW(), cleared_by = 'admin' WHERE id = 'frz_one'`;
      await insert('frz_two');
      // A cleared freeze names who cleared it; a scope and a placer are one of the known values.
      await expect(target`UPDATE issuance_freezes SET cleared_at = NOW() WHERE id = 'frz_two'`).rejects.toThrow();
      await expect(target`
        INSERT INTO issuance_freezes (id, developer_id, scope_type, scope_id, placed_by, reason, requested_by)
        VALUES ('frz_bad', 'dev_before', 'tenant', 'dev_before', 'operator', 'incident', 'admin')`).rejects.toThrow();
      await expect(target`
        INSERT INTO issuance_freezes (id, developer_id, scope_type, scope_id, placed_by, reason, requested_by)
        VALUES ('frz_bad', 'dev_before', 'agent', 'ag_x', 'someone', 'incident', 'admin')`).rejects.toThrow();

      // A second start applies nothing.
      const again = await runMigrations(target);
      expect(again.applied).toEqual([]);
    } finally {
      await target.end({ timeout: 5 }).catch(() => undefined);
      await db.drop();
    }
  }, 180_000);
});

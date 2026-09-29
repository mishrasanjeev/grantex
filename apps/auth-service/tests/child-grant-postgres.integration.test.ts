// SPDX-License-Identifier: Apache-2.0
/**
 * Per-merchant child grants (spec/passport-binding.md §8) against real
 * Postgres, through the routes, with the mock accredited issuer
 * (packages/mock-issuer).
 *
 * The parent is a passport-bound grant whose authorization request named its
 * merchants in a urn:grantex:commerce:v1 authorization_details entry (owner
 * decision 3). POST /v1/token with the RFC 8693 token-exchange grant type
 * turns the parent's grant token into a child for one of them.
 *
 * Covered: migration 126; the allowed_merchants recorded at authorization
 * and carried by the parent's token; the happy path; aud outside
 * allowed_merchants; the lifetime caps (900 s, the parent, the passport, the
 * attestation); attenuation and widening; cnf and binding inherited; the
 * binding checked again (issuer list flipped, acceptance suspended); the
 * parent revoked, by grant and by token, cascading to its children; the
 * budget recorded against the parent grant; delegation of a bound grant
 * refused; parallel exchanges; the proof of the bound key (RFC 9449) the
 * exchange requires; the metrics; the constraints on the consent view; and
 * the flag off.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { tokenExchangeDuration, tokenExchangeTotal } from '../src/lib/metrics.js';
import { hashApiKey } from '../src/lib/hash.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { setAcceptance } from '../src/lib/registry/acceptance-status.js';
import { REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV } from '../src/lib/registry/issuer-fetcher.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { COMMERCE_DETAIL_TYPE } from '../src/lib/registry/passport-binding.js';
import { buildTestApp, mockRedis, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';
import {
  loadMockIssuer,
  type MockIssuer,
  type MockIssuerModule,
  type MockIssuerServer,
} from './helpers/workspace-packages.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres child grant tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const RAIL = 'https://merchant.example/checkout';
const MERCHANT = 'https://merchant.example';
const OTHER_MERCHANT = 'https://shop.merchant.example';
const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
const FLAG = 'PASSPORT_BOUND_GRANTS_ENABLED';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const PARENT_LIMITS = {
  allowed_merchants: [MERCHANT, OTHER_MERCHANT],
  amount_range: { currency: 'EUR', max: '250.00' },
  budget: { amount: '500.00', currency: 'EUR' },
};

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; privateJwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string }
interface Agent { id: string; did: string; key: Key; tenant: Tenant }
interface Parent {
  agent: Agent;
  passport: { attestationId: string };
  attestation: Record<string, unknown>;
  grantToken: string;
  grantId: string;
}

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let mock: MockIssuerModule;
let mockIssuer: MockIssuer;
let mockServer: MockIssuerServer;
const operatorKey = randomBytes(32).toString('hex');
let addressCounter = 0;

function nextAddress(): string {
  addressCounter += 1;
  return `198.51.100.${(addressCounter % 250) + 1}`;
}

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  return { privateKey, jwk, privateJwk, thumbprint: jwkThumbprint(jwk) };
}

async function newTenant(): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_cg_${suffix}`, apiKey: `gx_test_cg_${suffix}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Child Grant Test', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url, remoteAddress: nextAddress(), headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function addAndProveKey(tenant: Tenant, agentId: string, key: Key): Promise<void> {
  const added = await call(tenant, 'POST', `/v1/agents/${agentId}/keys`, { publicJwk: key.jwk });
  expect(added.statusCode, added.body).toBe(201);
  const issued = await call(tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/challenge`);
  expect(issued.statusCode, issued.body).toBe(201);
  const proof = await new SignJWT({ nonce: issued.json<{ challenge: string }>().challenge, sub: agentId })
    .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(AUDIENCE).setIssuedAt().sign(key.privateKey);
  const proved = await call(tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/prove`, { proof });
  expect(proved.statusCode, proved.body).toBe(200);
}

async function newAgent(tenant?: Tenant): Promise<Agent> {
  const owner = tenant ?? await newTenant();
  const created = await call(owner, 'POST', '/v1/agents', {
    name: 'Nimbus Shopper 2.4',
    scopes: ['read', 'write'],
    resourceServers: [RAIL],
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ agentId: string }>().agentId;
  const [row] = await sql`SELECT did FROM agents WHERE id = ${id}`;
  const key = await newKey();
  await addAndProveKey(owner, id, key);
  return { id, did: row!['did'] as string, key, tenant: owner };
}

function mockPassport(agent: Agent) {
  const challenge = mockIssuer.createPossessionChallenge({ agentDid: agent.did, agentPublicJwk: agent.key.jwk });
  const possessionProof = mock.signPossessionProof({ challenge, agentPrivateJwk: agent.key.privateJwk });
  return mockIssuer.issuePassport({
    agentDid: agent.did,
    agentPublicJwk: agent.key.jwk,
    possessionProof,
    provider: { did: 'did:web:provider.example' },
    agent: { software_name: 'Nimbus Shopper', software_version: '2.4' },
    verification: { level: 'substantial' },
  });
}

async function postAttestation(compact: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST', url: '/v1/registry/attestations', payload: compact,
    headers: { 'content-type': 'application/grantex-attestation+jwt' }, remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Record<string, unknown>>();
}

async function authorize(agent: Agent, passport: string | undefined, extra: Record<string, unknown> = {}) {
  return call(agent.tenant, 'POST', '/v1/authorize', {
    agentId: agent.id,
    principalId: 'user_shopper',
    scopes: ['read', 'write'],
    audience: RAIL,
    ...(passport !== undefined ? { passport } : {}),
    ...extra,
  });
}

function commerceEntry(limits: Record<string, unknown>) {
  return [{ type: COMMERCE_DETAIL_TYPE, ...limits }];
}

/** A passport-bound parent grant, from the mock issuer, with the given commerce limits. */
async function parentGrant(options: { limits?: Record<string, unknown> | null; expiresIn?: string } = {}): Promise<Parent> {
  const agent = await newAgent();
  const passport = mockPassport(agent);
  const attestation = await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
  const limits = options.limits === undefined ? PARENT_LIMITS : options.limits;
  const authorized = await authorize(agent, passport.compact, {
    ...(limits !== null ? { authorization_details: commerceEntry(limits) } : {}),
    ...(options.expiresIn ? { expiresIn: options.expiresIn } : {}),
  });
  expect(authorized.statusCode, authorized.body).toBe(201);
  const exchanged = await call(agent.tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId: agent.id });
  expect(exchanged.statusCode, exchanged.body).toBe(201);
  const { grantToken, grantId } = exchanged.json<{ grantToken: string; grantId: string }>();
  return { agent, passport, attestation, grantToken, grantId };
}

const TOKEN_ENDPOINT = () => `${config.publicBaseUrl.replace(/\/$/, '')}/v1/token`;

/** A DPoP proof (RFC 9449 §4.2) for POST /v1/token, signed with the key. */
async function dpopProof(key: Key, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    htm: 'POST',
    htu: TOKEN_ENDPOINT(),
    jti: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  }).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk }).sign(key.privateKey);
}

/**
 * The exchange, with a fresh DPoP proof of the parent's key unless `proof`
 * gives one (a string) or none (null).
 */
async function childExchange(
  parent: Parent,
  params: Record<string, string | string[]> = {},
  form = true,
  proof?: string | null,
) {
  const dpop = proof === undefined ? await dpopProof(parent.agent.key) : proof;
  const headers: Record<string, string> = {
    authorization: `Bearer ${parent.agent.tenant.apiKey}`,
    ...(dpop !== null ? { dpop } : {}),
  };
  const body: Record<string, string | string[]> = {
    grant_type: TOKEN_EXCHANGE,
    subject_token: parent.grantToken,
    subject_token_type: ACCESS_TOKEN,
    resource: MERCHANT,
    ...params,
  };
  if (!form) return app.inject({ method: 'POST', url: '/v1/token', remoteAddress: nextAddress(), headers, payload: body });
  const encoded = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) encoded.append(name, item);
  }
  return app.inject({
    method: 'POST', url: '/v1/token', remoteAddress: nextAddress(),
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: encoded.toString(),
  });
}

function commerceDetail(token: string): Record<string, unknown> | undefined {
  const details = decodeJwt(token)['authorization_details'] as Array<Record<string, unknown>> | undefined;
  return details?.find((entry) => entry['type'] === COMMERCE_DETAIL_TYPE);
}

async function expectRefused(res: { statusCode: number; body: string; json: <T>() => T }, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json<Record<string, unknown>>()['code'], res.body).toBe(code);
}

async function childCount(grantId: string): Promise<number> {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM grant_child_tokens WHERE grant_id = ${grantId}`;
  return row!['n'] as number;
}

async function makeStale(attestation: Record<string, unknown>): Promise<void> {
  await sql`UPDATE registry_attestations SET issuer_status_fresh_until = NOW() - INTERVAL '1 second'
            WHERE id = ${attestation['id'] as string}`;
}

async function verify(tenant: Tenant, token: string) {
  const res = await call(tenant, 'POST', '/v1/grants/verify', { token });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ active: boolean; reason?: string }>();
}

function forwardSqlMock(): void {
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('child_grant');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 20, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  mock = await loadMockIssuer();
  mockIssuer = mock.MockIssuer.create();
  mockServer = await mock.startMockIssuerServer({ issuer: mockIssuer });
  app = await buildTestApp();
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  forwardSqlMock();
  const res = await app.inject({
    method: 'POST', url: '/v1/registry/issuers', headers: { authorization: `Bearer ${operatorKey}` }, remoteAddress: nextAddress(),
    payload: {
      entity_id: mockIssuer.entityId,
      jwks: mockIssuer.jwks(),
      trust_marks: [AGENT_IDENTITY, PROVIDER_ENTITY],
      status_list_base: mockIssuer.statusListBase,
      accreditation_evidence_ref: 'accreditation-case-mock-issuer',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  vi.unstubAllEnvs();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await mockServer?.close();
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  if (!adminDatabaseUrl) return;
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, mockServer.originMapEntry);
  vi.stubEnv(FLAG, 'true');
  forwardSqlMock();
  // The DPoP jti store (RFC 9449 §11.1): SET NX answers OK once per key.
  const seen = new Set<string>();
  mockRedis.set.mockImplementation(async (key: string, ...args: unknown[]) => {
    if (!args.includes('NX')) return 'OK';
    if (seen.has(key)) return null;
    seen.add(key);
    return 'OK';
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('migration 126', () => {
  it('is recorded in the ledger and adds the child grant table and the parent constraints', async () => {
    const ledger = await sql`SELECT filename FROM schema_migrations WHERE filename = '126_passport_child_grants.sql'`;
    expect(ledger).toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('grant_passport_bindings', 'grant_child_tokens')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('grant_passport_bindings')).toContain('commerce_constraints');
    expect(names('grant_child_tokens')).toEqual(expect.arrayContaining([
      'jti', 'grant_id', 'developer_id', 'parent_jti', 'merchant_origin', 'constraints', 'expires_at', 'created_at',
    ]));
    const indexes = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'grant_child_tokens'`;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'idx_grant_child_tokens_parent_jti', 'idx_grant_child_tokens_grant',
    ]));
  });
});

describePostgres('allowed_merchants at authorization (decision 3)', () => {
  it('records the commerce entry and carries it in the parent token, after the binding', async () => {
    const parent = await parentGrant();
    const detail = commerceDetail(parent.grantToken)!;
    expect(detail['allowed_merchants']).toEqual([MERCHANT, OTHER_MERCHANT]);
    expect(detail['amount_range']).toEqual({ currency: 'EUR', max: '250.00' });
    expect(detail['budget']).toEqual({ amount: '500.00', currency: 'EUR' });
    expect(Object.keys(detail)).toEqual(['type', 'passport', 'acceptance_status', 'allowed_merchants', 'amount_range', 'budget']);
    const [row] = await sql`SELECT commerce_constraints FROM grant_passport_bindings WHERE grant_id = ${parent.grantId}`;
    expect(row!['commerce_constraints']).toEqual(PARENT_LIMITS);
    // grants.authorization_details still holds only the other entry types.
    const [grant] = await sql`SELECT authorization_details FROM grants WHERE id = ${parent.grantId}`;
    expect(grant!['authorization_details']).toBeNull();
  });

  it('keeps them through a refresh', async () => {
    const agent = await newAgent();
    const passport = mockPassport(agent);
    await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
    const authorized = await authorize(agent, passport.compact, { authorization_details: commerceEntry(PARENT_LIMITS) });
    const exchanged = await call(agent.tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId: agent.id });
    const first = exchanged.json<{ grantToken: string; refreshToken: string }>();
    const refreshed = await call(agent.tenant, 'POST', '/v1/token/refresh', { refreshToken: first.refreshToken, agentId: agent.id });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    expect(commerceDetail(refreshed.json<{ grantToken: string }>().grantToken)).toEqual(commerceDetail(first.grantToken));
  });

  it('refuses malformed commerce details with invalid_authorization_details and records nothing', async () => {
    const agent = await newAgent();
    const passport = mockPassport(agent);
    await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
    for (const details of [
      commerceEntry({ allowed_merchants: ['https://merchant.example/checkout'] }),
      [{ type: 'urn:grantex:tools:v1', connector: 'checkout' }],
      commerceEntry({ allowed_merchants: [MERCHANT], extra: 1 }),
    ]) {
      const res = await authorize(agent, passport.compact, { authorization_details: details });
      await expectRefused(res, 400, 'invalid_authorization_details');
    }
    // Without a passport there is no binding to carry the entry: refused, not dropped.
    await expectRefused(await authorize(agent, undefined, { authorization_details: commerceEntry({ allowed_merchants: [MERCHANT] }) }),
      400, 'invalid_authorization_details');
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM auth_requests WHERE agent_id = ${agent.id}`;
    expect(row!['n']).toBe(0);
  });
});

describePostgres('POST /v1/token with the token-exchange grant type (RFC 8693)', () => {
  it('issues a child for one merchant: aud, cnf, binding, act, parent_jti, fresh jti, 900 s', async () => {
    const parent = await parentGrant();
    const parentClaims = decodeJwt(parent.grantToken);
    const before = Math.floor(Date.now() / 1000);
    const res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ issued_token_type: ACCESS_TOKEN, token_type: 'DPoP', scope: 'read write' });
    expect(body['refresh_token']).toBeUndefined();
    const child = decodeJwt(body['access_token'] as string);

    expect(child['aud']).toBe(MERCHANT);
    expect(child['cnf']).toEqual({ jkt: parent.agent.key.thumbprint });
    expect(child['cnf']).toEqual(parentClaims['cnf']);
    expect(child['sub']).toBe(parentClaims['sub']);
    expect(child['jti']).not.toBe(parentClaims['jti']);
    expect(child['act']).toEqual(parentClaims['act']);
    const grant = child['urn:grantex:grant'] as Record<string, unknown>;
    expect(grant['grant_id']).toBe(parent.grantId);
    expect(grant['parent_jti']).toBe(parentClaims['jti']);
    expect(grant['agent_did']).toBe(parent.agent.did);

    const parentDetail = commerceDetail(parent.grantToken)!;
    expect(commerceDetail(body['access_token'] as string)).toEqual({
      type: COMMERCE_DETAIL_TYPE,
      passport: parentDetail['passport'],
      acceptance_status: parentDetail['acceptance_status'],
      allowed_merchants: [MERCHANT],
      amount_range: { currency: 'EUR', max: '250.00' },
      budget: { amount: '500.00', currency: 'EUR' },
    });

    const exp = child['exp'] as number;
    expect(exp).toBeGreaterThanOrEqual(before + 900 - 1);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
    expect(body['expires_in']).toBeLessThanOrEqual(900);

    const [row] = await sql`SELECT * FROM grant_child_tokens WHERE jti = ${child['jti'] as string}`;
    expect(row).toMatchObject({
      grant_id: parent.grantId,
      developer_id: parent.agent.tenant.id,
      parent_jti: parentClaims['jti'],
      merchant_origin: MERCHANT,
    });
    const [token] = await sql`SELECT grant_id, is_revoked FROM grant_tokens WHERE jti = ${child['jti'] as string}`;
    expect(token).toEqual({ grant_id: parent.grantId, is_revoked: false });
    expect(await verify(parent.agent.tenant, body['access_token'] as string)).toMatchObject({ active: true });
  });

  it('takes the merchant from audience as well, and a JSON body', async () => {
    const parent = await parentGrant();
    const res = await childExchange(parent, { resource: [], audience: OTHER_MERCHANT }, false);
    expect(res.statusCode, res.body).toBe(200);
    expect(decodeJwt(res.json<{ access_token: string }>().access_token)['aud']).toBe(OTHER_MERCHANT);
  });

  it('refuses a merchant outside allowed_merchants with audience_mismatch', async () => {
    const parent = await parentGrant();
    await expectRefused(await childExchange(parent, { resource: 'https://elsewhere.example' }), 400, 'audience_mismatch');
    const noMerchants = await parentGrant({ limits: null });
    await expectRefused(await childExchange(noMerchants), 400, 'audience_mismatch');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('caps the lifetime at the parent grant', async () => {
    const parent = await parentGrant({ expiresIn: '5m' });
    const res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(200);
    expect(decodeJwt(res.json<{ access_token: string }>().access_token)['exp']).toBe(decodeJwt(parent.grantToken)['exp']);
  });

  it('caps the lifetime at the passport exp and at the attestation exp', async () => {
    const parent = await parentGrant();
    const passportExp = Math.floor(Date.now() / 1000) + 300;
    await sql`UPDATE grant_passport_bindings SET passport_expires_at = to_timestamp(${passportExp}) WHERE grant_id = ${parent.grantId}`;
    let res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(200);
    expect(decodeJwt(res.json<{ access_token: string }>().access_token)['exp']).toBe(passportExp);

    const attestationExp = Math.floor(Date.now() / 1000) + 200;
    await sql`UPDATE registry_attestations SET exp = to_timestamp(${attestationExp}) WHERE id = ${parent.attestation['id'] as string}`;
    res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(200);
    expect(decodeJwt(res.json<{ access_token: string }>().access_token)['exp']).toBe(attestationExp);
  });

  it('attenuates the constraints the request narrows, and the scope', async () => {
    const parent = await parentGrant();
    const res = await childExchange(parent, {
      scope: 'read',
      authorization_details: JSON.stringify(commerceEntry({
        allowed_merchants: [MERCHANT],
        amount_range: { currency: 'EUR', max: '20.00' },
        budget: { amount: '40.00', currency: 'EUR' },
      })),
    });
    expect(res.statusCode, res.body).toBe(200);
    const token = res.json<{ access_token: string; scope: string }>();
    expect(token.scope).toBe('read');
    expect(decodeJwt(token.access_token)['scope']).toBe('read');
    expect(commerceDetail(token.access_token)).toMatchObject({
      allowed_merchants: [MERCHANT],
      amount_range: { currency: 'EUR', max: '20.00' },
      budget: { amount: '40.00', currency: 'EUR' },
    });
  });

  it('refuses a wider request with invalid_authorization_details or invalid_scope, and writes nothing', async () => {
    const parent = await parentGrant();
    for (const limits of [
      { allowed_merchants: [MERCHANT, OTHER_MERCHANT] },
      { amount_range: { currency: 'EUR', max: '250.01' } },
      { budget: { amount: '1000.00', currency: 'EUR' } },
    ]) {
      await expectRefused(await childExchange(parent, { authorization_details: JSON.stringify(commerceEntry(limits)) }),
        400, 'invalid_authorization_details');
    }
    await expectRefused(await childExchange(parent, { scope: 'read admin' }), 400, 'invalid_scope');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('refuses a subject that is not a passport-bound parent, or is itself a child', async () => {
    const agent = await newAgent();
    const authorized = await authorize(agent, undefined);
    const unbound = await call(agent.tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId: agent.id });
    const unboundParent: Parent = {
      agent, passport: { attestationId: '' }, attestation: {},
      grantToken: unbound.json<{ grantToken: string }>().grantToken, grantId: unbound.json<{ grantId: string }>().grantId,
    };
    await expectRefused(await childExchange(unboundParent), 400, 'invalid_request');

    const parent = await parentGrant();
    const child = (await childExchange(parent)).json<{ access_token: string }>().access_token;
    await expectRefused(await childExchange({ ...parent, grantToken: child }), 400, 'invalid_request');
    // Another developer's parent is not a subject token here.
    const stranger = await newTenant();
    const res = await app.inject({
      method: 'POST', url: '/v1/token', remoteAddress: nextAddress(),
      headers: { authorization: `Bearer ${stranger.apiKey}`, dpop: await dpopProof(parent.agent.key) },
      payload: { grant_type: TOKEN_EXCHANGE, subject_token: parent.grantToken, subject_token_type: ACCESS_TOKEN, resource: MERCHANT },
    });
    await expectRefused(res, 400, 'invalid_request');
  });
});

describePostgres('proof of the bound key (RFC 9449)', () => {
  async function expectProofRefused(res: Awaited<ReturnType<typeof childExchange>>, reason: string) {
    expect(res.statusCode, res.body).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<Record<string, unknown>>()).toMatchObject({ error: 'invalid_dpop_proof', code: 'invalid_dpop_proof', reason });
  }

  it('issues a child for a fresh proof signed with the parent\'s cnf.jkt key', async () => {
    const parent = await parentGrant();
    const proof = await dpopProof(parent.agent.key);
    const res = await childExchange(parent, {}, true, proof);
    expect(res.statusCode, res.body).toBe(200);
    expect(decodeJwt(res.json<{ access_token: string }>().access_token)['cnf']).toEqual({ jkt: parent.agent.key.thumbprint });
    expect(await childCount(parent.grantId)).toBe(1);
  });

  it('refuses an exchange without a proof, and writes nothing', async () => {
    const parent = await parentGrant();
    await expectProofRefused(await childExchange(parent, {}, true, null), 'dpop_proof_missing');
    await expectProofRefused(await childExchange(parent, {}, false, null), 'dpop_proof_missing');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('refuses a proof signed with another key: the developer credential and a copied parent token are not enough', async () => {
    const parent = await parentGrant();
    const stranger = await newKey();
    await expectProofRefused(await childExchange(parent, {}, true, await dpopProof(stranger)), 'dpop_key_mismatch');
    // Another agent's proven key of the same developer is refused as well.
    const sibling = await newAgent(parent.agent.tenant);
    await expectProofRefused(await childExchange(parent, {}, true, await dpopProof(sibling.key)), 'dpop_key_mismatch');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('refuses a replayed proof', async () => {
    const parent = await parentGrant();
    const proof = await dpopProof(parent.agent.key);
    const first = await childExchange(parent, {}, true, proof);
    expect(first.statusCode, first.body).toBe(200);
    await expectProofRefused(await childExchange(parent, { resource: OTHER_MERCHANT }, true, proof), 'dpop_proof_replayed');
    expect(await childCount(parent.grantId)).toBe(1);
  });

  it('refuses a proof for another method or another URI, or a stale one', async () => {
    const parent = await parentGrant();
    for (const [claims, reason] of [
      [{ htm: 'GET' }, 'dpop_htm_mismatch'],
      [{ htu: TOKEN_ENDPOINT().replace(/\/v1\/token$/, '/oauth/token') }, 'dpop_htu_mismatch'],
      [{ htu: 'https://elsewhere.example/v1/token' }, 'dpop_htu_mismatch'],
      [{ iat: Math.floor(Date.now() / 1000) - 3600 }, 'dpop_proof_stale'],
    ] as const) {
      await expectProofRefused(await childExchange(parent, {}, true, await dpopProof(parent.agent.key, claims)), reason);
    }
    expect(await childCount(parent.grantId)).toBe(0);
  });
});

describePostgres('token exchange metrics', () => {
  it('counts a child exchange as a success and times it', async () => {
    const parent = await parentGrant();
    // prom-client is mocked (tests/setup.ts): inc and the timer are spies.
    const endTimer = vi.fn();
    vi.mocked(tokenExchangeDuration.startTimer).mockReturnValueOnce(endTimer as never);
    vi.mocked(tokenExchangeTotal.inc).mockClear();
    const res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(200);
    // The mocked counters share one inc: keep the calls with a status label.
    expect(statusCalls()).toEqual([{ status: 'success' }]);
    expect(endTimer).toHaveBeenCalledTimes(1);
  });

  it('counts a refused child exchange as failed and times it', async () => {
    const parent = await parentGrant();
    const endTimer = vi.fn();
    vi.mocked(tokenExchangeDuration.startTimer).mockReturnValueOnce(endTimer as never);
    vi.mocked(tokenExchangeTotal.inc).mockClear();
    await expectRefused(await childExchange(parent, { resource: 'https://elsewhere.example' }), 400, 'audience_mismatch');
    // The mocked counters share one inc: keep the calls with a status label.
    expect(statusCalls()).toEqual([{ status: 'failed' }]);
    expect(endTimer).toHaveBeenCalledTimes(1);
  });
});

describePostgres('the constraints on the consent view (§6)', () => {
  it('GET /v1/consent/{id} shows allowed_merchants, amount_range and budget before the decision', async () => {
    const agent = await newAgent();
    // A live developer: its requests wait for the Principal's consent.
    await sql`UPDATE developers SET mode = 'live' WHERE id = ${agent.tenant.id}`;
    const passport = mockPassport(agent);
    await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
    const authorized = await authorize(agent, passport.compact, { authorization_details: commerceEntry(PARENT_LIMITS) });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const { authRequestId } = authorized.json<{ authRequestId: string }>();
    const consent = await app.inject({ method: 'GET', url: `/v1/consent/${authRequestId}`, remoteAddress: nextAddress() });
    expect(consent.statusCode, consent.body).toBe(200);
    const view = consent.json<Record<string, unknown>>();
    expect(view['agentPassport']).toBeDefined();
    expect(view['commerceConstraints']).toEqual({
      allowedMerchants: [MERCHANT, OTHER_MERCHANT],
      amountRange: { currency: 'EUR', max: '250.00' },
      budget: { amount: '500.00', currency: 'EUR' },
    });

    const none = await authorize(agent, passport.compact);
    expect(none.statusCode, none.body).toBe(201);
    const noneView = await app.inject({
      method: 'GET', url: `/v1/consent/${none.json<{ authRequestId: string }>().authRequestId}`, remoteAddress: nextAddress(),
    });
    expect(noneView.statusCode, noneView.body).toBe(200);
    expect(noneView.json<Record<string, unknown>>()).not.toHaveProperty('commerceConstraints');

    vi.stubEnv(FLAG, 'false');
    const off = await app.inject({ method: 'GET', url: `/v1/consent/${authRequestId}`, remoteAddress: nextAddress() });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<Record<string, unknown>>()).not.toHaveProperty('commerceConstraints');
  });
});

describePostgres('the binding is checked again at every exchange', () => {
  it('passport_revoked: the issuer revoked the passport (its list flipped, read again)', async () => {
    const parent = await parentGrant();
    mockIssuer.revokePassport(parent.passport.attestationId);
    await makeStale(parent.attestation);
    await expectRefused(await childExchange(parent), 400, 'passport_revoked');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('passport_revoked: the registry suspended its acceptance', async () => {
    const parent = await parentGrant();
    const acceptance = (parent.attestation['acceptance'] as { status_list: { uri: string; idx: number } }).status_list;
    await setAcceptance(acceptance.uri, acceptance.idx, 'suspended');
    await expectRefused(await childExchange(parent), 400, 'passport_revoked');
  });

  it('status_stale: the recorded read is stale and the issuer list cannot be read (503, not a refusal)', async () => {
    const parent = await parentGrant();
    vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, `${mockIssuer.entityId}=http://127.0.0.1:9`);
    await makeStale(parent.attestation);
    const res = await childExchange(parent);
    await expectRefused(res, 503, 'status_stale');
    expect(res.json<Record<string, unknown>>()['error']).toBe('invalid_request');
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('passport_expired: the passport exp has passed', async () => {
    const parent = await parentGrant();
    await sql`UPDATE grant_passport_bindings SET passport_expires_at = NOW() - INTERVAL '1 second' WHERE grant_id = ${parent.grantId}`;
    await expectRefused(await childExchange(parent), 400, 'passport_expired');
  });

  it('key_not_active: the key was reported compromised', async () => {
    const parent = await parentGrant();
    await sql`UPDATE agent_keys SET status = 'compromised', valid_to = NOW() WHERE thumbprint = ${parent.agent.key.thumbprint}`;
    const res = await childExchange(parent);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<Record<string, unknown>>()['error']).toBe('invalid_request');
    expect(['key_not_active', 'key_unproven']).toContain(res.json<{ code: string }>().code);
  });
});

describePostgres('revoking the parent', () => {
  it('refuses new exchanges and revokes existing children (grant cascade)', async () => {
    const parent = await parentGrant();
    const child = (await childExchange(parent)).json<{ access_token: string }>().access_token;
    const revoked = await call(parent.agent.tenant, 'DELETE', `/v1/grants/${parent.grantId}`);
    expect(revoked.statusCode, revoked.body).toBe(204);
    await expectRefused(await childExchange(parent), 400, 'invalid_request');
    expect(await verify(parent.agent.tenant, child)).toMatchObject({ active: false, reason: 'revoked' });
  });

  it('revoking the parent token revokes the children exchanged from it', async () => {
    const parent = await parentGrant();
    const children = [];
    for (const merchant of [MERCHANT, OTHER_MERCHANT]) {
      children.push((await childExchange(parent, { resource: merchant })).json<{ access_token: string }>().access_token);
    }
    const res = await call(parent.agent.tenant, 'POST', '/v1/tokens/revoke', { jti: decodeJwt(parent.grantToken)['jti'] as string });
    expect(res.statusCode, res.body).toBe(204);
    for (const child of children) expect(await verify(parent.agent.tenant, child)).toMatchObject({ active: false, reason: 'revoked' });
    const rows = await sql`SELECT is_revoked FROM grant_tokens WHERE jti IN (SELECT jti FROM grant_child_tokens WHERE grant_id = ${parent.grantId})`;
    expect(rows.map((row) => row['is_revoked'])).toEqual([true, true]);
  });

  it('revoking the parent token revokes a child exchanged while the revocation waited', async () => {
    const parent = await parentGrant();
    const parentJti = decodeJwt(parent.grantToken)['jti'] as string;
    const waiting = async (count: number) => {
      for (let i = 0; i < 200; i += 1) {
        const [row] = await sql`SELECT COUNT(*)::int AS n FROM pg_stat_activity
                                WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if ((row!['n'] as number) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${count} sessions waiting on a lock`);
    };

    // Hold the exchange inside its transaction, after its FOR SHARE on the
    // parent token: its insert into grant_child_tokens waits on this lock.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = sql.begin(async (tx) => {
      await tx`LOCK TABLE grant_child_tokens IN SHARE MODE`;
      locked();
      await released;
    });
    await lockTaken;
    const exchange = childExchange(parent);
    await waiting(1);
    // The revocation waits on the exchange's row lock on the parent token.
    const revoke = call(parent.agent.tenant, 'POST', '/v1/tokens/revoke', { jti: parentJti });
    await waiting(2);
    release();
    await holder;

    const exchanged = await exchange;
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const revoked = await revoke;
    expect(revoked.statusCode, revoked.body).toBe(204);
    const child = exchanged.json<{ access_token: string }>().access_token;
    const [row] = await sql`SELECT is_revoked FROM grant_tokens WHERE jti = ${decodeJwt(child)['jti'] as string}`;
    expect(row).toEqual({ is_revoked: true });
    expect(await verify(parent.agent.tenant, child)).toMatchObject({ active: false, reason: 'revoked' });
  });
});

describePostgres('the budget is the parent grant\'s', () => {
  it('a debit made with the child\'s grant_id lands on the parent allocation', async () => {
    const parent = await parentGrant();
    const allocated = await call(parent.agent.tenant, 'POST', '/v1/budget/allocate', { grantId: parent.grantId, initialBudget: 100, currency: 'EUR' });
    expect(allocated.statusCode, allocated.body).toBe(201);
    const child = decodeJwt((await childExchange(parent)).json<{ access_token: string }>().access_token);
    const childGrantId = (child['urn:grantex:grant'] as Record<string, unknown>)['grant_id'] as string;
    const debited = await call(parent.agent.tenant, 'POST', '/v1/budget/debit', { grantId: childGrantId, amount: 30 });
    expect(debited.statusCode, debited.body).toBeLessThan(300);
    const [allocation] = await sql`SELECT remaining_budget FROM budget_allocations WHERE grant_id = ${parent.grantId}`;
    expect(Number(allocation!['remaining_budget'])).toBe(70);
    expect(await sql`SELECT 1 FROM budget_allocations WHERE grant_id <> ${parent.grantId} AND developer_id = ${parent.agent.tenant.id}`).toHaveLength(0);
  });
});

describePostgres('sub-agents (§8.6)', () => {
  it('refuses delegation of a passport-bound grant or its child', async () => {
    const parent = await parentGrant();
    const subAgent = await newAgent(parent.agent.tenant);
    const child = (await childExchange(parent)).json<{ access_token: string }>().access_token;
    for (const token of [parent.grantToken, child]) {
      const res = await call(parent.agent.tenant, 'POST', '/v1/grants/delegate', {
        parentGrantToken: token, subAgentId: subAgent.id, scopes: ['read'],
      });
      await expectRefused(res, 403, 'PASSPORT_BOUND_DELEGATION_UNSUPPORTED');
    }
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM grants WHERE parent_grant_id = ${parent.grantId}`;
    expect(row!['n']).toBe(0);
  });
});

describePostgres('parallel exchanges for one parent', () => {
  it('each gets a distinct jti and none widens', async () => {
    const parent = await parentGrant();
    const requests = Array.from({ length: 8 }, (_, i) => childExchange(parent, {
      resource: i % 2 === 0 ? MERCHANT : OTHER_MERCHANT,
      authorization_details: JSON.stringify(commerceEntry({ amount_range: { currency: 'EUR', max: `${10 + i}.00` } })),
    }));
    const responses = await Promise.all(requests);
    const tokens = responses.map((res) => {
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ access_token: string }>().access_token;
    });
    const jtis = tokens.map((token) => decodeJwt(token)['jti']);
    expect(new Set(jtis).size).toBe(tokens.length);
    tokens.forEach((token, i) => {
      const detail = commerceDetail(token)!;
      const merchant = i % 2 === 0 ? MERCHANT : OTHER_MERCHANT;
      expect(decodeJwt(token)['aud']).toBe(merchant);
      expect(detail['allowed_merchants']).toEqual([merchant]);
      expect(detail['amount_range']).toEqual({ currency: 'EUR', max: `${10 + i}.00` });
      expect(detail['budget']).toEqual({ amount: '500.00', currency: 'EUR' });
    });
    expect(await childCount(parent.grantId)).toBe(tokens.length);
  });
});

describePostgres('PASSPORT_BOUND_GRANTS_ENABLED off', () => {
  it('answers a token exchange as before and issues no child', async () => {
    const parent = await parentGrant();
    vi.stubEnv(FLAG, 'false');
    const json = await childExchange(parent, {}, false);
    expect(json.statusCode, json.body).toBe(400);
    expect(json.json<{ code: string }>().code).toBe('BAD_REQUEST');
    const form = await childExchange(parent);
    expect(form.statusCode, form.body).toBe(415);
    expect(await childCount(parent.grantId)).toBe(0);
  });

  it('ignores authorization_details on authorize, as any member it does not know', async () => {
    const agent = await newAgent();
    vi.stubEnv(FLAG, 'false');
    const res = await authorize(agent, undefined, { authorization_details: commerceEntry({ allowed_merchants: ['not an origin'] }) });
    expect(res.statusCode, res.body).toBe(201);
  });
});

function statusCalls(): unknown[] {
  return vi.mocked(tokenExchangeTotal.inc).mock.calls
    .map((call) => call[0] as unknown)
    .filter((labels) => typeof labels === 'object' && labels !== null && 'status' in labels);
}

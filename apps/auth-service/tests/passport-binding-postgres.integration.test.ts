// SPDX-License-Identifier: Apache-2.0
/**
 * Passport binding at grant issuance (spec/passport-binding.md) against real
 * Postgres, through the routes.
 *
 * The happy path uses the mock accredited issuer (packages/mock-issuer): it
 * issues an Agent Passport after the agent proves its key, its attestation
 * is posted through POST /v1/registry/attestations with
 * REGISTRY_DEV_ISSUER_ORIGIN_MAP pointing https://mock-issuer.example at the
 * mock's loopback server, the agent proves the same key to the registry, and
 * POST /v1/authorize takes the passport. The grant token's
 * authorization_details and cnf are then read back.
 *
 * Refusals that need a passport the mock issuer cannot make (a second
 * passport under one attestation_id, a cnf key other than the attested one,
 * an issuer the registry does not know) come from a test issuer of this
 * file's own, built with @grantex/agent-passport and served from another
 * loopback server.
 *
 * Covered: migration 125; every refusal with its code and HTTP status, and
 * nothing written for any of them; the audit entry for attestation_mismatch;
 * the recheck at code exchange and at refresh; the consent view; and the flag
 * off, where a passport changes nothing.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { CompactSign, decodeJwt, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { setAcceptance } from '../src/lib/registry/acceptance-status.js';
import { ATTESTATION_TYP } from '../src/lib/registry/attestation-jws.js';
import { REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV } from '../src/lib/registry/issuer-fetcher.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { COMMERCE_DETAIL_TYPE } from '../src/lib/registry/passport-binding.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';
import {
  loadAgentPassport,
  loadMockIssuer,
  type AgentPassportModule,
  type MockIssuer,
  type MockIssuerModule,
  type MockIssuerServer,
} from './helpers/workspace-packages.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres passport binding tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const RAIL = 'https://merchant.example/checkout';
const DAY_S = 86_400;
const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
const FLAG = 'PASSPORT_BOUND_GRANTS_ENABLED';

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; privateJwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string }
interface Agent { id: string; did: string; key: Key; tenant: Tenant }
/** A test issuer of this file's own, for passports the mock issuer cannot make. */
interface TestIssuer {
  host: string;
  entityId: string;
  key: Key;
  statusListUri: string;
  entries: Map<number, number>;
  serve: 'ok' | 'down';
}
interface Refusal { statusCode: number; body: string; json: <T>() => T }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let mock: MockIssuerModule;
let passportLib: AgentPassportModule;
let mockIssuer: MockIssuer;
let mockServer: MockIssuerServer;
let testIssuerServer: Server;
let testIssuerPort = 0;
const testIssuers = new Map<string, TestIssuer>();
const operatorKey = randomBytes(32).toString('hex');
let addressCounter = 0;
let idxCounter = 0;

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

function originMap(): string {
  return [
    mockServer.originMapEntry,
    ...[...testIssuers.values()].map((issuer) => `https://${issuer.host}=http://127.0.0.1:${testIssuerPort}`),
  ].join(',');
}

async function operator(method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  const res = await app.inject({
    method, url, headers: { authorization: `Bearer ${operatorKey}` }, remoteAddress: nextAddress(),
    ...(payload !== undefined ? { payload } : {}),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json<Record<string, unknown>>();
}

async function accreditMockIssuer(): Promise<void> {
  await operator('POST', '/v1/registry/issuers', {
    entity_id: mockIssuer.entityId,
    jwks: mockIssuer.jwks(),
    trust_marks: [AGENT_IDENTITY, PROVIDER_ENTITY],
    status_list_base: mockIssuer.statusListBase,
    accreditation_evidence_ref: 'accreditation-case-mock-issuer',
  });
}

async function newTestIssuer(options: { trustMarks?: string[] | null } = {}): Promise<TestIssuer & { id: string | null }> {
  const host = `issuer-${randomBytes(4).toString('hex')}.example`;
  const key = await newKey();
  let id: string | null = null;
  if (options.trustMarks !== null) {
    const record = await operator('POST', '/v1/registry/issuers', {
      entity_id: `https://${host}`,
      jwks: { keys: [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] },
      trust_marks: options.trustMarks ?? [AGENT_IDENTITY, PROVIDER_ENTITY],
      status_list_base: `https://${host}/status/`,
      accreditation_evidence_ref: `accreditation-case-${host}`,
    });
    id = record['id'] as string;
  }
  const issuer: TestIssuer = {
    host, entityId: `https://${host}`, key, statusListUri: `https://${host}/status/${host}/1`, entries: new Map(), serve: 'ok',
  };
  testIssuers.set(host, issuer);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  return { ...issuer, id };
}

/** A Token Status List of 2-bit entries (draft-ietf-oauth-status-list-21 §4.1). */
function encodeList(entries: Map<number, number>, size = 1024): string {
  const bytes = Buffer.alloc(size / 4);
  for (const [idx, value] of entries) bytes[Math.floor(idx / 4)]! |= value << ((idx % 4) * 2);
  return deflateSync(bytes).toString('base64url');
}

async function testIssuerStatusList(issuer: TestIssuer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new CompactSign(new TextEncoder().encode(JSON.stringify({
    sub: issuer.statusListUri, iat: now - 5, exp: now + 3600, ttl: 300,
    status_list: { bits: 2, lst: encodeList(issuer.entries) },
  }))).setProtectedHeader({ typ: 'statuslist+jwt', alg: 'ES256', kid: 'k1' }).sign(issuer.key.privateKey);
}

async function newTenant(mode: 'sandbox' | 'live' = 'sandbox'): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_ppb_${suffix}`, apiKey: `gx_test_ppb_${suffix}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Passport Binding Test', ${mode})`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
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

async function newAgent(options: { mode?: 'sandbox' | 'live'; resourceServers?: string[] } = {}): Promise<Agent> {
  const tenant = await newTenant(options.mode);
  const created = await call(tenant, 'POST', '/v1/agents', {
    name: 'Nimbus Shopper 2.4',
    scopes: ['read', 'write', 'tool:checkout:create'],
    resourceServers: options.resourceServers ?? [RAIL],
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ agentId: string }>().agentId;
  const [row] = await sql`SELECT did FROM agents WHERE id = ${id}`;
  const key = await newKey();
  await addAndProveKey(tenant, id, key);
  return { id, did: row!['did'] as string, key, tenant };
}

const AGENT_CLAIM = { software_name: 'Nimbus Shopper', software_version: '2.4' };

/** A passport from the mock issuer, after the agent proves its key to the issuer. */
function mockPassport(agent: Agent, declaredLimits?: Record<string, unknown>) {
  const challenge = mockIssuer.createPossessionChallenge({ agentDid: agent.did, agentPublicJwk: agent.key.jwk });
  const possessionProof = mock.signPossessionProof({ challenge, agentPrivateJwk: agent.key.privateJwk });
  return mockIssuer.issuePassport({
    agentDid: agent.did,
    agentPublicJwk: agent.key.jwk,
    possessionProof,
    provider: { did: 'did:web:provider.example' },
    agent: { ...AGENT_CLAIM, ...(declaredLimits ? { declared_limits: declaredLimits } : {}) },
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

/** An agent holding a mock-issuer passport whose attestation the registry accepted. */
async function boundSetup(options: { mode?: 'sandbox' | 'live'; declaredLimits?: Record<string, unknown> } = {}) {
  const agent = await newAgent({ ...(options.mode ? { mode: options.mode } : {}) });
  const passport = mockPassport(agent, options.declaredLimits);
  const attestation = await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
  return { agent, passport, attestation };
}

interface TestPassportOptions {
  issuer: TestIssuer;
  agent: Agent;
  cnf?: Key;
  attestationId?: string;
  iat?: number;
  exp?: number;
  idx?: number;
  declaredLimits?: Record<string, unknown>;
}

async function testPassport(options: TestPassportOptions) {
  const now = Math.floor(Date.now() / 1000);
  const attestationId = options.attestationId ?? `att-${randomBytes(6).toString('hex')}`;
  const idx = options.idx ?? (idxCounter += 1);
  const { compact } = passportLib.issuePassport({
    issuerKey: { ...options.issuer.key.privateJwk, kid: 'k1' },
    iss: options.issuer.entityId,
    sub: options.agent.did,
    cnfJwk: (options.cnf ?? options.agent.key).jwk,
    iat: options.iat ?? now - 60,
    exp: options.exp ?? now + 30 * DAY_S,
    status: { status_list: { uri: options.issuer.statusListUri, idx } },
    claims: {
      provider: { did: 'did:web:provider.example' },
      agent: { ...AGENT_CLAIM, ...(options.declaredLimits ? { declared_limits: options.declaredLimits } : {}) },
      verification: { level: 'substantial' },
      attestation_id: attestationId,
    },
  });
  return { compact, attestationId, idx };
}

async function testAttestation(issuer: TestIssuer, agent: Agent, passport: { compact: string; attestationId: string; idx: number },
  overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new CompactSign(new TextEncoder().encode(JSON.stringify({
    iss: issuer.entityId,
    id: passport.attestationId,
    sub: agent.did,
    type: AGENT_IDENTITY,
    iat: now - 60,
    exp: now + 30 * DAY_S,
    key_thumbprint: agent.key.thumbprint,
    external_credential_id: `ppt-${randomBytes(4).toString('hex')}`,
    external_credential_hash: passportLib.externalCredentialHash(passport.compact),
    level: 'substantial',
    status: { status_list: { uri: issuer.statusListUri, idx: passport.idx } },
    ...overrides,
  }))).setProtectedHeader({ typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' }).sign(issuer.key.privateKey);
}

async function authorize(agent: Agent, passport: string | undefined, extra: Record<string, unknown> = {}) {
  return call(agent.tenant, 'POST', '/v1/authorize', {
    agentId: agent.id,
    principalId: 'user_shopper',
    scopes: ['read'],
    audience: RAIL,
    ...(passport !== undefined ? { passport } : {}),
    ...extra,
  });
}

async function exchange(agent: Agent, code: string) {
  return call(agent.tenant, 'POST', '/v1/token', { code, agentId: agent.id });
}

async function authRequestCount(agent: Agent): Promise<number> {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM auth_requests WHERE agent_id = ${agent.id}`;
  return row!['n'] as number;
}

async function expectRefusal(agent: Agent, res: Refusal, status: number, code: string, reason?: string) {
  expect(res.statusCode, res.body).toBe(status);
  const body = res.json<Record<string, unknown>>();
  expect(body['code'], res.body).toBe(code);
  if (reason !== undefined) expect(body['reason'], res.body).toBe(reason);
  // A refusal records no authorization request.
  expect(await authRequestCount(agent)).toBe(0);
}

function commerceDetail(token: string): Record<string, unknown> | undefined {
  const details = decodeJwt(token)['authorization_details'] as Array<Record<string, unknown>> | undefined;
  return details?.find((entry) => entry['type'] === COMMERCE_DETAIL_TYPE);
}

async function makeStale(attestation: Record<string, unknown>): Promise<void> {
  await sql`UPDATE registry_attestations SET issuer_status_fresh_until = NOW() - INTERVAL '1 second'
            WHERE id = ${attestation['id'] as string}`;
}

/** The SQL mock forwards to this file's own database, so triggers and locks are the production ones. */
function forwardSqlMock(): void {
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('passport_binding');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  mock = await loadMockIssuer();
  passportLib = await loadAgentPassport();
  mockIssuer = mock.MockIssuer.create();
  mockServer = await mock.startMockIssuerServer({ issuer: mockIssuer });
  testIssuerServer = createServer((req, res) => {
    const match = /^\/status\/([^/]+)\/1$/.exec(req.url ?? '');
    const issuer = match ? testIssuers.get(match[1]!) : undefined;
    if (!issuer || issuer.serve === 'down') {
      res.writeHead(503);
      res.end();
      return;
    }
    void testIssuerStatusList(issuer).then((token) => {
      res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
      res.end(token);
    });
  });
  await new Promise<void>((resolve) => testIssuerServer.listen(0, '127.0.0.1', resolve));
  testIssuerPort = (testIssuerServer.address() as AddressInfo).port;
  app = await buildTestApp();
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  forwardSqlMock();
  await accreditMockIssuer();
  vi.unstubAllEnvs();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await mockServer?.close();
  if (testIssuerServer) await new Promise<void>((resolve) => testIssuerServer.close(() => resolve()));
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  if (!adminDatabaseUrl) return;
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  vi.stubEnv(FLAG, 'true');
  forwardSqlMock();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('migration 125', () => {
  it('is recorded in the ledger and adds the binding to auth requests and grants', async () => {
    const ledger = await sql`SELECT filename FROM schema_migrations WHERE filename = '125_passport_bound_grants.sql'`;
    expect(ledger).toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('auth_requests', 'grant_passport_bindings')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('auth_requests')).toContain('passport_binding');
    expect(names('grant_passport_bindings')).toEqual(expect.arrayContaining([
      'grant_id', 'developer_id', 'agent_id', 'issuer_entity_id', 'attestation_id', 'registry_attestation_id',
      'external_credential_id', 'passport_hash', 'key_thumbprint', 'acceptance_list_uri', 'acceptance_list_idx',
      'passport_expires_at', 'created_at',
    ]));
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'grant_passport_bindings'`;
    expect(indexes.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'idx_grant_passport_bindings_attestation',
      'idx_grant_passport_bindings_registry_attestation',
      'idx_grant_passport_bindings_acceptance',
      'idx_grant_passport_bindings_key',
    ]));
  });
});

describePostgres('POST /v1/authorize with a passport from the mock issuer', () => {
  it('binds the grant to the passport: authorization_details, cnf.jkt and aud', async () => {
    const { agent, passport, attestation } = await boundSetup();
    // The mock's list has a 1 s ttl, so the registry's recorded read is stale
    // by now: authorization reads the issuer's list again, through the map.
    await makeStale(attestation);

    const authorized = await authorize(agent, passport.compact);
    expect(authorized.statusCode, authorized.body).toBe(201);
    const code = authorized.json<{ code: string }>().code;
    expect(code).toBeTruthy();

    const exchanged = await exchange(agent, code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    const { grantToken, grantId } = exchanged.json<{ grantToken: string; grantId: string }>();
    const claims = decodeJwt(grantToken);
    const acceptance = (attestation['acceptance'] as { status_list: { uri: string; idx: number } }).status_list;
    expect(claims['authorization_details']).toEqual([{
      type: COMMERCE_DETAIL_TYPE,
      passport: {
        issuer: 'https://mock-issuer.example',
        id: passport.attestationId,
        hash: passport.externalCredentialHash,
        key_thumbprint: agent.key.thumbprint,
      },
      acceptance_status: { uri: acceptance.uri, idx: acceptance.idx },
    }]);
    expect(claims['cnf']).toEqual({ jkt: agent.key.thumbprint });
    expect(claims['aud']).toBe(RAIL);

    const [binding] = await sql`SELECT * FROM grant_passport_bindings WHERE grant_id = ${grantId}`;
    expect(binding).toMatchObject({
      developer_id: agent.tenant.id,
      agent_id: agent.id,
      issuer_entity_id: 'https://mock-issuer.example',
      attestation_id: passport.attestationId,
      registry_attestation_id: attestation['id'],
      external_credential_id: passport.passportId,
      passport_hash: passport.externalCredentialHash,
      key_thumbprint: agent.key.thumbprint,
      acceptance_list_uri: acceptance.uri,
      acceptance_list_idx: acceptance.idx,
    });
    const [grant] = await sql`SELECT agent_key_thumbprint, authorization_details FROM grants WHERE id = ${grantId}`;
    // The grant row keeps its own authorization_details (the tools entries):
    // the commerce entry lives in grant_passport_bindings and in the token.
    expect(grant).toEqual({ agent_key_thumbprint: agent.key.thumbprint, authorization_details: null });
  });

  it('keeps the existing RAR types next to the commerce entry', async () => {
    const { agent, passport } = await boundSetup();
    const authorized = await authorize(agent, passport.compact, { scopes: ['tool:checkout:create'], purpose: 'payments.payout' });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    const details = decodeJwt(exchanged.json<{ grantToken: string }>().grantToken)['authorization_details'] as Array<Record<string, unknown>>;
    expect(details.map((entry) => entry['type'])).toEqual(['urn:grantex:tools:v1', COMMERCE_DETAIL_TYPE]);
    expect(details[0]).toEqual({ type: 'urn:grantex:tools:v1', connector: 'checkout', purpose: 'payments.payout' });
  });

  it('carries the binding through a refresh', async () => {
    const { agent, passport } = await boundSetup();
    const authorized = await authorize(agent, passport.compact);
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    const first = exchanged.json<{ grantToken: string; refreshToken: string }>();
    const refreshed = await call(agent.tenant, 'POST', '/v1/token/refresh', { refreshToken: first.refreshToken, agentId: agent.id });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    const token = refreshed.json<{ grantToken: string }>().grantToken;
    expect(commerceDetail(token)).toEqual(commerceDetail(first.grantToken));
    expect(decodeJwt(token)['cnf']).toEqual({ jkt: agent.key.thumbprint });
  });

  it('shows the level, the issuers and the declared limits on the consent view', async () => {
    const declaredLimits = { max_transaction: { amount: '250.00', currency: 'EUR' } };
    const { agent, passport } = await boundSetup({ mode: 'live', declaredLimits });
    const authorized = await authorize(agent, passport.compact);
    expect(authorized.statusCode, authorized.body).toBe(201);
    const { authRequestId } = authorized.json<{ authRequestId: string }>();
    const consent = await app.inject({ method: 'GET', url: `/v1/consent/${authRequestId}`, remoteAddress: nextAddress() });
    expect(consent.statusCode, consent.body).toBe(200);
    const view = consent.json<Record<string, unknown>>();
    expect(view['agentPassport']).toEqual({
      trustLevel: expect.stringMatching(/^(basic|verified|attested|attested_verified)$/),
      verificationLevel: 'substantial',
      issuers: ['https://mock-issuer.example'],
      declaredLimits,
      softwareName: 'Nimbus Shopper',
      softwareVersion: '2.4',
    });
    const page = await app.inject({ method: 'GET', url: `/consent?req=${authRequestId}`, remoteAddress: nextAddress() });
    expect(page.body).toContain('data.agentPassport');
    expect(page.body).toContain('Declared limits');
  });
});

describePostgres('POST /v1/authorize refusals, each with its code', () => {
  it('passport_malformed: not an SD-JWT', async () => {
    const agent = await newAgent();
    await expectRefusal(agent, await authorize(agent, 'eyJhbGciOiJFUzI1NiJ9.e30.sig~'), 400, 'passport_malformed');
  });

  it('passport_invalid_signature: signed by a key the registry does not hold for the issuer', async () => {
    const agent = await newAgent();
    const impostor = mock.MockIssuer.create();
    const challenge = impostor.createPossessionChallenge({ agentDid: agent.did, agentPublicJwk: agent.key.jwk });
    const passport = impostor.issuePassport({
      agentDid: agent.did,
      agentPublicJwk: agent.key.jwk,
      possessionProof: mock.signPossessionProof({ challenge, agentPrivateJwk: agent.key.privateJwk }),
      provider: { did: 'did:web:provider.example' },
      agent: AGENT_CLAIM,
      verification: { level: 'substantial' },
    });
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_invalid_signature');
  });

  it('passport_expired', async () => {
    const issuer = await newTestIssuer();
    const agent = await newAgent();
    const now = Math.floor(Date.now() / 1000);
    const passport = await testPassport({ issuer, agent, iat: now - 2 * DAY_S, exp: now - DAY_S });
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_expired', 'expired');
  });

  it('issuer_not_accredited: an issuer the registry does not know', async () => {
    const issuer = await newTestIssuer({ trustMarks: null });
    const agent = await newAgent();
    const passport = await testPassport({ issuer, agent });
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'issuer_not_accredited');
  });

  it('trust_mark_missing: an issuer not accredited for agent.identity', async () => {
    const issuer = await newTestIssuer({ trustMarks: [PROVIDER_ENTITY] });
    const agent = await newAgent();
    const passport = await testPassport({ issuer, agent });
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'trust_mark_missing');
  });

  it('issuer_suspended', async () => {
    const issuer = await newTestIssuer();
    const agent = await newAgent();
    const passport = await testPassport({ issuer, agent });
    await postAttestation(await testAttestation(issuer, agent, passport));
    await operator('PATCH', `/v1/registry/issuers/${issuer.id!}`, { status: 'suspended', reason: 'irregularity under review' });
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'issuer_suspended');
  });

  it('attestation_not_registered: the issuer never posted the attestation', async () => {
    const agent = await newAgent();
    const passport = mockPassport(agent);
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'attestation_not_registered');
  });

  it('attestation_hash_mismatch: another passport under the same attestation_id', async () => {
    const issuer = await newTestIssuer();
    const agent = await newAgent();
    const registered = await testPassport({ issuer, agent });
    await postAttestation(await testAttestation(issuer, agent, registered));
    const other = await testPassport({ issuer, agent, attestationId: registered.attestationId, idx: registered.idx });
    await expectRefusal(agent, await authorize(agent, other.compact), 403, 'attestation_hash_mismatch');
  });

  it('attestation_not_accepted: the attestation was withdrawn', async () => {
    const { agent, passport, attestation } = await boundSetup();
    await operator('DELETE', `/v1/registry/attestations/${attestation['id'] as string}`);
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'attestation_not_accepted', 'withdrawn');
  });

  it('passport_revoked: the registry suspended its acceptance', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const acceptance = (attestation['acceptance'] as { status_list: { uri: string; idx: number } }).status_list;
    await setAcceptance(acceptance.uri, acceptance.idx, 'suspended');
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_revoked', 'acceptance_suspended');
  });

  it('passport_revoked: the issuer revoked the passport (read from its list now)', async () => {
    const { agent, passport, attestation } = await boundSetup();
    mockIssuer.revokePassport(passport.attestationId);
    await makeStale(attestation);
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_revoked', 'invalid');
  });

  it('passport_revoked: the recorded issuer status is suspended', async () => {
    const { agent, passport, attestation } = await boundSetup();
    await sql`UPDATE registry_attestations SET issuer_status = 'suspended', issuer_status_fresh_until = NOW() + INTERVAL '1 hour'
              WHERE id = ${attestation['id'] as string}`;
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_revoked', 'suspended');
  });

  it('status_stale: the recorded read is stale and the issuer list cannot be read', async () => {
    const issuer = await newTestIssuer();
    const agent = await newAgent();
    const passport = await testPassport({ issuer, agent });
    const attestation = await postAttestation(await testAttestation(issuer, agent, passport));
    testIssuers.get(issuer.host)!.serve = 'down';
    await makeStale(attestation);
    await expectRefusal(agent, await authorize(agent, passport.compact), 503, 'status_stale');
  });

  it('key_binding_mismatch: the passport binds a key other than the attested one', async () => {
    const issuer = await newTestIssuer();
    const agent = await newAgent();
    const second = await newKey();
    await addAndProveKey(agent.tenant, agent.id, second);
    const passport = await testPassport({ issuer, agent, cnf: second });
    await postAttestation(await testAttestation(issuer, agent, passport));
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'key_binding_mismatch');
  });

  it('key_not_active: the key was rotated out and its overlap has ended', async () => {
    const { agent, passport } = await boundSetup();
    await sql`UPDATE agent_keys SET status = 'rotated', valid_to = NOW() - INTERVAL '1 second'
              WHERE thumbprint = ${agent.key.thumbprint}`;
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'key_not_active');
  });

  it('key_unproven: the agent no longer holds a proven copy of the key', async () => {
    const { agent, passport } = await boundSetup();
    await sql`UPDATE agent_keys SET status = 'pending', possession_proved_at = NULL
              WHERE thumbprint = ${agent.key.thumbprint}`;
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'key_unproven');
  });

  it('attestation_mismatch: a scope outside the declared limits, with an audit entry', async () => {
    const { agent, passport, attestation } = await boundSetup({ declaredLimits: { scopes: ['read'] } });
    const res = await authorize(agent, passport.compact, { scopes: ['read', 'write'] });
    await expectRefusal(agent, res, 403, 'attestation_mismatch', 'scope_not_declared');
    const entries = await sql`
      SELECT action, agent_id, metadata FROM audit_entries
      WHERE developer_id = ${agent.tenant.id} AND action = 'grantex.passport.attestation_mismatch'`;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent_id: agent.id,
      metadata: expect.objectContaining({
        reason: 'scope_not_declared',
        issuerEntityId: 'https://mock-issuer.example',
        attestationId: passport.attestationId,
        registryAttestationId: attestation['id'],
        scopesNotDeclared: ['write'],
      }),
    });
    // Within the declared scopes the same passport is accepted.
    expect((await authorize(agent, passport.compact, { scopes: ['read'] })).statusCode).toBe(201);
  });

  it('attestation_mismatch: the passport is another agent\'s', async () => {
    const { passport } = await boundSetup();
    const other = await newAgent();
    await expectRefusal(other, await authorize(other, passport.compact), 403, 'attestation_mismatch', 'subject_mismatch');
  });

  it('refuses a passport without an audience: a bound grant names its rail or verifier', async () => {
    const agent = await newAgent({ resourceServers: [] });
    const passport = mockPassport(agent);
    const res = await call(agent.tenant, 'POST', '/v1/authorize', {
      agentId: agent.id, principalId: 'user_shopper', scopes: ['read'], passport: passport.compact,
    });
    await expectRefusal(agent, res, 400, 'RESOURCE_REQUIRED');
  });
});

describePostgres('the binding is checked again when the grant is issued', () => {
  it('refuses the code exchange once the attestation is withdrawn, and leaves the code unused', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const authorized = await authorize(agent, passport.compact);
    const code = authorized.json<{ code: string }>().code;
    await operator('DELETE', `/v1/registry/attestations/${attestation['id'] as string}`);
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('attestation_not_accepted');
    const [row] = await sql`SELECT status FROM auth_requests WHERE code = ${code}`;
    expect(row!['status']).toBe('approved');
    expect(await sql`SELECT 1 FROM grant_passport_bindings WHERE agent_id = ${agent.id}`).toHaveLength(0);
  });

  it('refuses a refresh once the registry suspends its acceptance', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const authorized = await authorize(agent, passport.compact);
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    const acceptance = (attestation['acceptance'] as { status_list: { uri: string; idx: number } }).status_list;
    await setAcceptance(acceptance.uri, acceptance.idx, 'suspended');
    const refreshed = await call(agent.tenant, 'POST', '/v1/token/refresh', {
      refreshToken: exchanged.json<{ refreshToken: string }>().refreshToken, agentId: agent.id,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(403);
    expect(refreshed.json<{ code: string }>().code).toBe('passport_revoked');
  });

  it('keeps the binding of a request authorized under the flag when the flag is turned off before the exchange', async () => {
    const { agent, passport } = await boundSetup();
    const authorized = await authorize(agent, passport.compact);
    vi.stubEnv(FLAG, 'false');
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    expect(commerceDetail(exchanged.json<{ grantToken: string }>().grantToken)).toBeDefined();
  });
});

/** An agent holding a test-issuer passport whose attestation the registry accepted. */
async function testBoundSetup(options: { passportExp?: number; attestationExp?: number } = {}) {
  const issuer = await newTestIssuer();
  const agent = await newAgent();
  const passport = await testPassport({ issuer, agent, ...(options.passportExp !== undefined ? { exp: options.passportExp } : {}) });
  const attestation = await postAttestation(await testAttestation(issuer, agent, passport,
    options.attestationExp !== undefined ? { exp: options.attestationExp } : {}));
  return { issuer, agent, passport, attestation };
}

async function expireAttestation(attestation: Record<string, unknown>): Promise<void> {
  await sql`UPDATE registry_attestations SET iat = NOW() - INTERVAL '1 hour', exp = NOW() - INTERVAL '1 second'
            WHERE id = ${attestation['id'] as string}`;
}

async function refresh(agent: Agent, refreshToken: string) {
  return call(agent.tenant, 'POST', '/v1/token/refresh', { refreshToken, agentId: agent.id });
}

async function expectUnusedCode(code: string): Promise<void> {
  const [row] = await sql`SELECT status FROM auth_requests WHERE code = ${code}`;
  expect(row!['status']).toBe('approved');
}

async function expectUnusedRefreshToken(refreshToken: string): Promise<void> {
  const [row] = await sql`SELECT is_used FROM refresh_tokens WHERE id = ${refreshToken}`;
  expect(row!['is_used']).toBe(false);
}

describePostgres('the issuer status at issuance is valid and fresh', () => {
  it('status_stale at the code exchange: the recorded read is stale and the issuer list cannot be read', async () => {
    const { issuer, agent, passport, attestation } = await testBoundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    testIssuers.get(issuer.host)!.serve = 'down';
    await makeStale(attestation);
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('status_stale');
    await expectUnusedCode(code);
    expect(await sql`SELECT 1 FROM grant_passport_bindings WHERE agent_id = ${agent.id}`).toHaveLength(0);
  });

  it('reads the issuer list again at the code exchange when the recorded read is stale', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    await makeStale(attestation);
    const before = Date.now();
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await sql`SELECT issuer_status_fresh_until FROM registry_attestations WHERE id = ${attestation['id'] as string}`;
    expect((row!['issuer_status_fresh_until'] as Date).getTime()).toBeGreaterThan(before - 1000);
    expect(commerceDetail(res.json<{ grantToken: string }>().grantToken)).toBeDefined();
  });

  it('passport_revoked at the code exchange: the issuer revoked the passport on the list read again', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    mockIssuer.revokePassport(passport.attestationId);
    await makeStale(attestation);
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_revoked');
    await expectUnusedCode(code);
  });

  it('status_stale at refresh: the recorded read is stale and the issuer list cannot be read', async () => {
    const { issuer, agent, passport, attestation } = await testBoundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    const { refreshToken } = (await exchange(agent, code)).json<{ refreshToken: string }>();
    testIssuers.get(issuer.host)!.serve = 'down';
    await makeStale(attestation);
    const res = await refresh(agent, refreshToken);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('status_stale');
    await expectUnusedRefreshToken(refreshToken);
  });

  it('passport_revoked at refresh: the issuer revoked the passport on the list read again', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    const { refreshToken } = (await exchange(agent, code)).json<{ refreshToken: string }>();
    mockIssuer.revokePassport(passport.attestationId);
    await makeStale(attestation);
    const res = await refresh(agent, refreshToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_revoked');
    await expectUnusedRefreshToken(refreshToken);
  });
});

describePostgres('a bound grant never outlives its passport or attestation', () => {
  it('passport_expired at authorization: the attestation has expired', async () => {
    const { agent, passport, attestation } = await boundSetup();
    await expireAttestation(attestation);
    await expectRefusal(agent, await authorize(agent, passport.compact), 403, 'passport_expired', 'attestation_expired');
  });

  it('passport_expired at the code exchange: the attestation expired after consent', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    await expireAttestation(attestation);
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_expired');
    await expectUnusedCode(code);
  });

  it('passport_expired at the code exchange: the passport expired after consent', async () => {
    const { agent, passport } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    await sql`UPDATE auth_requests
              SET passport_binding = jsonb_set(passport_binding, '{passport_exp}', to_jsonb(EXTRACT(EPOCH FROM NOW())::bigint - 1))
              WHERE code = ${code}`;
    const res = await exchange(agent, code);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_expired');
    await expectUnusedCode(code);
  });

  it('passport_expired at refresh: the attestation expired', async () => {
    const { agent, passport, attestation } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    const { refreshToken } = (await exchange(agent, code)).json<{ refreshToken: string }>();
    await expireAttestation(attestation);
    const res = await refresh(agent, refreshToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_expired');
    await expectUnusedRefreshToken(refreshToken);
  });

  it('passport_expired at refresh: the recorded passport exp has passed', async () => {
    const { agent, passport } = await boundSetup();
    const code = (await authorize(agent, passport.compact)).json<{ code: string }>().code;
    const { refreshToken, grantId } = (await exchange(agent, code)).json<{ refreshToken: string; grantId: string }>();
    await sql`UPDATE grant_passport_bindings SET passport_expires_at = NOW() - INTERVAL '1 second' WHERE grant_id = ${grantId}`;
    const res = await refresh(agent, refreshToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('passport_expired');
    await expectUnusedRefreshToken(refreshToken);
  });

  it('limits the grant lifetime to the passport exp', async () => {
    const passportExp = Math.floor(Date.now() / 1000) + 3600;
    const { agent, passport } = await testBoundSetup({ passportExp });
    const authorized = await authorize(agent, passport.compact, { expiresIn: '7d' });
    expect(authorized.statusCode, authorized.body).toBe(201);
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    const body = exchanged.json<{ grantToken: string; grantId: string; refreshToken: string; expiresAt: string }>();
    expect(decodeJwt(body.grantToken)['exp']).toBe(passportExp);
    expect(new Date(body.expiresAt).getTime()).toBe(passportExp * 1000);
    const [grant] = await sql`SELECT expires_at FROM grants WHERE id = ${body.grantId}`;
    expect((grant!['expires_at'] as Date).getTime()).toBe(passportExp * 1000);
    const [refreshRow] = await sql`SELECT expires_at FROM refresh_tokens WHERE id = ${body.refreshToken}`;
    expect((refreshRow!['expires_at'] as Date).getTime()).toBeLessThanOrEqual(passportExp * 1000);
    const [binding] = await sql`SELECT passport_expires_at FROM grant_passport_bindings WHERE grant_id = ${body.grantId}`;
    expect((binding!['passport_expires_at'] as Date).getTime()).toBe(passportExp * 1000);
  });

  it('limits the grant lifetime to the attestation exp when it ends first', async () => {
    const now = Math.floor(Date.now() / 1000);
    const attestationExp = now + 3600;
    const { agent, passport } = await testBoundSetup({ passportExp: now + 7200, attestationExp });
    const authorized = await authorize(agent, passport.compact, { expiresIn: '7d' });
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    expect(decodeJwt(exchanged.json<{ grantToken: string }>().grantToken)['exp']).toBe(attestationExp);
  });

  it('keeps a requested lifetime shorter than the passport', async () => {
    const { agent, passport } = await boundSetup();
    const authorized = await authorize(agent, passport.compact, { expiresIn: '30m' });
    const before = Math.floor(Date.now() / 1000);
    const exchanged = await exchange(agent, authorized.json<{ code: string }>().code);
    expect(exchanged.statusCode, exchanged.body).toBe(201);
    const exp = decodeJwt(exchanged.json<{ grantToken: string }>().grantToken)['exp'] as number;
    expect(exp).toBeGreaterThanOrEqual(before + 1800);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1800);
  });
});

describePostgres('PASSPORT_BOUND_GRANTS_ENABLED off', () => {
  it('ignores the passport: the grant is issued exactly as without one', async () => {
    const { agent, passport } = await boundSetup();
    vi.stubEnv(FLAG, 'false');
    const [agentRow] = await sql`SELECT key_thumbprint FROM agents WHERE id = ${agent.id}`;

    const withPassport = await authorize(agent, passport.compact);
    const without = await authorize(agent, undefined);
    for (const res of [withPassport, without]) expect(res.statusCode, res.body).toBe(201);
    const rows = await sql`SELECT passport_binding, agent_key_thumbprint FROM auth_requests WHERE agent_id = ${agent.id}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toEqual({ passport_binding: null, agent_key_thumbprint: agentRow!['key_thumbprint'] });

    const tokens = [];
    for (const res of [withPassport, without]) {
      const exchanged = await exchange(agent, res.json<{ code: string }>().code);
      expect(exchanged.statusCode, exchanged.body).toBe(201);
      tokens.push(decodeJwt(exchanged.json<{ grantToken: string }>().grantToken));
    }
    for (const claims of tokens) {
      expect(claims['authorization_details']).toBeUndefined();
      expect(claims['cnf']).toEqual(agentRow!['key_thumbprint'] ? { jkt: agentRow!['key_thumbprint'] } : undefined);
    }
    expect(await sql`SELECT 1 FROM grant_passport_bindings WHERE agent_id = ${agent.id}`).toHaveLength(0);
  });
});

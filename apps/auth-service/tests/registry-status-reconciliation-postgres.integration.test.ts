// SPDX-License-Identifier: Apache-2.0
/**
 * Status-list reconciliation with cascade (spec/registry-federation.md,
 * "Status reconciliation") against real Postgres, through the routes.
 *
 * Passports come from the mock accredited issuer (packages/mock-issuer) and,
 * where a test needs a second issuer it can suspend or whose key it can
 * revoke, from test issuers of this file's own built with
 * @grantex/agent-passport. Every status list is served by one loopback server
 * of this file's own, reached through REGISTRY_DEV_ISSUER_ORIGIN_MAP, which
 * counts the fetches of each list so the dedupe can be asserted.
 *
 * Covered: an issuer revoking a passport reaches the attestation, the
 * registry's acceptance entry, the bound grant and the revocation feed within
 * one poll interval (1 s here, owner decision 5) and inside the 2 s feed SLO;
 * suspension suspends the bound grant and reinstatement resumes it; an
 * unreadable list changes nothing, is counted and ends in status_stale; an
 * issuer suspension and a revoked issuer key cascade, including a key revoked
 * days before reconciliation ran; a read in flight when its issuer is
 * suspended, or its list key revoked, is discarded; one fetch per list per
 * interval; one instance at a time; and the flag off, where nothing runs.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { CompactSign, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { ATTESTATION_TYP } from '../src/lib/registry/attestation-jws.js';
import { REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV } from '../src/lib/registry/issuer-fetcher.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { recordIssuerStatusReads } from '../src/lib/registry/attestations.js';
import {
  RECONCILIATION_LOCK_KEY,
  reconcileRegistryStatusOnce,
} from '../src/lib/registry/status-reconciliation.js';
import {
  registryStatusListPollFailuresTotal,
  registryStatusListPollsTotal,
  registryStatusListsStale,
} from '../src/lib/registry/reconciliation-metrics.js';
import {
  startRegistryStatusReconciliationWorker,
  stopRegistryStatusReconciliationWorker,
} from '../src/workers/registryStatusReconciliation.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';
import {
  loadAgentPassport,
  loadMockIssuer,
  type AgentPassportModule,
  type MockIssuer,
  type MockIssuerModule,
} from './helpers/workspace-packages.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres reconciliation tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const RAIL = 'https://merchant.example/checkout';
const DAY_S = 86_400;
const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
/** Owner decision 5: the mock issuer's and CI's poll interval. */
const POLL_MS = 1_000;
/** PRD §9: a revocation reaches the revocation feed within two seconds. */
const FEED_SLO_MS = 2_000;
const MOCK_HOST = 'mock-issuer.example';

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; privateJwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string }
interface Agent { id: string; did: string; key: Key; tenant: Tenant }
interface TestIssuer {
  id: string;
  host: string;
  entityId: string;
  key: Key;
  kid: string;
  /** The key the issuer signs its status list with: `key` unless the issuer has a second one. */
  listKey: Key;
  listKid: string;
  statusListUri: string;
  entries: Map<number, number>;
  ttl: number;
}
interface Bound { agent: Agent; attestationId: string; grantId: string; refreshToken: string; registryAttestationId: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let mock: MockIssuerModule;
let passportLib: AgentPassportModule;
let mockIssuer: MockIssuer;
let listServer: Server;
let listPort = 0;
/** Issuers whose lists are served as 503 instead of the token, by host. */
const down = new Set<string>();
/** Fetches of each list, by path. */
const fetches = new Map<string, number>();
/** Lists whose response is held until the test releases it, by issuer host. */
const holds = new Map<string, { arrived: () => void; released: Promise<void> }>();
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
  return [MOCK_HOST, ...testIssuers.keys()].map((host) => `https://${host}=http://127.0.0.1:${listPort}`).join(',');
}

async function operator(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method, url, payload, headers: { authorization: `Bearer ${operatorKey}` }, remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json<Record<string, unknown>>();
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
    sub: issuer.statusListUri, iat: now, exp: now + 3600, ttl: issuer.ttl,
    status_list: { bits: 2, lst: encodeList(issuer.entries) },
  }))).setProtectedHeader({ typ: 'statuslist+jwt', alg: 'ES256', kid: issuer.listKid }).sign(issuer.listKey.privateKey);
}

/**
 * Hold the issuer's list at the server until `release`: `arrived` settles
 * once the registry's fetch of it is in flight.
 */
function holdList(issuer: TestIssuer): { arrived: Promise<void>; release: () => void } {
  let arrived!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  holds.set(issuer.host, { arrived, released });
  return { arrived: arrival, release: () => { holds.delete(issuer.host); release(); } };
}

async function newTestIssuer(options: { ttl?: number; separateListKey?: boolean } = {}): Promise<TestIssuer> {
  const host = `issuer-${randomBytes(4).toString('hex')}.example`;
  const key = await newKey();
  const listKey = options.separateListKey ? await newKey() : key;
  const keys = [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }];
  if (options.separateListKey) keys.push({ ...listKey.jwk, kid: 'k2', alg: 'ES256', use: 'sig' });
  const record = await operator('POST', '/v1/registry/issuers', {
    entity_id: `https://${host}`,
    jwks: { keys },
    trust_marks: [AGENT_IDENTITY, PROVIDER_ENTITY],
    status_list_base: `https://${host}/status/`,
    accreditation_evidence_ref: `accreditation-case-${host}`,
  });
  const issuer: TestIssuer = {
    id: record['id'] as string,
    host,
    entityId: `https://${host}`,
    key,
    kid: 'k1',
    listKey,
    listKid: options.separateListKey ? 'k2' : 'k1',
    statusListUri: `https://${host}/status/${host}/1`,
    entries: new Map(),
    ttl: options.ttl ?? 1,
  };
  testIssuers.set(host, issuer);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  return issuer;
}

async function newTenant(): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_rsr_${suffix}`, apiKey: `gx_test_rsr_${suffix}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Reconciliation Test', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url, remoteAddress: nextAddress(), headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function newAgent(): Promise<Agent> {
  const tenant = await newTenant();
  const created = await call(tenant, 'POST', '/v1/agents', {
    name: 'Nimbus Shopper 2.4', scopes: ['read', 'write'], resourceServers: [RAIL],
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ agentId: string }>().agentId;
  const [row] = await sql`SELECT did FROM agents WHERE id = ${id}`;
  const key = await newKey();
  const added = await call(tenant, 'POST', `/v1/agents/${id}/keys`, { publicJwk: key.jwk });
  expect(added.statusCode, added.body).toBe(201);
  const issued = await call(tenant, 'POST', `/v1/agents/${id}/keys/${key.thumbprint}/challenge`);
  expect(issued.statusCode, issued.body).toBe(201);
  const proof = await new SignJWT({ nonce: issued.json<{ challenge: string }>().challenge, sub: id })
    .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(AUDIENCE).setIssuedAt().sign(key.privateKey);
  const proved = await call(tenant, 'POST', `/v1/agents/${id}/keys/${key.thumbprint}/prove`, { proof });
  expect(proved.statusCode, proved.body).toBe(200);
  return { id, did: row!['did'] as string, key, tenant };
}

const AGENT_CLAIM = { software_name: 'Nimbus Shopper', software_version: '2.4' };

async function postAttestation(compact: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST', url: '/v1/registry/attestations', payload: compact,
    headers: { 'content-type': 'application/grantex-attestation+jwt' }, remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Record<string, unknown>>();
}

/** Authorize with the passport, exchange the code, and return the bound grant. */
async function bindGrant(agent: Agent, passport: string): Promise<{ grantId: string; refreshToken: string }> {
  const authorized = await call(agent.tenant, 'POST', '/v1/authorize', {
    agentId: agent.id, principalId: 'user_shopper', scopes: ['read'], audience: RAIL, passport,
  });
  expect(authorized.statusCode, authorized.body).toBe(201);
  const exchanged = await call(agent.tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId: agent.id });
  expect(exchanged.statusCode, exchanged.body).toBe(201);
  return exchanged.json<{ grantId: string; refreshToken: string }>();
}

/** A grant bound to a mock-issuer passport. */
async function mockBound(): Promise<Bound> {
  const agent = await newAgent();
  const challenge = mockIssuer.createPossessionChallenge({ agentDid: agent.did, agentPublicJwk: agent.key.jwk });
  const possessionProof = mock.signPossessionProof({ challenge, agentPrivateJwk: agent.key.privateJwk });
  const passport = mockIssuer.issuePassport({
    agentDid: agent.did, agentPublicJwk: agent.key.jwk, possessionProof,
    provider: { did: 'did:web:provider.example' }, agent: AGENT_CLAIM, verification: { level: 'substantial' },
  });
  const attestation = await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
  const grant = await bindGrant(agent, passport.compact);
  return { agent, attestationId: passport.attestationId, registryAttestationId: attestation['id'] as string, ...grant };
}

/** A grant bound to a passport of a test issuer. */
async function testBound(issuer: TestIssuer): Promise<Bound & { idx: number }> {
  const agent = await newAgent();
  const now = Math.floor(Date.now() / 1000);
  const attestationId = `att-${randomBytes(6).toString('hex')}`;
  const idx = (idxCounter += 1);
  const { compact } = passportLib.issuePassport({
    issuerKey: { ...issuer.key.privateJwk, kid: issuer.kid },
    iss: issuer.entityId,
    sub: agent.did,
    cnfJwk: agent.key.jwk,
    iat: now - 60,
    exp: now + 30 * DAY_S,
    status: { status_list: { uri: issuer.statusListUri, idx } },
    claims: {
      provider: { did: 'did:web:provider.example' },
      agent: AGENT_CLAIM,
      verification: { level: 'substantial' },
      attestation_id: attestationId,
    },
  });
  const attestationJws = await new CompactSign(new TextEncoder().encode(JSON.stringify({
    iss: issuer.entityId,
    id: attestationId,
    sub: agent.did,
    type: AGENT_IDENTITY,
    iat: now - 60,
    exp: now + 30 * DAY_S,
    key_thumbprint: agent.key.thumbprint,
    external_credential_id: `ppt-${randomBytes(4).toString('hex')}`,
    external_credential_hash: passportLib.externalCredentialHash(compact),
    level: 'substantial',
    status: { status_list: { uri: issuer.statusListUri, idx } },
  }))).setProtectedHeader({ typ: ATTESTATION_TYP, alg: 'ES256', kid: issuer.kid }).sign(issuer.key.privateKey);
  const attestation = await postAttestation(attestationJws);
  const grant = await bindGrant(agent, compact);
  return { agent, attestationId, registryAttestationId: attestation['id'] as string, idx, ...grant };
}

async function attestationState(id: string): Promise<{ state: string; issuer_status: string; acceptance: number }> {
  const [row] = await sql<{ state: string; issuer_status: string; acceptance: number }[]>`
    SELECT a.state, a.issuer_status, e.status::int AS acceptance
    FROM registry_attestations a
    JOIN registry_acceptance_entries e
      ON e.list_id = regexp_replace(a.acceptance_list_uri, '^.*/', '') AND e.idx = a.acceptance_list_idx
    WHERE a.id = ${id}`;
  return row!;
}

async function grantStatus(grantId: string): Promise<string> {
  const [row] = await sql`SELECT status FROM grants WHERE id = ${grantId}`;
  return row!['status'] as string;
}

async function feedActions(grantId: string): Promise<string[]> {
  const rows = await sql`SELECT action FROM grant_revocation_events WHERE grant_id = ${grantId} ORDER BY seq`;
  return rows.map((row) => row['action'] as string);
}

async function refresh(bound: Bound) {
  return call(bound.agent.tenant, 'POST', '/v1/token/refresh', { refreshToken: bound.refreshToken, agentId: bound.agent.id });
}

/** Wait for `check` to hold, polling every 25 ms; returns the milliseconds it took. */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run until every due list has been read once more. */
async function reconcileNow() {
  const result = await reconcileRegistryStatusOnce(sql, undefined, { minIntervalMs: POLL_MS, force: true });
  expect(result.outcome).toBe('complete');
  return result;
}

/** The SQL mock forwards to this file's own database, so triggers and locks are the production ones. */
function forwardSqlMock(): void {
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
}

function stubEnv(): void {
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  vi.stubEnv('PASSPORT_BOUND_GRANTS_ENABLED', 'true');
  vi.stubEnv('REGISTRY_STATUS_RECONCILIATION_ENABLED', 'true');
  vi.stubEnv('REGISTRY_STATUS_POLL_MIN_INTERVAL_MS', String(POLL_MS));
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('status_reconcile');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  mock = await loadMockIssuer();
  passportLib = await loadAgentPassport();
  // Owner decision 5: the mock issuer's lists have a 1 s ttl.
  mockIssuer = mock.MockIssuer.create({ ttlSeconds: 1 });
  // Behind the origin map every list arrives at this one server, so the
  // path says whose it is: /status/{n} is the mock issuer's list n,
  // /status/{host}/1 a test issuer's only list.
  listServer = createServer((req, res) => {
    const path = req.url ?? '';
    fetches.set(path, (fetches.get(path) ?? 0) + 1);
    const fail = () => { res.writeHead(503); res.end(); };
    const mockList = /^\/status\/(\d+)$/.exec(path);
    const testList = /^\/status\/([^/]+)\/1$/.exec(path);
    const hold = testList ? holds.get(testList[1]!) : undefined;
    hold?.arrived();
    // The list is signed when it is answered, so a held list says what the
    // issuer's entries are at the release.
    void (hold?.released ?? Promise.resolve()).then(() => {
      let token: Promise<string> | null = null;
      if (mockList && !down.has(MOCK_HOST)) {
        token = Promise.resolve(mockIssuer.tokenStatusList(Number(mockList[1])));
      } else if (testList && !down.has(testList[1]!)) {
        const issuer = testIssuers.get(testList[1]!);
        if (issuer) token = testIssuerStatusList(issuer);
      }
      if (!token) return fail();
      void token.then((body) => {
        res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
        res.end(body);
      }, fail);
    });
  });
  await new Promise<void>((resolve) => listServer.listen(0, '127.0.0.1', resolve));
  listPort = (listServer.address() as AddressInfo).port;
  app = await buildTestApp();
  stubEnv();
  forwardSqlMock();
  await operator('POST', '/v1/registry/issuers', {
    entity_id: mockIssuer.entityId,
    jwks: mockIssuer.jwks(),
    trust_marks: [AGENT_IDENTITY, PROVIDER_ENTITY],
    status_list_base: mockIssuer.statusListBase,
    accreditation_evidence_ref: 'accreditation-case-mock-issuer',
  });
  vi.unstubAllEnvs();
}, 180_000);

afterAll(async () => {
  stopRegistryStatusReconciliationWorker();
  await app?.close();
  if (listServer) await new Promise<void>((resolve) => listServer.close(() => resolve()));
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  if (!adminDatabaseUrl) return;
  down.clear();
  holds.clear();
  stubEnv();
  forwardSqlMock();
});

afterEach(() => {
  stopRegistryStatusReconciliationWorker();
  vi.unstubAllEnvs();
});

describePostgres('the issuer revokes a passport', () => {
  it('reaches the attestation, the acceptance list, the bound grant and the revocation feed within one poll interval', async () => {
    const bound = await mockBound();
    expect(await grantStatus(bound.grantId)).toBe('active');
    startRegistryStatusReconciliationWorker(sql, undefined, { minIntervalMs: POLL_MS, startDelayMs: 0 });
    // Let the worker settle into its cadence before the flip is timed.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    const flipped = Date.now();
    mockIssuer.revokePassport(bound.attestationId);
    const toFeed = await waitFor(async () => (await feedActions(bound.grantId)).includes('revoked'), 10_000);
    // PRD §9: the revocation feed carries it within 2 s of the issuer's flip,
    // with the reconciliation polling at the list's 1 s ttl.
    expect(toFeed).toBeLessThanOrEqual(FEED_SLO_MS);
    expect(Date.now() - flipped).toBeLessThanOrEqual(FEED_SLO_MS + 250);

    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'revoked', acceptance: 1 });
    expect(await grantStatus(bound.grantId)).toBe('revoked');
    const [cascade] = await sql`
      SELECT a.metadata FROM audit_entries a
      WHERE a.grant_id = ${bound.grantId} AND a.action = 'grantex.grant.revoked'`;
    expect(cascade?.['metadata']).toMatchObject({ cause: 'registry', trigger: 'event' });
    const refused = await refresh(bound);
    expect(refused.statusCode, refused.body).toBe(400);
  });

  it('refuses the code exchange of a bound authorization once the list flips (S3-3 recheck)', async () => {
    const agent = await newAgent();
    const challenge = mockIssuer.createPossessionChallenge({ agentDid: agent.did, agentPublicJwk: agent.key.jwk });
    const possessionProof = mock.signPossessionProof({ challenge, agentPrivateJwk: agent.key.privateJwk });
    const passport = mockIssuer.issuePassport({
      agentDid: agent.did, agentPublicJwk: agent.key.jwk, possessionProof,
      provider: { did: 'did:web:provider.example' }, agent: AGENT_CLAIM, verification: { level: 'substantial' },
    });
    const attestation = await postAttestation(mockIssuer.buildAttestation({ attestationId: passport.attestationId }));
    const authorized = await call(agent.tenant, 'POST', '/v1/authorize', {
      agentId: agent.id, principalId: 'user_shopper', scopes: ['read'], audience: RAIL, passport: passport.compact,
    });
    expect(authorized.statusCode, authorized.body).toBe(201);
    startRegistryStatusReconciliationWorker(sql, undefined, { minIntervalMs: POLL_MS, startDelayMs: 0 });
    mockIssuer.revokePassport(passport.attestationId);
    await waitFor(async () => (await attestationState(attestation['id'] as string)).acceptance === 1, POLL_MS * 2 + 500);
    const exchanged = await call(agent.tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId: agent.id });
    expect(exchanged.statusCode, exchanged.body).toBe(403);
    expect(exchanged.json<{ code: string }>().code).toBe('passport_revoked');
  });
});

describePostgres('the issuer suspends and reinstates a passport', () => {
  it('suspends the acceptance and the bound grant, then restores both', async () => {
    const bound = await mockBound();
    mockIssuer.suspendPassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'suspended', acceptance: 2 });
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    expect(await feedActions(bound.grantId)).toEqual(['suspended']);
    const [suspension] = await sql`SELECT cause, root_grant_id FROM grant_suspensions WHERE grant_id = ${bound.grantId}`;
    expect(suspension).toEqual({ cause: 'registry', root_grant_id: bound.grantId });
    const refused = await refresh(bound);
    expect(refused.statusCode, refused.body).toBe(400);

    mockIssuer.reinstatePassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    expect(await grantStatus(bound.grantId)).toBe('active');
    expect(await feedActions(bound.grantId)).toEqual(['suspended', 'resumed']);
    const refreshed = await refresh(bound);
    expect(refreshed.statusCode, refreshed.body).toBe(201);
  });

  it('does not resume a grant that something other than the registry suspended', async () => {
    const bound = await mockBound();
    await sql`UPDATE grants SET status = 'suspended' WHERE id = ${bound.grantId}`;
    await sql`INSERT INTO grant_suspensions (grant_id, developer_id, root_grant_id, cause)
              VALUES (${bound.grantId}, ${bound.agent.tenant.id}, ${bound.grantId}, 'event')`;
    mockIssuer.suspendPassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();
    mockIssuer.reinstatePassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();
    expect(await grantStatus(bound.grantId)).toBe('suspended');
  });
});

describePostgres('an unreadable issuer list', () => {
  it('changes nothing, counts the failure, and ends in status_stale for the bound grant', async () => {
    const issuer = await newTestIssuer();
    const bound = await testBound(issuer);
    // prom-client is replaced by mocks in tests (tests/setup.ts): the calls
    // are what is asserted.
    const failures = vi.spyOn(registryStatusListPollFailuresTotal, 'inc');
    const stale = vi.spyOn(registryStatusListsStale, 'set');
    down.add(issuer.host);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    try {
      await reconcileNow();
      expect(failures).toHaveBeenCalledWith({ reason: 'http_status' });
      // The last good read has run out (1 s ttl): the list counts as stale.
      expect(Math.max(...stale.mock.calls.map((args) => Number(args[0])))).toBeGreaterThanOrEqual(1);
    } finally {
      failures.mockRestore();
      stale.mockRestore();
    }
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    expect(await grantStatus(bound.grantId)).toBe('active');
    expect(await feedActions(bound.grantId)).toEqual([]);
    // A refresh of the bound grant fails closed.
    const res = await refresh(bound);
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('status_stale');
  });
});

describePostgres('an accredited issuer is suspended', () => {
  it('suspends every bound grant at the PATCH, and resumes them when the issuer is reinstated', async () => {
    const issuer = await newTestIssuer({ ttl: 3600 });
    const first = await testBound(issuer);
    const second = await testBound(issuer);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', reason: 'accreditation review' });
    for (const bound of [first, second]) {
      expect(await attestationState(bound.registryAttestationId)).toMatchObject({ issuer_status: 'valid', acceptance: 2 });
      expect(await grantStatus(bound.grantId)).toBe('suspended');
      expect(await feedActions(bound.grantId)).toEqual(['suspended']);
    }
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'active', reason: 'review closed' });
    for (const bound of [first, second]) {
      expect(await attestationState(bound.registryAttestationId)).toMatchObject({ acceptance: 0 });
      expect(await grantStatus(bound.grantId)).toBe('active');
    }
  });

  it('cascades a suspension scheduled for later once it takes effect', async () => {
    const issuer = await newTestIssuer({ ttl: 3600 });
    const bound = await testBound(issuer);
    const from = new Date(Date.now() + 1_500).toISOString();
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', effective_from: from, reason: 'scheduled' });
    expect(await grantStatus(bound.grantId)).toBe('active');
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await reconcileNow();
    expect(await grantStatus(bound.grantId)).toBe('suspended');
  });
});

describePostgres('an accredited issuer is reinstated', () => {
  it('keeps the grants suspended until a fresh read, and revokes them if that read says revoked', async () => {
    const issuer = await newTestIssuer();
    const bound = await testBound(issuer);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', reason: 'list unreadable' });
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    // While it is suspended its list cannot be read, and the issuer revokes the passport.
    down.add(issuer.host);
    issuer.entries.set(bound.idx, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();

    // The last read (valid) has run out: the reinstatement is not a reason to trust it.
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'active', reason: 'review closed' });
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 2 });
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    await reconcileNow();
    expect(await attestationState(bound.registryAttestationId)).toMatchObject({ acceptance: 2 });
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    expect(await feedActions(bound.grantId)).toEqual(['suspended']);

    // The first fresh read decides.
    down.delete(issuer.host);
    await reconcileNow();
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'revoked', acceptance: 1 });
    expect(await grantStatus(bound.grantId)).toBe('revoked');
    expect(await feedActions(bound.grantId)).toEqual(['suspended', 'revoked']);
  });

  it('does not act on the list of a suspended issuer, and resumes on the first fresh read after reinstatement', async () => {
    const issuer = await newTestIssuer();
    const bound = await testBound(issuer);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', reason: 'wrong list published' });
    // The wrong list revokes the passport while the issuer is suspended.
    issuer.entries.set(bound.idx, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const key = `/status/${issuer.host}/1`;
    const before = fetches.get(key) ?? 0;
    await reconcileNow();
    expect(fetches.get(key) ?? 0).toBe(before);
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 2 });
    expect(await grantStatus(bound.grantId)).toBe('suspended');

    // The issuer publishes the right list and is reinstated.
    issuer.entries.delete(bound.idx);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'active', reason: 'list corrected' });
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    await reconcileNow();
    expect(fetches.get(key) ?? 0).toBe(before + 1);
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    expect(await grantStatus(bound.grantId)).toBe('active');
    expect(await feedActions(bound.grantId)).toEqual(['suspended', 'resumed']);
  });
});

describePostgres('a read in flight when the operator acts on the issuer', () => {
  async function checkedAt(id: string): Promise<number> {
    const [row] = await sql`SELECT issuer_status_checked_at FROM registry_attestations WHERE id = ${id}`;
    return new Date(row!['issuer_status_checked_at'] as string).getTime();
  }

  it('is discarded when the issuer is suspended while its list is being fetched', async () => {
    const issuer = await newTestIssuer();
    const bound = await testBound(issuer);
    // The faulty list the operator suspends the issuer for revokes the passport.
    issuer.entries.set(bound.idx, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const checked = await checkedAt(bound.registryAttestationId);
    const gate = holdList(issuer);
    const run = reconcileRegistryStatusOnce(sql, undefined, { minIntervalMs: POLL_MS, force: true });
    try {
      await gate.arrived;
      await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', reason: 'wrong list published' });
      expect(await grantStatus(bound.grantId)).toBe('suspended');
    } finally {
      gate.release();
    }
    const result = await run;
    expect(result.outcome).toBe('complete');
    expect(result.flips).toBe(0);
    // Nothing the list said was recorded, not even the attempt, and nothing cascaded.
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 2 });
    expect(await checkedAt(bound.registryAttestationId)).toBe(checked);
    expect(await grantStatus(bound.grantId)).toBe('suspended');
    expect(await feedActions(bound.grantId)).toEqual(['suspended']);
    const changes = await sql`
      SELECT 1 FROM audit_entries
      WHERE developer_id = 'grantex:registry' AND action = 'grantex.registry.attestation_issuer_status_changed'
        AND metadata->>'attestationId' = ${bound.registryAttestationId}`;
    expect(changes).toHaveLength(0);

    // Reinstated with the list corrected, the first fresh read decides.
    issuer.entries.delete(bound.idx);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'active', reason: 'list corrected' });
    await reconcileNow();
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    expect(await grantStatus(bound.grantId)).toBe('active');
  });

  it('is not recorded once the key that signed the list is revoked', async () => {
    const issuer = await newTestIssuer({ ttl: 3600, separateListKey: true });
    const bound = await testBound(issuer);
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { revoke_kids: ['k2'], reason: 'list key compromise' });
    // The attestation was signed with k1, which is still in force.
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    const fresh = () => new Date(Date.now() + 60_000);
    // A read verified with k2 just before the revocation, recorded after it.
    expect(await recordIssuerStatusReads(sql, [{ id: bound.registryAttestationId, value: 1 }],
      fresh(), new Date(), { issuerId: issuer.id, kid: 'k2' })).toBeNull();
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    // A kid the issuer does not have is refused the same way.
    expect(await recordIssuerStatusReads(sql, [{ id: bound.registryAttestationId, value: 1 }],
      fresh(), new Date(), { issuerId: issuer.id, kid: 'k9' })).toBeNull();
    // With k1, still in force, the read is recorded.
    expect(await recordIssuerStatusReads(sql, [{ id: bound.registryAttestationId, value: 2 }],
      fresh(), new Date(), { issuerId: issuer.id, kid: 'k1' }))
      .toEqual([{ id: bound.registryAttestationId, from: 'valid', to: 'suspended' }]);
    expect(await attestationState(bound.registryAttestationId)).toMatchObject({ issuer_status: 'suspended' });
  });
});

describePostgres('resuming what the registry suspended', () => {
  it('is not held up by suspensions that cannot be resumed yet', async () => {
    const stuck = await mockBound();
    const resumable = await mockBound();
    for (const bound of [stuck, resumable]) mockIssuer.suspendPassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await reconcileNow();
    expect(await grantStatus(resumable.grantId)).toBe('suspended');

    // More registry suspensions than one batch, each under a parent grant
    // suspended for another reason, all ordered before the resumable one.
    const parentId = 'grnt_00000000000000000000parent';
    await sql`
      INSERT INTO grants
      SELECT (jsonb_populate_record(NULL::grants, to_jsonb(g) || jsonb_build_object('id', ${parentId}::text, 'status', 'suspended'))).*
      FROM grants g WHERE g.id = ${stuck.grantId}`;
    await sql`UPDATE grants SET parent_grant_id = ${parentId} WHERE id = ${stuck.grantId}`;
    await sql`
      WITH ids AS (SELECT 'grnt_0000000000000000' || lpad(n::text, 6, '0') AS id FROM generate_series(1, 510) n)
      INSERT INTO grants
      SELECT (jsonb_populate_record(NULL::grants, to_jsonb(g) || jsonb_build_object('id', ids.id))).*
      FROM grants g, ids WHERE g.id = ${stuck.grantId}`;
    await sql`
      WITH ids AS (SELECT 'grnt_0000000000000000' || lpad(n::text, 6, '0') AS id FROM generate_series(1, 510) n)
      INSERT INTO grant_passport_bindings
      SELECT (jsonb_populate_record(NULL::grant_passport_bindings, to_jsonb(b) || jsonb_build_object('grant_id', ids.id))).*
      FROM grant_passport_bindings b, ids WHERE b.grant_id = ${stuck.grantId}`;
    await sql`
      INSERT INTO grant_suspensions (grant_id, developer_id, root_grant_id, cause)
      SELECT id, ${stuck.agent.tenant.id}, id, 'registry' FROM grants
      WHERE id LIKE 'grnt_0000000000000000%' AND id <> ${parentId}`;

    for (const bound of [stuck, resumable]) mockIssuer.reinstatePassport(bound.attestationId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const result = await reconcileNow();
    expect(await attestationState(resumable.registryAttestationId)).toMatchObject({ acceptance: 0 });
    expect(await grantStatus(resumable.grantId)).toBe('active');
    expect(result.grantsResumed).toBeGreaterThanOrEqual(1);
    // The suspensions under a suspended parent stay until the parent is active.
    expect(await grantStatus(stuck.grantId)).toBe('suspended');
    const [left] = await sql`SELECT COUNT(*)::int AS n FROM grant_suspensions WHERE root_grant_id LIKE 'grnt_0000000000000000%'`;
    expect(left!['n']).toBe(510);
  });
});

describePostgres('an issuer key is revoked', () => {
  it('withdraws every attestation signed with that kid and revokes the bound grants', async () => {
    const issuer = await newTestIssuer({ ttl: 3600 });
    const bound = await testBound(issuer);
    const replacement = await newKey();
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, {
      jwks: { keys: [{ ...replacement.jwk, kid: 'k2', alg: 'ES256', use: 'sig' }] },
      revoke_kids: ['k1'],
      reason: 'key compromise',
    });
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'withdrawn', issuer_status: 'valid', acceptance: 1 });
    expect(await grantStatus(bound.grantId)).toBe('revoked');
    expect(await feedActions(bound.grantId)).toEqual(['revoked']);
    const [audit] = await sql`
      SELECT metadata FROM audit_entries
      WHERE developer_id = 'grantex:registry' AND action = 'grantex.registry.attestation_withdrawn'
        AND metadata->>'attestationId' = ${bound.registryAttestationId}`;
    expect(audit?.['metadata']).toMatchObject({ requestedBy: 'registry:key_revoked', kid: 'k1' });
  });

  it('withdraws, on the next tick, what a key revoked days ago while reconciliation was off still has accepted', async () => {
    const issuer = await newTestIssuer({ ttl: 3600 });
    const bound = await testBound(issuer);
    vi.stubEnv('REGISTRY_STATUS_RECONCILIATION_ENABLED', 'false');
    const replacement = await newKey();
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, {
      jwks: { keys: [{ ...replacement.jwk, kid: 'k2', alg: 'ES256', use: 'sig' }] },
      revoke_kids: ['k1'],
      reason: 'key compromise',
    });
    await sql`
      UPDATE accredited_issuer_revoked_keys SET revoked_at = NOW() - INTERVAL '3 days'
      WHERE issuer_id = ${issuer.id} AND kid = 'k1'`;
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'accepted', issuer_status: 'valid', acceptance: 0 });
    expect(await grantStatus(bound.grantId)).toBe('active');

    vi.stubEnv('REGISTRY_STATUS_RECONCILIATION_ENABLED', 'true');
    const result = await reconcileNow();
    expect(result.attestationsWithdrawn).toBeGreaterThanOrEqual(1);
    expect(await attestationState(bound.registryAttestationId)).toEqual({ state: 'withdrawn', issuer_status: 'valid', acceptance: 1 });
    expect(await grantStatus(bound.grantId)).toBe('revoked');
    expect(await feedActions(bound.grantId)).toEqual(['revoked']);
  });
});

describePostgres('polling', () => {
  it('fetches each list once per interval, however many attestations it serves', async () => {
    const issuer = await newTestIssuer();
    await testBound(issuer);
    await testBound(issuer);
    await testBound(issuer);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const key = `/status/${issuer.host}/1`;
    const before = fetches.get(key) ?? 0;
    const polls = vi.spyOn(registryStatusListPollsTotal, 'inc');
    try {
      await reconcileNow();
      expect((fetches.get(key) ?? 0) - before).toBe(1);
      expect(polls).toHaveBeenCalledWith({ outcome: 'ok' });
      // Within the interval the list is not fetched again.
      await reconcileRegistryStatusOnce(sql, undefined, { minIntervalMs: POLL_MS });
      expect((fetches.get(key) ?? 0) - before).toBe(1);
    } finally {
      polls.mockRestore();
    }
  });

  it('runs on one instance at a time', async () => {
    const holder = await sql.reserve();
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${RECONCILIATION_LOCK_KEY}, 0))`;
      const result = await reconcileRegistryStatusOnce(sql, undefined, { minIntervalMs: POLL_MS, force: true });
      expect(result.outcome).toBe('skipped_locked');
      expect(result.listsPolled).toBe(0);
    } finally {
      await holder`SELECT pg_advisory_unlock(hashtextextended(${RECONCILIATION_LOCK_KEY}, 0))`;
      holder.release();
    }
  });

  it('does nothing with the flag off', async () => {
    vi.stubEnv('REGISTRY_STATUS_RECONCILIATION_ENABLED', 'false');
    const result = await reconcileRegistryStatusOnce(sql, undefined, { minIntervalMs: POLL_MS, force: true });
    expect(result.outcome).toBe('disabled');
  });

  it('leaves the issuer PATCH without a cascade when the flag is off', async () => {
    const issuer = await newTestIssuer({ ttl: 3600 });
    const bound = await testBound(issuer);
    vi.stubEnv('REGISTRY_STATUS_RECONCILIATION_ENABLED', 'false');
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { status: 'suspended', reason: 'accreditation review' });
    expect(await grantStatus(bound.grantId)).toBe('active');
    expect(await attestationState(bound.registryAttestationId)).toMatchObject({ acceptance: 0 });
  });
});

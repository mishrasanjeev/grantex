// SPDX-License-Identifier: Apache-2.0
/**
 * Attestation ingestion, withdrawal and refresh against real Postgres,
 * through the routes, with accredited issuers served by a fake issuer on
 * 127.0.0.1 behind REGISTRY_DEV_ISSUER_ORIGIN_MAP.
 *
 * Covered: migration 124; every refusal of POST /v1/registry/attestations
 * with its Appendix C code, in the documented order; possession before
 * attestation; the hash rule; the issuer's Token Status List check (a list
 * outside status_list_base, unreachable, stale, signed by another key, or
 * showing the entry INVALID or SUSPENDED); idempotent replays and conflicting
 * bytes; withdrawal and refresh, authenticated by the issuer's signed request
 * or by the registry operator; the computed trust level through
 * basic -> verified -> attested -> attested_verified and back to basic on a
 * suspension anywhere in the chain; an issuer status read that has gone
 * stale, and the worker that rereads it; the flags; and computeAgentTrust by DID
 * and by key thumbprint. The SQL mock forwards to a database of this file's
 * own, so triggers, the acceptance lists and the audit chain are the
 * production ones.
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
import type { AppLogger } from '../src/lib/logger.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { acceptanceListIdFromUri, setAcceptance } from '../src/lib/registry/acceptance-status.js';
import { ATTESTATION_REQUEST_TYP, ATTESTATION_TYP } from '../src/lib/registry/attestation-jws.js';
import { recheckIssuerStatus } from '../src/lib/registry/attestations.js';
import { REGISTRY_AUDIT_CHAIN } from '../src/lib/registry/issuers.js';
import { REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV } from '../src/lib/registry/issuer-fetcher.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { computeAgentTrust, computeProviderTrust } from '../src/lib/registry/trust-level.js';
import { recheckIssuerStatusesOnce } from '../src/workers/registryIssuerStatusRecheck.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres attestation tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const DAY_S = 86_400;
const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const AGENT_SECURITY = 'urn:grantex:tm:agent.security';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; thumbprint: string }
/** How the fake issuer answers for its status list. */
type Serve = 'ok' | 'down' | 'stale' | 'wrong_key' | 'redirect';
interface Issuer {
  host: string;
  entityId: string;
  id: string;
  key: Key;
  otherKey: Key;
  statusListUri: string;
  entries: Map<number, number>;
  serve: Serve;
}
interface Tenant { id: string; apiKey: string }
interface Provider { id: string; did: string; domain: string; tenant: Tenant }
interface Agent { id: string; did: string; key: Key }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let issuerServer: Server;
let issuerPort = 0;
const issuers = new Map<string, Issuer>();
const operatorKey = randomBytes(32).toString('hex');
let addressCounter = 0;
let idxCounter = 0;

/** A logger for the recheck worker that keeps its expected warnings out of the test output. */
const quiet: AppLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, fatal: () => {}, child: () => quiet,
};

function nextAddress(): string {
  addressCounter += 1;
  return `203.0.113.${(addressCounter % 250) + 1}`;
}

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, thumbprint: jwkThumbprint(jwk) };
}

/** A Token Status List of 2-bit entries (draft-ietf-oauth-status-list-21 §4.1). */
function encodeList(entries: Map<number, number>, size = 1024): string {
  const bytes = Buffer.alloc(size / 4);
  for (const [idx, value] of entries) bytes[Math.floor(idx / 4)]! |= value << ((idx % 4) * 2);
  return deflateSync(bytes).toString('base64url');
}

async function issuerStatusList(issuer: Issuer): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signer = issuer.serve === 'wrong_key' ? issuer.otherKey : issuer.key;
  return new CompactSign(new TextEncoder().encode(JSON.stringify({
    sub: issuer.statusListUri,
    iat: issuer.serve === 'stale' ? now - 7200 : now - 5,
    exp: issuer.serve === 'stale' ? now - 3600 : now + 3600,
    ttl: 300,
    status_list: { bits: 2, lst: encodeList(issuer.entries) },
  }))).setProtectedHeader({ typ: 'statuslist+jwt', alg: 'ES256', kid: 'k1' }).sign(signer.privateKey);
}

function originMap(): string {
  return [...issuers.values()].map((issuer) => `https://${issuer.host}=http://127.0.0.1:${issuerPort}`).join(',');
}

async function operator(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method, url, headers: { authorization: `Bearer ${operatorKey}` }, payload, remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json<Record<string, unknown>>();
}

async function newIssuer(options: { host?: string; trustMarks?: string[] } = {}): Promise<Issuer> {
  const host = options.host ?? `issuer-${randomBytes(4).toString('hex')}.example`;
  const key = await newKey();
  const record = await operator('POST', '/v1/registry/issuers', {
    entity_id: `https://${host}`,
    jwks: { keys: [{ ...key.jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] },
    trust_marks: options.trustMarks ?? [PROVIDER_ENTITY, AGENT_IDENTITY, AGENT_SECURITY],
    status_list_base: `https://${host}/status/`,
    accreditation_evidence_ref: `accreditation-case-${host}`,
  });
  const issuer: Issuer = {
    host,
    entityId: `https://${host}`,
    id: record['id'] as string,
    key,
    otherKey: await newKey(),
    statusListUri: `https://${host}/status/${host}/1`,
    entries: new Map(),
    serve: 'ok',
  };
  issuers.set(host, issuer);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  return issuer;
}

async function newTenant(): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_att_${suffix}`, apiKey: `gx_test_att_${suffix}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Attestation Test', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method, url, remoteAddress: nextAddress(), headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function newProvider(options: { verified?: boolean; domain?: string } = {}): Promise<Provider> {
  const tenant = await newTenant();
  const domain = options.domain ?? `provider-${randomBytes(4).toString('hex')}.example`;
  const id = `treg_${randomBytes(8).toString('hex')}`;
  await sql`
    INSERT INTO trust_registry (id, organization_did, domain, developer_id, name, trust_level, verification_method, verified_at)
    VALUES (${id}, ${`did:web:${domain}`}, ${domain}, ${tenant.id}, 'Provider', 'basic', 'pending', NULL)`;
  const provider = { id, did: `did:web:${domain}`, domain, tenant };
  if (options.verified) await verifyDns(provider);
  return provider;
}

/** What POST /v1/registry/orgs/:orgId/verify-dns writes once the TXT record matches. */
async function verifyDns(provider: Provider): Promise<void> {
  await sql`UPDATE trust_registry SET verification_method = 'dns-txt', trust_level = 'verified', verified_at = NOW(),
            verification_token_hash = NULL, updated_at = NOW() WHERE id = ${provider.id}`;
}

async function addKey(provider: Provider, agentId: string, key: Key) {
  const res = await call(provider.tenant, 'POST', `/v1/agents/${agentId}/keys`, { publicJwk: key.jwk });
  expect(res.statusCode, res.body).toBe(201);
}

async function proveKey(provider: Provider, agentId: string, key: Key) {
  const issued = await call(provider.tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/challenge`);
  expect(issued.statusCode, issued.body).toBe(201);
  const proof = await new SignJWT({ nonce: issued.json<{ challenge: string }>().challenge, sub: agentId })
    .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(AUDIENCE).setIssuedAt().sign(key.privateKey);
  const proved = await call(provider.tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/prove`, { proof });
  expect(proved.statusCode, proved.body).toBe(200);
}

async function newAgent(provider: Provider, options: { prove?: boolean } = {}): Promise<Agent> {
  const created = await call(provider.tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4', scopes: ['read'] });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ agentId: string }>().agentId;
  const [row] = await sql`SELECT did FROM agents WHERE id = ${id}`;
  const key = await newKey();
  await addKey(provider, id, key);
  if (options.prove !== false) await proveKey(provider, id, key);
  return { id, did: row!['did'] as string, key };
}

function nextIdx(): number {
  idxCounter += 1;
  return idxCounter;
}

interface AttestOptions {
  issuer: Issuer;
  sub: string;
  type?: string;
  keyThumbprint?: string | null;
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signWith?: CryptoKey;
}

async function attest(options: AttestOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const type = options.type ?? AGENT_IDENTITY;
  const body: Record<string, unknown> = {
    iss: options.issuer.entityId,
    id: `att-${randomBytes(6).toString('hex')}`,
    sub: options.sub,
    type,
    iat: now - 60,
    exp: now + 180 * DAY_S,
    external_credential_id: `case-${randomBytes(4).toString('hex')}`,
    external_credential_hash: `sha-256:${randomBytes(32).toString('base64url')}`,
    level: 'substantial',
    status: { status_list: { uri: options.issuer.statusListUri, idx: nextIdx() } },
    ...(type.startsWith('urn:grantex:tm:agent.') && options.keyThumbprint !== null
      ? { key_thumbprint: options.keyThumbprint } : {}),
    ...options.claims,
  };
  for (const [name, value] of Object.entries(body)) if (value === undefined) delete body[name];
  return new CompactSign(new TextEncoder().encode(JSON.stringify(body)))
    .setProtectedHeader((options.header ?? { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' }) as never)
    .sign(options.signWith ?? options.issuer.key.privateKey);
}

async function post(compact: string, address = nextAddress()) {
  return app.inject({
    method: 'POST', url: '/v1/registry/attestations', payload: compact,
    headers: { 'content-type': 'application/jwt' }, remoteAddress: address,
  });
}

async function accepted(compact: string): Promise<Record<string, unknown>> {
  const res = await post(compact);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Record<string, unknown>>();
}

function expectRefusal(res: { statusCode: number; body: string; json: <T>() => T }, status: number, code: string, reason?: string) {
  expect(res.statusCode, res.body).toBe(status);
  const body = res.json<Record<string, unknown>>();
  expect(body['code']).toBe(code);
  if (reason !== undefined) expect(body['reason']).toBe(reason);
}

async function issuerRequest(issuer: Issuer, attestationId: string, action: 'withdraw' | 'refresh', overrides: Record<string, unknown> = {}) {
  return new CompactSign(new TextEncoder().encode(JSON.stringify({
    iss: issuer.entityId, aud: AUDIENCE, id: attestationId, action,
    iat: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('base64url'), ...overrides,
  }))).setProtectedHeader({ typ: ATTESTATION_REQUEST_TYP, alg: 'ES256', kid: 'k1' }).sign(issuer.key.privateKey);
}

async function withdraw(id: string, authorization: string | undefined) {
  return app.inject({
    method: 'DELETE', url: `/v1/registry/attestations/${id}`, remoteAddress: nextAddress(),
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function refresh(id: string, compact: string, authorization: string) {
  return app.inject({
    method: 'POST', url: `/v1/registry/attestations/${id}/refresh`, payload: compact, remoteAddress: nextAddress(),
    headers: { authorization, 'content-type': 'application/jwt' },
  });
}

/** An agent with a proven key, its provider, and an issuer accredited for both. */
async function attestedSetup(options: { verified?: boolean } = {}) {
  const issuer = await newIssuer();
  const provider = await newProvider({ verified: options.verified === true });
  const agent = await newAgent(provider);
  const providerAttestation = await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
  const agentAttestation = await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint }));
  return { issuer, provider, agent, providerAttestation, agentAttestation };
}

async function level(agent: Agent): Promise<string | undefined> {
  return (await computeAgentTrust(sql, agent.did))?.level;
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('attestations');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  issuerServer = createServer((req, res) => {
    const match = /^\/status\/([^/]+)\/1$/.exec(req.url ?? '');
    const issuer = match ? issuers.get(match[1]!) : undefined;
    if (!issuer || issuer.serve === 'down') {
      res.writeHead(503);
      res.end();
      return;
    }
    if (issuer.serve === 'redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${issuerPort}${req.url}` });
      res.end();
      return;
    }
    void issuerStatusList(issuer).then((token) => {
      res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
      res.end(token);
    });
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  issuerPort = (issuerServer.address() as AddressInfo).port;
  app = await buildTestApp();
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (issuerServer) await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  if (!adminDatabaseUrl) return;
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  vi.stubEnv(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV, originMap());
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('migration 124', () => {
  it('is recorded in the ledger and adds the attestation store and the level columns', async () => {
    const ledger = await sql`SELECT filename FROM schema_migrations WHERE filename = '124_registry_attestations.sql'`;
    expect(ledger).toHaveLength(1);
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('registry_attestations', 'trust_registry', 'agents')`;
    const names = (table: string) => columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    expect(names('registry_attestations')).toEqual(expect.arrayContaining([
      'issuer_entity_id', 'attestation_id', 'jws', 'received_at', 'sub', 'type', 'key_thumbprint',
      'external_credential_id', 'external_credential_hash', 'level', 'declared_limits', 'iat', 'exp',
      'status_list_uri', 'status_list_idx', 'acceptance_list_uri', 'acceptance_list_idx', 'state', 'issuer_status',
      'issuer_status_checked_at', 'issuer_status_fresh_until', 'created_at', 'updated_at',
    ]));
    expect(names('trust_registry')).toEqual(expect.arrayContaining(['legal_identifiers', 'computed_trust_level', 'computed_attested', 'suspended_at']));
    expect(names('agents')).toEqual(expect.arrayContaining([
      'cimd_uri', 'declared_purpose', 'declared_categories', 'declared_scopes', 'declared_autonomy', 'declared_limits',
    ]));
  });

  it('allows only the four computed levels and keeps trust_level free text for its readers', async () => {
    const provider = await newProvider();
    const [constraint] = await sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'chk_trust_registry_computed_trust_level'`;
    expect(constraint!['def']).toMatch(/basic.*verified.*attested.*attested_verified/);
    // The trigger derives the value, so no write can store anything else.
    await sql`UPDATE trust_registry SET computed_trust_level = 'extended' WHERE id = ${provider.id}`;
    await sql`UPDATE trust_registry SET trust_level = 'extended' WHERE id = ${provider.id}`;
    const [row] = await sql`SELECT trust_level, computed_trust_level FROM trust_registry WHERE id = ${provider.id}`;
    expect(row).toEqual({ trust_level: 'extended', computed_trust_level: 'basic' });
  });

  it('follows DNS verification into computed_trust_level', async () => {
    const provider = await newProvider();
    await verifyDns(provider);
    const [row] = await sql`SELECT trust_level, computed_trust_level FROM trust_registry WHERE id = ${provider.id}`;
    expect(row).toEqual({ trust_level: 'verified', computed_trust_level: 'verified' });
  });

  it('keeps the attested half of the stored level across a provider suspension and its lifting', async () => {
    const { provider } = await attestedSetup();
    const read = async () => (await sql`SELECT computed_trust_level FROM trust_registry WHERE id = ${provider.id}`)[0]!['computed_trust_level'];
    expect(await read()).toBe('attested');
    await sql`UPDATE trust_registry SET suspended_at = NOW() - INTERVAL '1 minute' WHERE id = ${provider.id}`;
    expect(await read()).toBe('basic');
    await sql`UPDATE trust_registry SET suspended_at = NULL WHERE id = ${provider.id}`;
    expect(await read()).toBe('attested');
    await verifyDns(provider);
    expect(await read()).toBe('attested_verified');
  });

  it('refuses an attestation state or issuer status outside the enumeration', async () => {
    const { agentAttestation } = await attestedSetup();
    await expect(sql`UPDATE registry_attestations SET state = 'revoked' WHERE id = ${agentAttestation['id'] as string}`).rejects.toThrow(/check/i);
    await expect(sql`UPDATE registry_attestations SET issuer_status = 'withdrawn' WHERE id = ${agentAttestation['id'] as string}`).rejects.toThrow(/check/i);
  });
});

describePostgres('POST /v1/registry/attestations: accepted', () => {
  it('stores the JWS as received, allocates a VALID acceptance entry and audits it', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    const compact = await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint, claims: { declared_limits: { max_amount: '250.00' } } });
    const before = Date.now();
    const body = await accepted(compact);
    expect(body).toMatchObject({
      iss: issuer.entityId, sub: agent.did, type: AGENT_IDENTITY, level: 'substantial',
      key_thumbprint: agent.key.thumbprint, declared_limits: { max_amount: '250.00' },
      state: 'accepted', issuer_status: 'valid',
      status: { status_list: { uri: issuer.statusListUri } },
    });
    expect(body['id']).toMatch(/^ratt_[0-9A-HJKMNP-TV-Z]{26}$/);
    const [row] = await sql`SELECT * FROM registry_attestations WHERE id = ${body['id'] as string}`;
    expect(row!['jws']).toBe(compact);
    expect((row!['received_at'] as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const acceptance = body['acceptance'] as { status_list: { uri: string; idx: number } };
    expect(acceptance.status_list.uri).toBe(row!['acceptance_list_uri']);
    const [entry] = await sql`SELECT status FROM registry_acceptance_entries
      WHERE list_id = ${acceptanceListIdFromUri(acceptance.status_list.uri)} AND idx = ${acceptance.status_list.idx}`;
    expect(entry!['status']).toBe(0);
    const audit = await sql`SELECT action, metadata FROM audit_entries
      WHERE developer_id = ${REGISTRY_AUDIT_CHAIN} AND action = 'grantex.registry.attestation_accepted'
        AND metadata->>'attestationId' = ${body['id'] as string}`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!['metadata'])).not.toContain(compact);
  });

  it('records until when the issuer status it read stays fresh: the list\'s ttl from the time of reading', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const before = Date.now();
    const body = await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    const after = Date.now();
    const [row] = await sql`SELECT issuer_status_fresh_until FROM registry_attestations WHERE id = ${body['id'] as string}`;
    const freshUntil = (row!['issuer_status_fresh_until'] as Date).getTime();
    // The fake issuer's list has exp an hour away and ttl 300 seconds.
    expect(freshUntil).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 300_000);
    expect(freshUntil).toBeLessThanOrEqual(after + 300_000);
  });

  it('accepts from https://mock-issuer.example through the origin map, with its https status list URI kept', async () => {
    const issuer = issuers.get('mock-issuer.example') ?? await newIssuer({ host: 'mock-issuer.example' });
    const provider = await newProvider();
    const body = await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    expect((body['status'] as { status_list: { uri: string } }).status_list.uri).toMatch(/^https:\/\/mock-issuer\.example\/status\//);
  });

  it('answers a replay of the same bytes with the same record, and different bytes for the same id with 409', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const compact = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { id: 'att-replay-1' } });
    const first = await accepted(compact);
    const again = await post(compact);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<Record<string, unknown>>()['id']).toBe(first['id']);
    const other = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { id: 'att-replay-1', level: 'high' } });
    expectRefusal(await post(other), 409, 'attestation_conflict');
    const [count] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM registry_attestations WHERE attestation_id = 'att-replay-1'`;
    expect(count!.n).toBe(1);
  });

  it('answers a replay of the same bytes without verifying again, even while the issuer\'s list cannot be read', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const compact = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY });
    const first = await accepted(compact);
    issuer.serve = 'down';
    try {
      const again = await post(compact);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json<Record<string, unknown>>()['id']).toBe(first['id']);
      // Other bytes are verified in full, and refused while the list is unreadable.
      expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY })), 503, 'status_stale');
    } finally {
      issuer.serve = 'ok';
    }
  });

  it('lets two issuers use the same id', async () => {
    const provider = await newProvider();
    const a = await newIssuer();
    const b = await newIssuer();
    await accepted(await attest({ issuer: a, sub: provider.did, type: PROVIDER_ENTITY, claims: { id: 'att-shared' } }));
    await accepted(await attest({ issuer: b, sub: provider.did, type: PROVIDER_ENTITY, claims: { id: 'att-shared' } }));
  });
});

describePostgres('POST /v1/registry/attestations: refusals (Appendix C)', () => {
  it('refuses what is not a compact JWS, and a wrong typ, alg or missing kid', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    expectRefusal(await post('not-a-jws'), 400, 'attestation_malformed');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, header: { typ: 'JWT', alg: 'ES256', kid: 'k1' } })),
      400, 'attestation_malformed', 'wrong_typ');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, header: { typ: ATTESTATION_TYP, alg: 'ES256' } })),
      400, 'attestation_malformed', 'kid_missing');
    const hs = await new CompactSign(new TextEncoder().encode('{}'))
      .setProtectedHeader({ typ: ATTESTATION_TYP, alg: 'HS256', kid: 'k1' }).sign(randomBytes(32));
    expectRefusal(await post(hs), 400, 'attestation_malformed', 'alg_not_allowed');
  });

  it('refuses a body sent as JSON rather than application/jwt', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/registry/attestations', payload: { jws: 'a.b.c' }, remoteAddress: nextAddress() });
    expect(res.statusCode).toBe(415);
  });

  it('refuses an issuer the registry does not know, a withdrawn one, a suspended one and a missing trust mark', async () => {
    const provider = await newProvider();
    const stranger: Issuer = { ...(await newIssuer()), entityId: 'https://unknown-issuer.example' };
    expectRefusal(await post(await attest({ issuer: stranger, sub: provider.did, type: PROVIDER_ENTITY })), 403, 'issuer_not_accredited');

    const withdrawn = await newIssuer();
    await operator('PATCH', `/v1/registry/issuers/${withdrawn.id}`, { status: 'withdrawn', reason: 'test' });
    expectRefusal(await post(await attest({ issuer: withdrawn, sub: provider.did, type: PROVIDER_ENTITY })), 403, 'issuer_not_accredited');

    const suspended = await newIssuer();
    await operator('PATCH', `/v1/registry/issuers/${suspended.id}`, { status: 'suspended', reason: 'test' });
    expectRefusal(await post(await attest({ issuer: suspended, sub: provider.did, type: PROVIDER_ENTITY })), 403, 'issuer_suspended');

    const narrow = await newIssuer({ trustMarks: [AGENT_IDENTITY] });
    expectRefusal(await post(await attest({ issuer: narrow, sub: provider.did, type: PROVIDER_ENTITY })), 403, 'trust_mark_missing');
  });

  it('refuses a signature that is not by a current key of the issuer', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, signWith: issuer.otherKey.privateKey })),
      401, 'passport_invalid_signature');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, header: { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k9' } })),
      401, 'passport_invalid_signature');
    await operator('PATCH', `/v1/registry/issuers/${issuer.id}`, { revoke_kids: ['k1'], reason: 'key exposed' });
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY })), 401, 'passport_invalid_signature');
  });

  it('refuses a payload member of the wrong type after the signature is checked', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { level: 3 } })),
      400, 'attestation_malformed', 'bad_claim');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { provider_screening: 'hit' } })),
      400, 'attestation_malformed', 'unknown_member');
  });

  it('refuses a subject that is not registered, or of the wrong kind for the type', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    expectRefusal(await post(await attest({ issuer, sub: 'did:web:nobody.example', type: PROVIDER_ENTITY })),
      422, 'attestation_mismatch', 'subject_not_registered');
    expectRefusal(await post(await attest({ issuer, sub: 'did:grantex:ag_UNKNOWN', keyThumbprint: agent.key.thumbprint })),
      422, 'attestation_mismatch', 'subject_not_registered');
    expectRefusal(await post(await attest({ issuer, sub: agent.did, type: PROVIDER_ENTITY })),
      422, 'attestation_mismatch', 'subject_not_registered');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, keyThumbprint: agent.key.thumbprint })),
      422, 'attestation_mismatch', 'subject_not_registered');
  });

  it('refuses an attestation before the agent has proven possession of the key, and accepts it after', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider, { prove: false });
    expectRefusal(await post(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint })), 422, 'key_unproven');
    await proveKey(provider, agent.id, agent.key);
    await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint }));
  });

  it('refuses a key the agent does not hold, and a key held by another agent, as key_unproven', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    const other = await newAgent(provider);
    expectRefusal(await post(await attest({ issuer, sub: agent.did, keyThumbprint: (await newKey()).thumbprint })), 422, 'key_unproven');
    expectRefusal(await post(await attest({ issuer, sub: agent.did, keyThumbprint: other.key.thumbprint })), 422, 'key_unproven');
  });

  it('refuses a compromised key, and a rotated key past its overlap, as key_not_active', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    const res = await call(provider.tenant, 'POST', `/v1/agents/${agent.id}/keys/${agent.key.thumbprint}/compromise`, { reason: 'device lost' });
    expect(res.statusCode, res.body).toBe(200);
    expectRefusal(await post(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint })), 422, 'key_not_active');

    const rotated = await newAgent(provider);
    await sql`UPDATE agent_keys SET status = 'rotated', valid_to = NOW() - INTERVAL '1 minute' WHERE thumbprint = ${rotated.key.thumbprint}`;
    expectRefusal(await post(await attest({ issuer, sub: rotated.did, keyThumbprint: rotated.key.thumbprint })), 422, 'key_not_active');
  });

  it('refuses an external_credential_hash that is not sha-256:<43 base64url characters>', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    for (const hash of [`sha-256:${'ab'.repeat(32)}`, `sha-256:${randomBytes(32).toString('base64')}`, 'sha-256:']) {
      expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { external_credential_hash: hash } })),
        400, 'attestation_hash_mismatch');
    }
  });

  it('refuses an expired attestation, one whose exp is not after iat, and one issued in the future', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const now = Math.floor(Date.now() / 1000);
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { iat: now - 100, exp: now - 10 } })),
      422, 'passport_expired', 'expired');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { iat: now, exp: now } })),
      422, 'passport_expired', 'exp_not_after_iat');
    expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { iat: now + 600, exp: now + DAY_S } })),
      422, 'passport_expired', 'not_yet_valid');
  });

  it('refuses a status list outside the issuer\'s status_list_base, and one it cannot read or trust', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const outside = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY,
      claims: { status: { status_list: { uri: `https://${issuer.host}/status-other/1`, idx: 1 } } } });
    expectRefusal(await post(outside), 503, 'status_stale', 'status_list_not_under_base');
    const otherHost = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY,
      claims: { status: { status_list: { uri: 'https://mock-issuer.example/status/mock-issuer.example/1', idx: 1 } } } });
    expectRefusal(await post(otherHost), 503, 'status_stale', 'status_list_not_under_base');

    for (const [serve, reason] of [['down', 'unreachable'], ['redirect', 'unreachable'], ['stale', 'expired'], ['wrong_key', 'signature']] as const) {
      issuer.serve = serve;
      expectRefusal(await post(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY })), 503, 'status_stale', reason);
    }
    issuer.serve = 'ok';
  });

  it('refuses an attestation its issuer\'s list shows INVALID or SUSPENDED with passport_revoked', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    for (const [value, reason] of [[1, 'invalid'], [2, 'suspended']] as const) {
      const idx = nextIdx();
      issuer.entries.set(idx, value);
      const compact = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY,
        claims: { status: { status_list: { uri: issuer.statusListUri, idx } } } });
      expectRefusal(await post(compact), 422, 'passport_revoked', reason);
    }
  });

  it('refuses in the documented order: a bad signature before a bad payload, an unknown subject before an unproven key', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const badBoth = await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY, claims: { level: 3 }, signWith: issuer.otherKey.privateKey });
    expectRefusal(await post(badBoth), 401, 'passport_invalid_signature');
    const noSubject = await attest({ issuer, sub: 'did:grantex:ag_NOBODY', keyThumbprint: (await newKey()).thumbprint,
      claims: { external_credential_hash: 'sha-256:x' } });
    expectRefusal(await post(noSubject), 422, 'attestation_mismatch');
  });

  it('is limited per client address', async () => {
    const address = '192.0.2.77';
    let last = 0;
    for (let i = 0; i < 31; i += 1) last = (await post('x', address)).statusCode;
    expect(last).toBe(429);
  });
});

describePostgres('withdrawal and refresh', () => {
  it('withdraws on the issuer\'s signed request: the acceptance entry goes INVALID and the nonce cannot be replayed', async () => {
    const { issuer, agent, agentAttestation } = await attestedSetup();
    expect(await level(agent)).toBe('attested');
    const request = await issuerRequest(issuer, agentAttestation['attestation_id'] as string, 'withdraw');
    const res = await withdraw(agentAttestation['id'] as string, `GrantexIssuer ${request}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Record<string, unknown>>()).toMatchObject({ state: 'withdrawn' });
    const acceptance = agentAttestation['acceptance'] as { status_list: { uri: string; idx: number } };
    const [entry] = await sql`SELECT status FROM registry_acceptance_entries
      WHERE list_id = ${acceptanceListIdFromUri(acceptance.status_list.uri)} AND idx = ${acceptance.status_list.idx}`;
    expect(entry!['status']).toBe(1);
    expect(await level(agent)).toBe('basic');
    expectRefusal(await withdraw(agentAttestation['id'] as string, `GrantexIssuer ${request}`), 401, 'request_signature_invalid', 'replay');
    const audit = await sql`SELECT 1 FROM audit_entries WHERE developer_id = ${REGISTRY_AUDIT_CHAIN}
      AND action = 'grantex.registry.attestation_withdrawn' AND metadata->>'attestationId' = ${agentAttestation['id'] as string}`;
    expect(audit).toHaveLength(1);
  });

  it('withdraws with the registry operator key', async () => {
    const { providerAttestation } = await attestedSetup();
    const res = await withdraw(providerAttestation['id'] as string, `Bearer ${operatorKey}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<Record<string, unknown>>()['state']).toBe('withdrawn');
  });

  it('refuses a withdrawal without credentials, with a wrong operator key, or signed for another attestation or by another issuer', async () => {
    const { issuer, providerAttestation, agentAttestation } = await attestedSetup();
    const id = providerAttestation['id'] as string;
    expectRefusal(await withdraw(id, undefined), 401, 'request_signature_invalid');
    expectRefusal(await withdraw(id, `Bearer ${randomBytes(32).toString('hex')}`), 401, 'request_signature_invalid');
    expectRefusal(await withdraw(id, `GrantexIssuer ${await issuerRequest(issuer, agentAttestation['attestation_id'] as string, 'withdraw')}`),
      422, 'attestation_mismatch');
    const other = await newIssuer();
    expectRefusal(await withdraw(id, `GrantexIssuer ${await issuerRequest(other, providerAttestation['attestation_id'] as string, 'withdraw')}`),
      422, 'attestation_mismatch');
    expectRefusal(await withdraw(id, `GrantexIssuer ${await issuerRequest(issuer, providerAttestation['attestation_id'] as string, 'refresh')}`),
      401, 'request_signature_invalid');
    expectRefusal(await withdraw('ratt_01J8Z3K4M5N6P7Q8R9S0T1V2W3', `Bearer ${operatorKey}`), 404, 'attestation_not_registered');
  });

  it('refreshes with a new external credential: the old record is superseded and its acceptance entry INVALID', async () => {
    const { issuer, agent, agentAttestation } = await attestedSetup();
    const compact = await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint, claims: { declared_limits: { max_amount: '500.00' } } });
    const res = await refresh(agentAttestation['id'] as string, compact,
      `GrantexIssuer ${await issuerRequest(issuer, agentAttestation['attestation_id'] as string, 'refresh')}`);
    expect(res.statusCode, res.body).toBe(201);
    const fresh = res.json<Record<string, unknown>>();
    expect(fresh).toMatchObject({ state: 'accepted', supersedes: agentAttestation['id'] });
    const [old] = await sql`SELECT state, superseded_by FROM registry_attestations WHERE id = ${agentAttestation['id'] as string}`;
    expect(old).toEqual({ state: 'superseded', superseded_by: fresh['id'] });
    const acceptance = agentAttestation['acceptance'] as { status_list: { uri: string; idx: number } };
    const [entry] = await sql`SELECT status FROM registry_acceptance_entries
      WHERE list_id = ${acceptanceListIdFromUri(acceptance.status_list.uri)} AND idx = ${acceptance.status_list.idx}`;
    expect(entry!['status']).toBe(1);
    expect(await level(agent)).toBe('attested');
  });

  it('refreshes with the operator key, and refuses a refresh that keeps the credential, changes the subject or type, or follows a withdrawal', async () => {
    const { issuer, provider, agent, agentAttestation, providerAttestation } = await attestedSetup();
    const id = agentAttestation['id'] as string;
    const same = await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint,
      claims: { external_credential_id: agentAttestation['external_credential_id'] } });
    expectRefusal(await refresh(id, same, `Bearer ${operatorKey}`), 422, 'attestation_mismatch', 'same_external_credential');
    expectRefusal(await refresh(id, await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }), `Bearer ${operatorKey}`),
      422, 'attestation_mismatch');
    expectRefusal(await refresh(id, await attest({ issuer, sub: agent.did, type: AGENT_SECURITY, keyThumbprint: agent.key.thumbprint }), `Bearer ${operatorKey}`),
      422, 'attestation_mismatch');
    const ok = await refresh(id, await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint }), `Bearer ${operatorKey}`);
    expect(ok.statusCode, ok.body).toBe(201);
    expectRefusal(await refresh(id, await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint }), `Bearer ${operatorKey}`),
      409, 'attestation_not_accepted');

    await withdraw(providerAttestation['id'] as string, `Bearer ${operatorKey}`);
    expectRefusal(await refresh(providerAttestation['id'] as string, await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }), `Bearer ${operatorKey}`),
      409, 'attestation_not_accepted');
  });
});

describePostgres('computed trust level (§5.1)', () => {
  it('goes basic -> verified with DNS verification alone', async () => {
    const provider = await newProvider();
    const agent = await newAgent(provider);
    expect(await level(agent)).toBe('basic');
    await verifyDns(provider);
    expect(await level(agent)).toBe('verified');
  });

  it('goes basic -> attested -> attested_verified, and needs both the agent and the provider attestation', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    expect(await level(agent)).toBe('basic');
    await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint }));
    expect(await level(agent)).toBe('basic');
    await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    expect(await level(agent)).toBe('attested');
    const [stored] = await sql`SELECT computed_trust_level FROM trust_registry WHERE id = ${provider.id}`;
    expect(stored!['computed_trust_level']).toBe('attested');
    await verifyDns(provider);
    expect(await level(agent)).toBe('attested_verified');
    const [after] = await sql`SELECT computed_trust_level FROM trust_registry WHERE id = ${provider.id}`;
    expect(after!['computed_trust_level']).toBe('attested_verified');
    expect((await computeProviderTrust(sql, provider.did))?.level).toBe('attested_verified');
  });

  it('does not count a provider attestation from an issuer the provider controls', async () => {
    const provider = await newProvider();
    const own = await newIssuer({ host: provider.domain });
    const independent = await newIssuer();
    const agent = await newAgent(provider);
    await accepted(await attest({ issuer: independent, sub: agent.did, keyThumbprint: agent.key.thumbprint }));
    await accepted(await attest({ issuer: own, sub: provider.did, type: PROVIDER_ENTITY }));
    expect(await level(agent)).toBe('basic');
  });

  it('falls back to basic on a suspension anywhere in the chain', async () => {
    // Agent.
    let setup = await attestedSetup({ verified: true });
    expect(await level(setup.agent)).toBe('attested_verified');
    await call(setup.provider.tenant, 'PATCH', `/v1/agents/${setup.agent.id}`, { status: 'suspended' });
    expect(await level(setup.agent)).toBe('basic');

    // Provider.
    setup = await attestedSetup({ verified: true });
    await sql`UPDATE trust_registry SET suspended_at = NOW() - INTERVAL '1 minute' WHERE id = ${setup.provider.id}`;
    expect(await level(setup.agent)).toBe('basic');

    // Issuer.
    setup = await attestedSetup({ verified: true });
    await operator('PATCH', `/v1/registry/issuers/${setup.issuer.id}`, { status: 'suspended', reason: 'review' });
    const trust = await computeAgentTrust(sql, setup.agent.did);
    expect(trust?.level).toBe('basic');
    expect(trust?.flags).toContain('issuer_suspended');

    // The registry's own acceptance.
    setup = await attestedSetup({ verified: true });
    const acceptance = setup.agentAttestation['acceptance'] as { status_list: { uri: string; idx: number } };
    await setAcceptance(acceptance.status_list.uri, acceptance.status_list.idx, 'suspended');
    expect(await level(setup.agent)).toBe('basic');
    await setAcceptance(acceptance.status_list.uri, acceptance.status_list.idx, 'valid');
    expect(await level(setup.agent)).toBe('attested_verified');

    // The issuer's own list, as the registry last read it.
    setup = await attestedSetup({ verified: true });
    const idx = (setup.providerAttestation['status'] as { status_list: { idx: number } }).status_list.idx;
    setup.issuer.entries.set(idx, 2);
    expect(await recheckIssuerStatus(sql, setup.providerAttestation['id'] as string)).toBe('suspended');
    expect(await level(setup.agent)).toBe('basic');
    setup.issuer.entries.set(idx, 0);
    expect(await recheckIssuerStatus(sql, setup.providerAttestation['id'] as string)).toBe('valid');
    expect(await level(setup.agent)).toBe('attested_verified');
    setup.issuer.entries.set(idx, 1);
    expect(await recheckIssuerStatus(sql, setup.providerAttestation['id'] as string)).toBe('revoked');
    expect(await level(setup.agent)).toBe('verified');
  });

  it('stops counting an attestation once the issuer status the registry read is no longer fresh', async () => {
    const setup = await attestedSetup();
    expect(await level(setup.agent)).toBe('attested');
    // The fake issuer's ttl is 300 seconds; nothing rereads the list here.
    const later = new Date(Date.now() + 400_000);
    const trust = await computeAgentTrust(sql, setup.agent.did, later);
    expect(trust?.level).toBe('basic');
    expect(trust?.attestation_ids).toEqual([]);
    expect([...trust!.stale_attestation_ids].sort())
      .toEqual([setup.agentAttestation['id'], setup.providerAttestation['id']].sort());
    expect((await computeProviderTrust(sql, setup.provider.did, later))?.level).toBe('basic');
  });

  it('drops the level when the issuer revokes after ingestion, through the recheck worker and no manual call', async () => {
    const setup = await attestedSetup({ verified: true });
    expect(await level(setup.agent)).toBe('attested_verified');
    const idx = (setup.providerAttestation['status'] as { status_list: { idx: number } }).status_list.idx;
    setup.issuer.entries.set(idx, 1);
    const due = new Date(Date.now() + 400_000);
    const run = await recheckIssuerStatusesOnce(sql, quiet, { now: () => due, batchSize: 1000 });
    expect(run.outcome).toBe('complete');
    expect(run.changed).toBeGreaterThanOrEqual(1);
    const [row] = await sql`SELECT issuer_status FROM registry_attestations WHERE id = ${setup.providerAttestation['id'] as string}`;
    expect(row!['issuer_status']).toBe('revoked');
    expect(await level(setup.agent)).toBe('verified');
    const audit = await sql`SELECT 1 FROM audit_entries WHERE developer_id = ${REGISTRY_AUDIT_CHAIN}
      AND action = 'grantex.registry.attestation_issuer_status_changed'
      AND metadata->>'attestationId' = ${setup.providerAttestation['id'] as string}`;
    expect(audit).toHaveLength(1);
  });

  it('leaves a read that is not yet due alone, and lets a read that cannot be renewed go stale', async () => {
    const setup = await attestedSetup();
    const id = setup.agentAttestation['id'] as string;
    const [before] = await sql`SELECT issuer_status_fresh_until FROM registry_attestations WHERE id = ${id}`;
    await recheckIssuerStatusesOnce(sql, quiet, { now: () => new Date(), batchSize: 1000 });
    const [unchanged] = await sql`SELECT issuer_status_fresh_until FROM registry_attestations WHERE id = ${id}`;
    expect(unchanged!['issuer_status_fresh_until']).toEqual(before!['issuer_status_fresh_until']);

    setup.issuer.serve = 'down';
    try {
      const due = new Date(Date.now() + 400_000);
      const run = await recheckIssuerStatusesOnce(sql, quiet, { now: () => due, batchSize: 1000 });
      expect(run.failed).toBeGreaterThanOrEqual(2);
      const [row] = await sql`SELECT issuer_status, issuer_status_fresh_until, issuer_status_checked_at
        FROM registry_attestations WHERE id = ${id}`;
      expect(row!['issuer_status']).toBe('valid');
      expect(row!['issuer_status_fresh_until']).toEqual(before!['issuer_status_fresh_until']);
      expect((row!['issuer_status_checked_at'] as Date).getTime()).toBe(due.getTime());
      expect((await computeAgentTrust(sql, setup.agent.did, due))?.level).toBe('basic');
    } finally {
      setup.issuer.serve = 'ok';
    }
  });

  it('stops counting an attestation once it expires', async () => {
    const setup = await attestedSetup();
    await sql`UPDATE registry_attestations SET exp = NOW() - INTERVAL '1 minute' WHERE id = ${setup.agentAttestation['id'] as string}`;
    expect(await level(setup.agent)).toBe('basic');
  });
});

describePostgres('flags and computeAgentTrust', () => {
  it('returns level, flags, issuers, types, attestation ids and declared limits, by DID and by thumbprint', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    const p = await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    const a = await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint,
      claims: { declared_limits: { max_amount: '250.00', currency: 'EUR' } } }));
    const byDid = await computeAgentTrust(sql, agent.did);
    expect(byDid).toMatchObject({
      level: 'attested',
      flags: [],
      issuers: [issuer.entityId],
      declared_limits: { max_amount: '250.00', currency: 'EUR' },
    });
    expect([...byDid!.types].sort()).toEqual([AGENT_IDENTITY, PROVIDER_ENTITY]);
    expect([...byDid!.attestation_ids].sort()).toEqual([a['id'], p['id']].sort());
    expect(await computeAgentTrust(sql, agent.key.thumbprint)).toEqual(byDid);
    expect(await computeAgentTrust(sql, 'did:grantex:ag_NOBODY')).toBeNull();
  });

  it('flags key_compromised when an attested key is reported compromised', async () => {
    const { provider, agent } = await attestedSetup();
    await call(provider.tenant, 'POST', `/v1/agents/${agent.id}/keys/${agent.key.thumbprint}/compromise`, { reason: 'device lost' });
    const trust = await computeAgentTrust(sql, agent.did);
    expect(trust?.flags).toContain('key_compromised');
    expect(trust?.level).toBe('basic');
  });

  it('flags attestation_expiring within thirty days of exp', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    const now = Math.floor(Date.now() / 1000);
    await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint, claims: { exp: now + 29 * DAY_S } }));
    expect((await computeAgentTrust(sql, agent.did))?.flags).toEqual(['attestation_expiring']);
  });

  it('flags declared_limits_changed when a newer attestation declares other limits', async () => {
    const issuer = await newIssuer();
    const provider = await newProvider();
    const agent = await newAgent(provider);
    await accepted(await attest({ issuer, sub: provider.did, type: PROVIDER_ENTITY }));
    const first = await accepted(await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint, claims: { declared_limits: { max_amount: '250.00' } } }));
    expect((await computeAgentTrust(sql, agent.did))?.flags).toEqual([]);
    const same = await refresh(first['id'] as string, await attest({ issuer, sub: agent.did, keyThumbprint: agent.key.thumbprint,
      claims: { declared_limits: { max_amount: '250.00' }, iat: Math.floor(Date.now() / 1000) } }), `Bearer ${operatorKey}`);
    expect(same.statusCode, same.body).toBe(201);
    expect((await computeAgentTrust(sql, agent.did))?.flags).toEqual([]);
    const changed = await refresh(same.json<Record<string, unknown>>()['id'] as string, await attest({ issuer, sub: agent.did,
      keyThumbprint: agent.key.thumbprint, claims: { declared_limits: { max_amount: '900.00' }, iat: Math.floor(Date.now() / 1000) + 1 } }),
    `Bearer ${operatorKey}`);
    expect(changed.statusCode, changed.body).toBe(201);
    const trust = await computeAgentTrust(sql, agent.did);
    expect(trust?.flags).toEqual(['declared_limits_changed']);
    expect(trust?.declared_limits).toEqual({ max_amount: '900.00' });
  });

  it('never sets provider_screening_hit, ownership_unresolved or security_review_failed', async () => {
    const { agent } = await attestedSetup();
    const flags = (await computeAgentTrust(sql, agent.did))?.flags ?? [];
    for (const flag of ['provider_screening_hit', 'ownership_unresolved', 'security_review_failed']) expect(flags).not.toContain(flag);
  });
});

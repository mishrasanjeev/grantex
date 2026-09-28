// SPDX-License-Identifier: Apache-2.0
/**
 * The minimised registry lookup and the signed registry manifest against
 * real Postgres, through the routes.
 *
 * Covered: what an unauthenticated relying party reads (never legal
 * identifiers, the provider's name or a status list index) and what an
 * authenticated one reads in addition; the lookup by DID, by key thumbprint
 * (key_status and whether the key is current, across a rotation overlap) and
 * by issuer + external_credential_id + hash (all three required, and a
 * mismatch on any one answered exactly as an unknown credential); the
 * public form and the manifest route absent while
 * REGISTRY_PUBLIC_ENDPOINTS_ENABLED is off; the manifest verifying with the
 * published JWK Set, its lifetime, suspended issuers with their status,
 * revoked kids left out, and every issuer included past one page.
 *
 * Attestations are written straight into the store with a real acceptance
 * entry: ingestion is covered by registry-attestations-postgres; here only
 * what the registry holds matters.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { ulid } from 'ulid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey } from '../src/lib/hash.js';
import { allocateAcceptanceEntry } from '../src/lib/registry/acceptance-status.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import {
  REGISTRY_MANIFEST_LIFETIME_SECONDS,
  REGISTRY_MANIFEST_MEDIA_TYPE,
  REGISTRY_MANIFEST_TYP,
  RegistryManifestError,
  buildRegistryManifest,
  verifyRegistryManifest,
  type RegistryManifestClaims,
} from '../src/lib/registry/manifest.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres lookup tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
/** The registry a relying party trusts: the service's JWT_ISSUER in tests. */
const REGISTRY = { issuer: 'https://grantex.dev' };
const DAY_S = 86_400;
const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
const LEGAL_IDENTIFIERS = [{ scheme: 'lei', value: '5299000EXAMPLE000042' }];
const PROVIDER_NAME = 'Provider Example Ltd';

type Sql = ReturnType<typeof postgres>;
interface Key { privateKey: CryptoKey; jwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string }
interface Issuer { id: string; entityId: string; host: string }
interface Provider { id: string; did: string; tenant: Tenant }
interface Agent { id: string; did: string; key: Key }
interface Seeded {
  issuer: Issuer;
  provider: Provider;
  agent: Agent;
  credential: { id: string; hash: string };
  agentAttestationId: string;
}

let sql: Sql;
/** REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true */
let app: FastifyInstance;
/** The flag off. */
let closedApp: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let relyingParty: Tenant;
const operatorKey = randomBytes(32).toString('hex');
let addressCounter = 0;

function nextAddress(): string {
  addressCounter += 1;
  return `198.51.100.${(addressCounter % 250) + 1}`;
}

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, thumbprint: jwkThumbprint(jwk) };
}

async function newTenant(): Promise<Tenant> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_lkp_${suffix}`, apiKey: `gx_test_lkp_${suffix}_key` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Lookup Test', 'sandbox')`;
  return tenant;
}

async function call(target: FastifyInstance, tenant: Tenant, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return target.inject({
    method, url, remoteAddress: nextAddress(), headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload } : {}),
  });
}

async function operator(method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method, url, headers: { authorization: `Bearer ${operatorKey}` }, payload, remoteAddress: nextAddress(),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json<Record<string, unknown>>();
}

async function newIssuer(options: { host?: string; kids?: string[] } = {}): Promise<Issuer> {
  const host = options.host ?? `issuer-${randomBytes(4).toString('hex')}.example`;
  const keys = [];
  for (const kid of options.kids ?? ['k1']) keys.push({ ...(await newKey()).jwk, kid, alg: 'ES256', use: 'sig' });
  const record = await operator('POST', '/v1/registry/issuers', {
    entity_id: `https://${host}`,
    jwks: { keys },
    trust_marks: [PROVIDER_ENTITY, AGENT_IDENTITY],
    status_list_base: `https://${host}/status/`,
    accreditation_evidence_ref: `accreditation-case-${host}`,
  });
  return { id: record['id'] as string, entityId: `https://${host}`, host };
}

async function newProvider(): Promise<Provider> {
  const tenant = await newTenant();
  const domain = `provider-${randomBytes(4).toString('hex')}.example`;
  const id = `treg_${randomBytes(8).toString('hex')}`;
  await sql`
    INSERT INTO trust_registry (id, organization_did, domain, developer_id, name, trust_level, verification_method,
                                verified_at, legal_identifiers)
    VALUES (${id}, ${`did:web:${domain}`}, ${domain}, ${tenant.id}, ${PROVIDER_NAME}, 'verified', 'dns-txt', NOW(),
            ${sql.json(LEGAL_IDENTIFIERS)})`;
  return { id, did: `did:web:${domain}`, tenant };
}

async function addAndProve(provider: Provider, agentId: string, key: Key) {
  const added = await call(app, provider.tenant, 'POST', `/v1/agents/${agentId}/keys`, { publicJwk: key.jwk });
  expect(added.statusCode, added.body).toBe(201);
  const issued = await call(app, provider.tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/challenge`);
  expect(issued.statusCode, issued.body).toBe(201);
  const proof = await new SignJWT({ nonce: issued.json<{ challenge: string }>().challenge, sub: agentId })
    .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(AUDIENCE).setIssuedAt().sign(key.privateKey);
  const proved = await call(app, provider.tenant, 'POST', `/v1/agents/${agentId}/keys/${key.thumbprint}/prove`, { proof });
  expect(proved.statusCode, proved.body).toBe(200);
}

async function newAgent(provider: Provider): Promise<Agent> {
  const created = await call(app, provider.tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4', scopes: ['read'] });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ agentId: string }>().agentId;
  const [row] = await sql`SELECT did FROM agents WHERE id = ${id}`;
  await sql`UPDATE agents SET cimd_uri = 'https://provider.example/agents/shopper-01/cimd.json' WHERE id = ${id}`;
  const key = await newKey();
  await addAndProve(provider, id, key);
  return { id, did: row!['did'] as string, key };
}

/** An accepted attestation, as ingestion would have stored it, with a real acceptance entry. */
async function storeAttestation(input: {
  issuer: Issuer;
  sub: string;
  type: string;
  agentId?: string;
  providerId?: string;
  keyThumbprint?: string;
  credentialId: string;
  credentialHash: string;
}): Promise<string> {
  const id = `ratt_${ulid()}`;
  const now = Date.now();
  await sql.begin(async (tx) => {
    const acceptance = await allocateAcceptanceEntry(tx as never);
    await tx`
      INSERT INTO registry_attestations (
        id, issuer_id, issuer_entity_id, attestation_id, jws, sub, subject_kind, agent_id, provider_id, type,
        key_thumbprint, external_credential_id, external_credential_hash, level, iat, exp,
        status_list_uri, status_list_idx, acceptance_list_uri, acceptance_list_idx, issuer_status_fresh_until
      ) VALUES (
        ${id}, ${input.issuer.id}, ${input.issuer.entityId}, ${`att-${randomBytes(6).toString('hex')}`}, 'x.y.z',
        ${input.sub}, ${input.agentId ? 'agent' : 'provider'}, ${input.agentId ?? null}, ${input.providerId ?? null},
        ${input.type}, ${input.keyThumbprint ?? null}, ${input.credentialId}, ${input.credentialHash}, 'substantial',
        ${new Date(now - 60_000)}, ${new Date(now + 180 * DAY_S * 1000)},
        ${`https://${input.issuer.host}/status/1`}, ${Math.floor(Math.random() * 1000)},
        ${acceptance.uri}, ${acceptance.idx}, ${new Date(now + DAY_S * 1000)}
      )`;
  });
  return id;
}

function newCredential() {
  return { id: `case-${randomBytes(4).toString('hex')}`, hash: `sha-256:${randomBytes(32).toString('base64url')}` };
}

/** An attested_verified agent: a provider.entity and an agent.identity attestation from an independent issuer. */
async function seed(): Promise<Seeded> {
  const issuer = await newIssuer();
  const provider = await newProvider();
  const agent = await newAgent(provider);
  await storeAttestation({
    issuer, sub: provider.did, type: PROVIDER_ENTITY, providerId: provider.id, ...(() => {
      const c = newCredential();
      return { credentialId: c.id, credentialHash: c.hash };
    })(),
  });
  const credential = newCredential();
  const agentAttestationId = await storeAttestation({
    issuer, sub: agent.did, type: AGENT_IDENTITY, agentId: agent.id, keyThumbprint: agent.key.thumbprint,
    credentialId: credential.id, credentialHash: credential.hash,
  });
  return { issuer, provider, agent, credential, agentAttestationId };
}

function publicGet(target: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return target.inject({ method: 'GET', url, headers, remoteAddress: nextAddress() });
}

function byCredential(issuer: string, id: string, hash: string): string {
  const query = new URLSearchParams({ issuer, external_credential_id: id, hash });
  return `/v1/registry/agents?${query.toString()}`;
}

/** Every member name anywhere in a JSON value, and every string value. */
function inventory(value: unknown, names = new Set<string>(), strings = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((item) => inventory(item, names, strings));
  else if (value !== null && typeof value === 'object') {
    for (const [name, member] of Object.entries(value)) {
      names.add(name);
      inventory(member, names, strings);
    }
  } else if (typeof value === 'string') strings.add(value);
  return { names, strings };
}

const PUBLIC_MEMBERS = ['agent_did', 'level', 'flags', 'issuers', 'attestations', 'keys', 'cimd_uri'];

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('registry_lookup');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'true');
  app = await buildTestApp();
  vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'false');
  closedApp = await buildTestApp();
  vi.unstubAllEnvs();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closedApp?.close();
  await sql?.end();
  await dropTestDatabase?.();
}, 60_000);

beforeEach(async () => {
  if (!adminDatabaseUrl) return;
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
  relyingParty ??= await newTenant();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('GET /v1/registry/agents/:did: minimisation', () => {
  it('answers an unauthenticated relying party with the public members only', async () => {
    const { agent, issuer } = await seed();
    const res = await publicGet(app, `/v1/registry/agents/${encodeURIComponent(agent.did)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_MEMBERS].sort());
    expect(body['agent_did']).toBe(agent.did);
    expect(body['level']).toBe('attested_verified');
    expect(body['issuers']).toEqual([issuer.entityId]);
    expect(body['cimd_uri']).toBe('https://provider.example/agents/shopper-01/cimd.json');
    const attestations = body['attestations'] as Array<Record<string, unknown>>;
    expect(attestations.map((a) => a['type']).sort()).toEqual([AGENT_IDENTITY, PROVIDER_ENTITY]);
    for (const attestation of attestations) {
      expect(Object.keys(attestation).sort()).toEqual(['expires_at', 'issuer', 'type']);
    }
    expect(body['keys']).toEqual([{ thumbprint: agent.key.thumbprint, status: 'active', current: true }]);

    const { names, strings } = inventory(body);
    for (const hidden of ['legal_identifiers', 'provider', 'name', 'idx', 'status_list', 'acceptance_status_list',
      'issuer_status_list', 'id', 'agent_id', 'provider_did']) {
      expect(names.has(hidden), hidden).toBe(false);
    }
    expect(strings.has(PROVIDER_NAME)).toBe(false);
    expect(res.body).not.toContain(LEGAL_IDENTIFIERS[0]!.value);
    expect(res.body).not.toContain('/status/attestations/');
    expect(res.headers['etag']).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(String(res.headers['vary'])).toMatch(/authorization/i);
  });

  it('keeps the CORS Vary: Origin alongside Vary: Authorization for a browser caller', async () => {
    const { agent } = await seed();
    const res = await publicGet(app, `/v1/registry/agents/${encodeURIComponent(agent.did)}`, { origin: 'https://grantex.dev' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://grantex.dev');
    const vary = String(res.headers['vary']).split(',').map((name) => name.trim().toLowerCase());
    expect(vary).toContain('origin');
    expect(vary).toContain('authorization');
    expect(new Set(vary).size).toBe(vary.length);
    const missing = await publicGet(app, `/v1/registry/agents/${encodeURIComponent(`${agent.did}x`)}`, { origin: 'https://grantex.dev' });
    expect(missing.statusCode).toBe(404);
    const missingVary = String(missing.headers['vary']).split(',').map((name) => name.trim().toLowerCase());
    expect(missingVary).toEqual(expect.arrayContaining(['origin', 'authorization']));
  });

  it('adds legal identifiers, the provider name and the status list entries for an authenticated relying party', async () => {
    const { agent, provider, agentAttestationId } = await seed();
    const res = await call(app, relyingParty, 'GET', `/v1/registry/agents/${encodeURIComponent(agent.did)}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['provider']).toEqual({ did: provider.did, name: PROVIDER_NAME, legal_identifiers: LEGAL_IDENTIFIERS });
    const attestations = body['attestations'] as Array<Record<string, unknown>>;
    const mine = attestations.find((a) => a['id'] === agentAttestationId)!;
    expect(mine).toBeDefined();
    const issuerList = mine['issuer_status_list'] as { uri: string; idx: number };
    const acceptance = mine['acceptance_status_list'] as { uri: string; idx: number };
    expect(issuerList.uri).toMatch(/^https:\/\/issuer-.*\/status\/1$/);
    expect(Number.isInteger(issuerList.idx)).toBe(true);
    expect(acceptance.uri).toContain('/status/attestations/racl_');
    expect(Number.isInteger(acceptance.idx)).toBe(true);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    // The developer's plan bucket applies: the per-API-key limit.
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('works for an authenticated relying party with the flag off, and refuses the unauthenticated form there', async () => {
    const { agent } = await seed();
    const authed = await call(closedApp, relyingParty, 'GET', `/v1/registry/agents/${encodeURIComponent(agent.did)}`);
    expect(authed.statusCode, authed.body).toBe(200);
    expect(authed.json<Record<string, unknown>>()['provider']).toBeDefined();
    const anonymous = await publicGet(closedApp, `/v1/registry/agents/${encodeURIComponent(agent.did)}`);
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses an invalid API key rather than answering it as public', async () => {
    const { agent } = await seed();
    const res = await publicGet(app, `/v1/registry/agents/${encodeURIComponent(agent.did)}`, {
      authorization: 'Bearer gx_test_not_a_real_key_000000',
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for an unknown DID, and 304 for an unchanged ETag', async () => {
    const unknown = await publicGet(app, `/v1/registry/agents/${encodeURIComponent('did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3')}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<Record<string, unknown>>()['code']).toBe('NOT_FOUND');
    const { agent } = await seed();
    const url = `/v1/registry/agents/${encodeURIComponent(agent.did)}`;
    const first = await publicGet(app, url);
    const again = await publicGet(app, url, { 'if-none-match': first.headers['etag'] as string });
    expect(again.statusCode).toBe(304);
  });

  it('reads basic once the provider is suspended', async () => {
    const { agent, provider } = await seed();
    await sql`UPDATE trust_registry SET suspended_at = NOW() - INTERVAL '1 minute' WHERE id = ${provider.id}`;
    const res = await publicGet(app, `/v1/registry/agents/${encodeURIComponent(agent.did)}`);
    expect(res.json<Record<string, unknown>>()['level']).toBe('basic');
  });
});

describePostgres('GET /v1/registry/agents?key_thumbprint=', () => {
  it('returns the agent, key_status and current across a rotation overlap', async () => {
    const { agent, provider } = await seed();
    const replacement = await newKey();
    await addAndProve(provider, agent.id, replacement);
    const rotated = await call(app, provider.tenant, 'POST', `/v1/agents/${agent.id}/keys/${agent.key.thumbprint}/rotate`, {
      replacementThumbprint: replacement.thumbprint, overlapSeconds: 3600,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);

    const old = await publicGet(app, `/v1/registry/agents?key_thumbprint=${agent.key.thumbprint}`);
    expect(old.statusCode, old.body).toBe(200);
    const oldBody = old.json<Record<string, unknown>>();
    expect(oldBody['agent_did']).toBe(agent.did);
    expect(oldBody['key_thumbprint']).toBe(agent.key.thumbprint);
    expect(oldBody['key_status']).toBe('rotated');
    expect(oldBody['key_current']).toBe(true);

    const fresh = await publicGet(app, `/v1/registry/agents?key_thumbprint=${replacement.thumbprint}`);
    expect(fresh.json<Record<string, unknown>>()).toMatchObject({ key_status: 'active', key_current: true, agent_did: agent.did });

    // The overlap ends: the rotated key is no longer current.
    await sql`UPDATE agent_keys SET valid_to = NOW() - INTERVAL '1 second' WHERE thumbprint = ${agent.key.thumbprint}`;
    const after = await publicGet(app, `/v1/registry/agents?key_thumbprint=${agent.key.thumbprint}`);
    expect(after.json<Record<string, unknown>>()).toMatchObject({ key_status: 'rotated', key_current: false });
  });

  it('reports a compromised key as not current, and a pending key as not current', async () => {
    const { agent, provider } = await seed();
    const pending = await newKey();
    const added = await call(app, provider.tenant, 'POST', `/v1/agents/${agent.id}/keys`, { publicJwk: pending.jwk });
    expect(added.statusCode, added.body).toBe(201);
    const res = await publicGet(app, `/v1/registry/agents?key_thumbprint=${pending.thumbprint}`);
    expect(res.json<Record<string, unknown>>()).toMatchObject({ key_status: 'pending', key_current: false });
    await sql`UPDATE agent_keys SET status = 'compromised', valid_to = NOW() WHERE thumbprint = ${agent.key.thumbprint}`;
    const compromised = await publicGet(app, `/v1/registry/agents?key_thumbprint=${agent.key.thumbprint}`);
    expect(compromised.json<Record<string, unknown>>()).toMatchObject({ key_status: 'compromised', key_current: false });
  });

  it('answers 404 for an unknown thumbprint and 400 for a malformed one', async () => {
    expect((await publicGet(app, `/v1/registry/agents?key_thumbprint=${'A'.repeat(43)}`)).statusCode).toBe(404);
    expect((await publicGet(app, '/v1/registry/agents?key_thumbprint=short')).statusCode).toBe(400);
  });
});

describePostgres('GET /v1/registry/agents?issuer=&external_credential_id=&hash=', () => {
  it('finds the agent when all three match', async () => {
    const { agent, issuer, credential } = await seed();
    const res = await publicGet(app, byCredential(issuer.entityId, credential.id, credential.hash));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['agent_did']).toBe(agent.did);
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_MEMBERS].sort());
  });

  it('refuses the query unless all three are present', async () => {
    const { issuer, credential } = await seed();
    const params = { issuer: issuer.entityId, external_credential_id: credential.id, hash: credential.hash };
    for (const missing of Object.keys(params)) {
      const partial = Object.fromEntries(Object.entries(params).filter(([name]) => name !== missing));
      const res = await publicGet(app, `/v1/registry/agents?${new URLSearchParams(partial).toString()}`);
      expect(res.statusCode, missing).toBe(400);
    }
    expect((await publicGet(app, '/v1/registry/agents')).statusCode).toBe(400);
    const mixed = await publicGet(app, `/v1/registry/agents?${new URLSearchParams({ ...params, key_thumbprint: 'A'.repeat(43) }).toString()}`);
    expect(mixed.statusCode).toBe(400);
  });

  it('answers a mismatch on any one of the three exactly as an unknown credential', async () => {
    const { issuer, credential } = await seed();
    const other = await newIssuer();
    const unknown = await publicGet(app, byCredential(`https://unknown-${randomBytes(3).toString('hex')}.example`,
      'case-unknown', `sha-256:${randomBytes(32).toString('base64url')}`));
    const variants = [
      byCredential(other.entityId, credential.id, credential.hash),
      byCredential(issuer.entityId, `${credential.id}-x`, credential.hash),
      byCredential(issuer.entityId, credential.id, `sha-256:${randomBytes(32).toString('base64url')}`),
    ];
    expect(unknown.statusCode).toBe(404);
    const shape = (res: typeof unknown) => ({ status: res.statusCode, body: { ...res.json<Record<string, unknown>>(), requestId: '' } });
    for (const url of variants) {
      const res = await publicGet(app, url);
      expect(shape(res)).toEqual(shape(unknown));
      expect(res.headers['etag']).toBeUndefined();
    }
  });

  it('answers a credential that names more than one agent exactly as an unknown credential', async () => {
    // Nothing in the schema makes (issuer, external_credential_id, hash)
    // unique across agents, so the ambiguous case is reachable.
    const { issuer, provider, credential } = await seed();
    const second = await newAgent(provider);
    await storeAttestation({
      issuer, sub: second.did, type: AGENT_IDENTITY, agentId: second.id, keyThumbprint: second.key.thumbprint,
      credentialId: credential.id, credentialHash: credential.hash,
    });
    const unknown = await publicGet(app, byCredential(`https://unknown-${randomBytes(3).toString('hex')}.example`,
      'case-unknown', `sha-256:${randomBytes(32).toString('base64url')}`));
    const shape = (res: typeof unknown) => ({ status: res.statusCode, body: { ...res.json<Record<string, unknown>>(), requestId: '' } });
    const ambiguous = await publicGet(app, byCredential(issuer.entityId, credential.id, credential.hash));
    expect(ambiguous.statusCode).toBe(404);
    expect(shape(ambiguous)).toEqual(shape(unknown));
    expect(ambiguous.headers['etag']).toBeUndefined();
    const authenticated = await publicGet(app, byCredential(issuer.entityId, credential.id, credential.hash),
      { authorization: `Bearer ${relyingParty.apiKey}` });
    expect(authenticated.statusCode).toBe(404);
  });
});

describePostgres('REGISTRY_PUBLIC_ENDPOINTS_ENABLED off', () => {
  it('does not register the manifest route', async () => {
    const res = await publicGet(closedApp, '/.well-known/agent-registry.json');
    expect(res.statusCode).toBe(404);
  });
});

describePostgres('GET /.well-known/agent-registry.json', () => {
  async function publishedJwks() {
    const res = await publicGet(app, '/.well-known/jwks.json');
    expect(res.statusCode).toBe(200);
    return res.json<{ keys: JWK[] }>();
  }

  async function fetchManifest() {
    const res = await publicGet(app, '/.well-known/agent-registry.json');
    expect(res.statusCode, res.body).toBe(200);
    return res;
  }

  it('is a JWS of its own type that verifies with the published JWK Set', async () => {
    await newIssuer();
    const res = await fetchManifest();
    expect(res.headers['content-type']).toContain(REGISTRY_MANIFEST_MEDIA_TYPE);
    const [encodedHeader] = res.body.split('.');
    const header = JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(header['typ']).toBe(REGISTRY_MANIFEST_TYP);
    const jwks = await publishedJwks();
    expect(jwks.keys.some((key) => key.kid === header['kid'])).toBe(true);
    const claims = await verifyRegistryManifest(res.body, jwks, new Date(), REGISTRY);
    expect(claims.iss).toBe('https://grantex.dev');
    expect(claims.exp - claims.iat).toBe(REGISTRY_MANIFEST_LIFETIME_SECONDS);
    expect(claims.trust_mark_types).toContain(AGENT_IDENTITY);
    expect(claims.endpoints.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
    expect(claims.endpoints.agent_by_did).toContain('{agent_did}');
    expect(res.headers['etag']).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(res.headers['cache-control']).toMatch(/^public, max-age=\d+$/);
    const again = await publicGet(app, '/.well-known/agent-registry.json', { 'if-none-match': res.headers['etag'] as string });
    expect(again.statusCode).toBe(304);
  });

  it('lists a suspended issuer with its status and leaves revoked kids out', async () => {
    const suspended = await newIssuer();
    await operator('PATCH', `/v1/registry/issuers/${suspended.id}`, { status: 'suspended', reason: 'irregularity under review' });
    const rotating = await newIssuer({ kids: ['k1', 'k2'] });
    await operator('PATCH', `/v1/registry/issuers/${rotating.id}`, { revoke_kids: ['k1'], reason: 'key retired' });
    const claims = await verifyRegistryManifest((await fetchManifest()).body, await publishedJwks(), new Date(), REGISTRY);
    const find = (entityId: string) => claims.issuers.find((issuer) => issuer.entity_id === entityId);
    expect(find(suspended.entityId)?.status).toBe('suspended');
    expect(find(rotating.entityId)?.jwks.keys.map((key) => key['kid'])).toEqual(['k2']);
  });

  it('carries the registry acceptance lists in both forms', async () => {
    const { agentAttestationId } = await seed();
    const [row] = await sql`SELECT acceptance_list_uri FROM registry_attestations WHERE id = ${agentAttestationId}`;
    const uri = row!['acceptance_list_uri'] as string;
    const claims = await verifyRegistryManifest((await fetchManifest()).body, await publishedJwks(), new Date(), REGISTRY);
    expect(claims.acceptance_status_lists).toContainEqual({
      token_status_list: uri,
      bitstring_status_list: { revocation: `${uri}/bitstring`, suspension: `${uri}/bitstring/suspension` },
    });
  });

  it('includes every accredited issuer, past one page', async () => {
    const [counted] = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM accredited_issuers`;
    const missing = 505 - Number(counted!.count);
    if (missing > 0) {
      const jwks = { keys: [{ ...(await newKey()).jwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
      for (let i = 0; i < missing; i += 1) {
        const host = `bulk-${String(i).padStart(4, '0')}-${randomBytes(2).toString('hex')}.example`;
        await sql`INSERT INTO accredited_issuers (id, entity_id, jwks, trust_marks, status, status_list_base, accreditation_evidence_ref)
                  VALUES (${`aiss_${ulid()}`}, ${`https://${host}`}, ${sql.json(jwks)}, ${[AGENT_IDENTITY]}, 'active',
                          ${`https://${host}/status/`}, ${`case-${host}`})`;
      }
    }
    const [totalled] = await sql<{ total: string }[]>`SELECT COUNT(*)::text AS total FROM accredited_issuers`;
    const total = totalled!.total;
    const manifest = await buildRegistryManifest({ sql });
    expect(manifest.claims.issuers).toHaveLength(Number(total));
    const ids = manifest.claims.issuers.map((issuer) => issuer.entity_id);
    expect(new Set(ids).size).toBe(ids.length);
    // Byte order, the same on every database.
    expect([...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual(ids);
  });
});

describePostgres('verifyRegistryManifest', () => {
  it('refuses a manifest past exp, older than an hour, or signed by a key not in the set', async () => {
    const now = new Date();
    const manifest = await buildRegistryManifest({ sql, now });
    const jwks = (await publicGet(app, '/.well-known/jwks.json')).json<{ keys: JWK[] }>();
    await expect(verifyRegistryManifest(manifest.token, jwks, now, REGISTRY)).resolves.toMatchObject({ iss: 'https://grantex.dev' });
    const late = new Date(manifest.claims.exp * 1000);
    await expect(verifyRegistryManifest(manifest.token, jwks, late, REGISTRY)).rejects.toMatchObject({ code: 'status_stale' });
    const other = await newKey();
    await expect(verifyRegistryManifest(manifest.token, { keys: [{ ...other.jwk, kid: 'other' }] }, now, REGISTRY))
      .rejects.toBeInstanceOf(RegistryManifestError);
    const claims: RegistryManifestClaims = manifest.claims;
    expect(claims.issuers.every((issuer) => typeof issuer.status === 'string')).toBe(true);
  });
});

// SPDX-License-Identifier: Apache-2.0
/**
 * Agent key history against real Postgres, through the routes.
 *
 * Covers every key route (add, challenge, prove, rotate, compromise, the key
 * listing and declared rails), the migration 122 backfill (owner decision
 * 12), the mirror that keeps the history complete when POST and PATCH
 * /v1/agents write a key (AGENT_KEY_HISTORY_MIRROR_ENABLED=true), those two
 * routes unchanged with the mirror off (the default), the rotation overlap
 * boundary, a compromise that
 * revokes the grants bound to the key (and what was delegated from them)
 * through the cascade, replayed and wrong-key proofs, and the P-256 rule for
 * payments rails. The SQL mock forwards to a real database, so the triggers,
 * the advisory locks, the cascade and the audit chain are the production ones.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey, matchStoredAuditHash } from '../src/lib/hash.js';
import { KEY_PROOF_TYP } from '../src/lib/registry/agent-keys.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres agent key tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const AUDIENCE = 'https://grantex.dev';
const SCOPES = ['tool:acme_kyb:read', 'payments:mpp:inference'];
const SEVEN_DAYS_MS = 7 * 86_400_000;
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const MIGRATION = '122_agent_keys.sql';

type Sql = ReturnType<typeof postgres>;
type Alg = 'ES256' | 'EdDSA';
interface Key { alg: Alg; privateKey: CryptoKey; jwk: JWK; thumbprint: string }
interface Tenant { id: string; apiKey: string; ip: string }

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
let tenantCounter = 0;

async function newKey(alg: Alg = 'ES256'): Promise<Key> {
  const { privateKey, publicKey } = alg === 'EdDSA'
    ? await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
    : await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { alg, privateKey, jwk, thumbprint: jwkThumbprint(jwk) };
}

async function newTenant(): Promise<Tenant> {
  tenantCounter += 1;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenant = { id: `dev_keys_${suffix}`, apiKey: `gx_test_keys_${suffix}_key`, ip: `198.51.100.${tenantCounter}` };
  await sql`INSERT INTO developers (id, api_key_hash, name, mode)
            VALUES (${tenant.id}, ${hashApiKey(tenant.apiKey)}, 'Key History Test', 'sandbox')`;
  return tenant;
}

async function call(tenant: Tenant, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    remoteAddress: tenant.ip,
    headers: { authorization: `Bearer ${tenant.apiKey}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

async function createAgent(tenant: Tenant, publicJwk?: JWK, name = 'Nimbus Shopper 2.4'): Promise<string> {
  const res = await call(tenant, 'POST', '/v1/agents', {
    name, scopes: SCOPES, ...(publicJwk !== undefined ? { publicJwk } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ agentId: string }>().agentId;
}

const keysUrl = (agentId: string) => `/v1/agents/${agentId}/keys`;
const keyUrl = (agentId: string, thumbprint: string, action: string) => `/v1/agents/${agentId}/keys/${thumbprint}/${action}`;

async function addKey(tenant: Tenant, agentId: string, key: Key) {
  return call(tenant, 'POST', keysUrl(agentId), { publicJwk: key.jwk });
}

async function challenge(tenant: Tenant, agentId: string, key: Key) {
  return call(tenant, 'POST', keyUrl(agentId, key.thumbprint, 'challenge'));
}

async function signProof(key: Key, agentId: string, nonce: string, overrides: { aud?: string; signWith?: Key } = {}) {
  const signer = overrides.signWith ?? key;
  return new SignJWT({ nonce, sub: agentId })
    .setProtectedHeader({ alg: signer.alg, typ: KEY_PROOF_TYP, kid: key.thumbprint })
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt()
    .sign(signer.privateKey);
}

async function prove(tenant: Tenant, agentId: string, key: Key, proof: string) {
  return call(tenant, 'POST', keyUrl(agentId, key.thumbprint, 'prove'), { proof });
}

/** Add, challenge and prove a key; returns it active. */
async function activeKey(tenant: Tenant, agentId: string, alg: Alg = 'ES256'): Promise<Key> {
  const key = await newKey(alg);
  const added = await addKey(tenant, agentId, key);
  expect(added.statusCode, added.body).toBe(201);
  const issued = await challenge(tenant, agentId, key);
  expect(issued.statusCode, issued.body).toBe(201);
  const proved = await prove(tenant, agentId, key, await signProof(key, agentId, issued.json<{ challenge: string }>().challenge));
  expect(proved.statusCode, proved.body).toBe(200);
  expect(proved.json()).toMatchObject({ status: 'active' });
  return key;
}

async function keyRow(thumbprint: string) {
  const rows = await sql<Array<Record<string, unknown>>>`SELECT * FROM agent_keys WHERE thumbprint = ${thumbprint}`;
  return rows[0];
}

/** What PAR does when it verifies a DPoP proof of the registered key (routes/oauth.ts). */
async function dpopVerified(agentId: string, thumbprint: string): Promise<void> {
  await sql`UPDATE agents SET key_verified_thumbprint = ${thumbprint}, key_verified_at = NOW()
            WHERE id = ${agentId} AND key_thumbprint = ${thumbprint}`;
}

async function mintGrant(tenant: Tenant, agentId: string, principalId: string) {
  const authorized = await call(tenant, 'POST', '/v1/authorize', { agentId, principalId, scopes: SCOPES });
  expect(authorized.statusCode, authorized.body).toBe(201);
  const exchanged = await call(tenant, 'POST', '/v1/token', { code: authorized.json<{ code: string }>().code, agentId });
  expect(exchanged.statusCode, exchanged.body).toBe(201);
  return exchanged.json<{ grantToken: string; grantId: string }>();
}

async function grantStatus(grantId: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM grants WHERE id = ${grantId}`;
  return rows[0]!.status;
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

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('agent-keys');
  dropTestDatabase = db.drop;
  sql = postgres(db.url, { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await runMigrations(sql);
  app = await buildTestApp();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await sql?.end({ timeout: 5 }).catch(() => undefined);
  await dropTestDatabase?.();
}, 60_000);

beforeEach(() => {
  sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
  sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
  sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
  sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describePostgres('agent key history against real Postgres', () => {
  // The history mirror on POST and PATCH /v1/agents is behind a flag that
  // defaults off; these tests cover it on. The block below covers it off.
  beforeEach(() => {
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'true');
  });

  it('mirrors a key registered through POST /v1/agents as pending, and a DPoP proof of it as possession', async () => {
    const tenant = await newTenant();
    const key = await newKey('EdDSA');
    const agentId = await createAgent(tenant, key.jwk);

    const listed = await call(tenant, 'GET', keysUrl(agentId));
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      agentId,
      declaredRails: [],
      keys: [{ thumbprint: key.thumbprint, alg: 'EdDSA', status: 'pending', usable: false, denial: 'key_unproven' }],
    });

    await dpopVerified(agentId, key.thumbprint);
    // The key routes record the DPoP proof before they read the history.
    const relisted = await call(tenant, 'GET', keysUrl(agentId));
    expect(relisted.json()).toMatchObject({
      keys: [{ thumbprint: key.thumbprint, status: 'active', usable: true }],
    });
    const row = await keyRow(key.thumbprint);
    expect(row).toMatchObject({ status: 'active', agent_id: agentId, developer_id: tenant.id });
    expect(row!['possession_proved_at']).not.toBeNull();
  }, 60_000);

  it('revokes grants when a key update and lifecycle suspension share one PATCH', async () => {
    vi.stubEnv('AGENT_LIFECYCLE_STATES_ENABLED', 'true');
    const tenant = await newTenant();
    const oldKey = await newKey('EdDSA');
    const agentId = await createAgent(tenant, oldKey.jwk);
    await dpopVerified(agentId, oldKey.thumbprint);
    const grant = await mintGrant(tenant, agentId, 'shopper-01');
    const replacement = await newKey('EdDSA');

    const res = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, {
      status: 'suspended', publicJwk: replacement.jwk,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'suspended', keyThumbprint: replacement.thumbprint });
    expect(await grantStatus(grant.grantId)).toBe('revoked');
  }, 60_000);

  it('adds a pending key, proves possession over a challenge, and records it in the audit chain', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const key = await newKey('EdDSA');

    const added = await addKey(tenant, agentId, key);
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({
      agentId, thumbprint: key.thumbprint, alg: 'EdDSA', status: 'pending', possessionProvedAt: null, validTo: null,
    });
    expect(added.json<{ jwk: JWK }>().jwk).toEqual(key.jwk);

    const issued = await challenge(tenant, agentId, key);
    expect(issued.statusCode, issued.body).toBe(201);
    const body = issued.json<{ challenge: string; audience: string; typ: string; alg: string; expiresAt: string; subject: string }>();
    expect(body).toMatchObject({ audience: AUDIENCE, typ: KEY_PROOF_TYP, alg: 'EdDSA', subject: agentId });
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(200_000);
    expect(ttl).toBeLessThanOrEqual(300_000);
    // Only a hash of the nonce is stored.
    const stored = await sql`SELECT nonce_hash FROM agent_key_challenges WHERE thumbprint = ${key.thumbprint}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!['nonce_hash']).not.toBe(body.challenge);

    const proved = await prove(tenant, agentId, key, await signProof(key, agentId, body.challenge));
    expect(proved.statusCode, proved.body).toBe(200);
    expect(proved.json()).toMatchObject({ thumbprint: key.thumbprint, status: 'active', usable: true });
    expect(proved.json<{ possessionProvedAt: string }>().possessionProvedAt).toBeTruthy();

    const chain = await verifyChain(tenant.id);
    expect(chain.map((row) => row['action'])).toEqual(['grantex.agent_key.added', 'grantex.agent_key.proved']);
    expect(chain[1]!['metadata']).toMatchObject({ thumbprint: key.thumbprint, agent_id: agentId });
  }, 60_000);

  it('refuses a replayed proof, a proof by another key, the wrong audience and another key\'s nonce', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const key = await newKey();
    const other = await newKey();
    expect((await addKey(tenant, agentId, key)).statusCode).toBe(201);
    expect((await addKey(tenant, agentId, other)).statusCode).toBe(201);

    const nonce = (await challenge(tenant, agentId, key)).json<{ challenge: string }>().challenge;

    const wrongKey = await prove(tenant, agentId, key, await signProof(key, agentId, nonce, { signWith: other }));
    expect(wrongKey.statusCode).toBe(400);
    expect(wrongKey.json()).toMatchObject({ code: 'key_unproven' });

    const wrongAudience = await prove(tenant, agentId, key, await signProof(key, agentId, nonce, { aud: 'https://provider.example' }));
    expect(wrongAudience.statusCode).toBe(400);
    expect(wrongAudience.json()).toMatchObject({ code: 'audience_mismatch' });

    // The other key's own challenge, answered by the other key but submitted for this one.
    const otherNonce = (await challenge(tenant, agentId, other)).json<{ challenge: string }>().challenge;
    const crossed = await prove(tenant, agentId, key, await signProof(key, agentId, otherNonce));
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json()).toMatchObject({ code: 'key_unproven' });
    expect((await keyRow(key.thumbprint))!['status']).toBe('pending');

    // Failed attempts do not use the challenge up; the right proof still works once.
    const proof = await signProof(key, agentId, nonce);
    const first = await prove(tenant, agentId, key, proof);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await prove(tenant, agentId, key, proof);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'key_unproven' });
    expect(replay.json<{ message: string }>().message).toMatch(/already used/);
    // A fresh signature over the same nonce is a replay too.
    const resigned = await prove(tenant, agentId, key, await signProof(key, agentId, nonce));
    expect(resigned.statusCode).toBe(400);
    expect(resigned.json()).toMatchObject({ code: 'key_unproven' });

    // The other key's challenge was untouched by the crossed attempt.
    const otherProved = await prove(tenant, agentId, other, await signProof(other, agentId, otherNonce));
    expect(otherProved.statusCode, otherProved.body).toBe(200);
  }, 60_000);

  it('refuses an expired challenge and a superseded one', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const key = await newKey('EdDSA');
    expect((await addKey(tenant, agentId, key)).statusCode).toBe(201);

    const expired = (await challenge(tenant, agentId, key)).json<{ challenge: string }>().challenge;
    await sql`UPDATE agent_key_challenges SET expires_at = NOW() - INTERVAL '1 second' WHERE thumbprint = ${key.thumbprint}`;
    const late = await prove(tenant, agentId, key, await signProof(key, agentId, expired));
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ code: 'key_unproven' });
    expect(late.json<{ message: string }>().message).toMatch(/expired/);

    const older = (await challenge(tenant, agentId, key)).json<{ challenge: string }>().challenge;
    const newer = (await challenge(tenant, agentId, key)).json<{ challenge: string }>().challenge;
    const superseded = await prove(tenant, agentId, key, await signProof(key, agentId, older));
    expect(superseded.statusCode).toBe(400);
    expect(superseded.json()).toMatchObject({ code: 'key_unproven' });
    const current = await prove(tenant, agentId, key, await signProof(key, agentId, newer));
    expect(current.statusCode, current.body).toBe(200);

    // A key that is already active is not challenged again.
    const again = await challenge(tenant, agentId, key);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'KEY_ALREADY_ACTIVE' });
  }, 60_000);

  it('keeps one key to one agent across the history and the agents routes', async () => {
    const tenant = await newTenant();
    const first = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (a)');
    const second = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (b)');
    const key = await newKey();
    expect((await addKey(tenant, first, key)).statusCode).toBe(201);

    const again = await addKey(tenant, first, key);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'KEY_ALREADY_REGISTERED' });

    const elsewhere = await addKey(tenant, second, key);
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });

    // The agents routes see the history too, with the answer they always gave.
    const viaPost = await call(tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4 (c)', scopes: SCOPES, publicJwk: key.jwk });
    expect(viaPost.statusCode).toBe(409);
    expect(viaPost.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });
    const viaPatch = await call(tenant, 'PATCH', `/v1/agents/${second}`, { publicJwk: key.jwk });
    expect(viaPatch.statusCode).toBe(409);
    expect(viaPatch.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });

    // A key held in another agent's legacy slot is refused by the history route.
    const legacy = await newKey();
    await createAgent(tenant, legacy.jwk, 'Nimbus Shopper 2.4 (d)');
    const taken = await addKey(tenant, first, legacy);
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });
  }, 60_000);

  it('keeps the legacy behaviour of PATCH /v1/agents: the replaced key ends at once and can be registered again', async () => {
    const tenant = await newTenant();
    const oldKey = await newKey('EdDSA');
    const newer = await newKey('EdDSA');
    const agentId = await createAgent(tenant, oldKey.jwk);
    await dpopVerified(agentId, oldKey.thumbprint);

    const patched = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: newer.jwk });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await keyRow(oldKey.thumbprint)).toMatchObject({ status: 'rotated' });
    expect(await keyRow(newer.thumbprint)).toMatchObject({ status: 'pending', agent_id: agentId });
    const oldRow = await keyRow(oldKey.thumbprint);
    expect(new Date(oldRow!['valid_to'] as string).getTime()).toBeLessThanOrEqual(Date.now());

    // As before this change, another agent may now register the replaced key.
    const other = await createAgent(tenant, oldKey.jwk, 'Nimbus Shopper 2.4 (e)');
    expect(await keyRow(oldKey.thumbprint)).toMatchObject({ status: 'pending', agent_id: other });
  }, 60_000);

  it('applies the P-256 rule to an agent that declares a payments rail', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const ed = await newKey('EdDSA');
    expect((await addKey(tenant, agentId, ed)).statusCode).toBe(201);

    const refused = await call(tenant, 'PUT', `/v1/agents/${agentId}/declared-rails`, { declaredRails: ['ap2'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });

    const bad = await call(tenant, 'PUT', `/v1/agents/${agentId}/declared-rails`, { declaredRails: ['card'] });
    expect(bad.statusCode).toBe(400);

    // An agent holding only P-256 keys (here, none yet) may declare the rail.
    const clean = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (payments)');
    const declared = await call(tenant, 'PUT', `/v1/agents/${clean}/declared-rails`, { declaredRails: ['ap2', 'ucp'] });
    expect(declared.statusCode, declared.body).toBe(200);
    expect(declared.json()).toEqual({ agentId: clean, declaredRails: ['ap2', 'ucp'] });

    const edKey = await newKey('EdDSA');
    const edRefused = await addKey(tenant, clean, edKey);
    expect(edRefused.statusCode).toBe(400);
    expect(edRefused.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });
    const p256 = await addKey(tenant, clean, await newKey('ES256'));
    expect(p256.statusCode, p256.body).toBe(201);
    expect(p256.json()).toMatchObject({ alg: 'ES256' });

    // The agents routes cannot slip a non-P-256 key past the rule either.
    const patched = await call(tenant, 'PATCH', `/v1/agents/${clean}`, { publicJwk: edKey.jwk });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });

    const listed = await call(tenant, 'GET', keysUrl(clean));
    expect(listed.json()).toMatchObject({ declaredRails: ['ap2', 'ucp'] });
    expect(listed.json<{ keys: unknown[] }>().keys).toHaveLength(1);

    // Dropping the payments rail lifts the rule again.
    const dropped = await call(tenant, 'PUT', `/v1/agents/${clean}/declared-rails`, { declaredRails: ['acp'] });
    expect(dropped.statusCode).toBe(200);
    expect((await addKey(tenant, clean, edKey)).statusCode).toBe(201);
  }, 60_000);

  it('rotates to an active replacement with a seven-day overlap by default, and not to an unproven one', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const oldKey = await activeKey(tenant, agentId);
    const pending = await newKey();
    expect((await addKey(tenant, agentId, pending)).statusCode).toBe(201);

    const unproven = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), { replacementThumbprint: pending.thumbprint });
    expect(unproven.statusCode).toBe(409);
    expect(unproven.json()).toMatchObject({ code: 'key_unproven' });

    const pendingRotate = await call(tenant, 'POST', keyUrl(agentId, pending.thumbprint, 'rotate'), { replacementThumbprint: oldKey.thumbprint });
    expect(pendingRotate.statusCode).toBe(409);
    expect(pendingRotate.json()).toMatchObject({ code: 'key_not_active' });

    const self = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), { replacementThumbprint: oldKey.thumbprint });
    expect(self.statusCode).toBe(400);

    const tooLong = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), {
      replacementThumbprint: pending.thumbprint, overlapSeconds: 31 * 86_400,
    });
    expect(tooLong.statusCode).toBe(400);

    const replacement = await activeKey(tenant, agentId);
    const before = Date.now();
    const rotated = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), { replacementThumbprint: replacement.thumbprint });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const result = rotated.json<{ rotated: { status: string; validTo: string; usable: boolean }; replacement: { rotatedFrom: string; status: string } }>();
    expect(result.rotated).toMatchObject({ status: 'rotated', usable: true });
    expect(result.replacement).toMatchObject({ status: 'active', rotatedFrom: oldKey.thumbprint });
    const end = new Date(result.rotated.validTo).getTime();
    expect(end).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS - 5_000);
    expect(end).toBeLessThanOrEqual(Date.now() + SEVEN_DAYS_MS + 5_000);

    // A rotated key cannot be rotated again, nor serve as a replacement.
    const twice = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), { replacementThumbprint: replacement.thumbprint });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ code: 'key_not_active' });

    const chain = await verifyChain(tenant.id);
    expect(chain.at(-1)).toMatchObject({ action: 'grantex.agent_key.rotated' });
  }, 60_000);

  it('honours the overlap up to valid_to and not at or after it', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const oldKey = await activeKey(tenant, agentId, 'EdDSA');
    const replacement = await activeKey(tenant, agentId, 'EdDSA');

    const rotated = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), {
      replacementThumbprint: replacement.thumbprint, overlapSeconds: 3600,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const end = new Date(rotated.json<{ rotated: { validTo: string } }>().rotated.validTo).getTime();
    expect(end - Date.now()).toBeGreaterThan(3_590_000);
    expect(end - Date.now()).toBeLessThanOrEqual(3_600_000);

    const usable = async () => {
      const listed = await call(tenant, 'GET', keysUrl(agentId));
      return listed.json<{ keys: Array<{ thumbprint: string; usable: boolean; denial?: string }> }>()
        .keys.find((k) => k.thumbprint === oldKey.thumbprint)!;
    };
    expect(await usable()).toMatchObject({ usable: true });

    await sql`UPDATE agent_keys SET valid_to = NOW() + INTERVAL '2 seconds' WHERE thumbprint = ${oldKey.thumbprint}`;
    expect(await usable()).toMatchObject({ usable: true });
    await sql`UPDATE agent_keys SET valid_to = NOW() WHERE thumbprint = ${oldKey.thumbprint}`;
    expect(await usable()).toMatchObject({ usable: false, denial: 'key_not_active' });
    await sql`UPDATE agent_keys SET valid_to = NOW() - INTERVAL '1 second' WHERE thumbprint = ${oldKey.thumbprint}`;
    expect(await usable()).toMatchObject({ usable: false, denial: 'key_not_active' });
  }, 60_000);

  it('the overlap default follows AGENT_KEY_ROTATION_OVERLAP_SECONDS', async () => {
    vi.stubEnv('AGENT_KEY_ROTATION_OVERLAP_SECONDS', '86400');
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    const oldKey = await activeKey(tenant, agentId);
    const replacement = await activeKey(tenant, agentId);
    const rotated = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), { replacementThumbprint: replacement.thumbprint });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const end = new Date(rotated.json<{ rotated: { validTo: string } }>().rotated.validTo).getTime();
    expect(Math.abs(end - (Date.now() + 86_400_000))).toBeLessThan(10_000);
  }, 60_000);

  it('a compromise ends the key at once and revokes every grant bound to it, with what was delegated from them', async () => {
    const tenant = await newTenant();
    const legacyKey = await newKey();
    const agentId = await createAgent(tenant, legacyKey.jwk);
    await dpopVerified(agentId, legacyKey.thumbprint);
    const subAgent = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (sub)');
    const unbound = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (unbound)');

    const bound = await mintGrant(tenant, agentId, 'shopper-01');
    const boundRow = await sql`SELECT agent_key_thumbprint FROM grants WHERE id = ${bound.grantId}`;
    expect(boundRow[0]!['agent_key_thumbprint']).toBe(legacyKey.thumbprint);
    const delegated = await call(tenant, 'POST', '/v1/grants/delegate', {
      parentGrantToken: bound.grantToken, subAgentId: subAgent, scopes: [SCOPES[0]], expiresIn: '30m',
    });
    expect(delegated.statusCode, delegated.body).toBe(201);
    const childGrantId = delegated.json<{ grantId: string }>().grantId;
    const unrelated = await mintGrant(tenant, unbound, 'shopper-02');
    // Approved before the compromise, not yet exchanged: bound to the key.
    const pendingCode = (await call(tenant, 'POST', '/v1/authorize', { agentId, principalId: 'shopper-03', scopes: SCOPES }))
      .json<{ code: string }>().code;

    const replacement = await activeKey(tenant, agentId);

    const compromised = await call(tenant, 'POST', keyUrl(agentId, legacyKey.thumbprint, 'compromise'), { reason: 'device lost' });
    expect(compromised.statusCode, compromised.body).toBe(200);
    expect(compromised.json()).toMatchObject({
      key: { thumbprint: legacyKey.thumbprint, status: 'compromised', usable: false, denial: 'key_not_active' },
      grantsRevoked: 2,
      agentKey: 'promoted',
      promotedThumbprint: replacement.thumbprint,
      agentSuspended: false,
    });
    const row = await keyRow(legacyKey.thumbprint);
    expect(new Date(row!['valid_to'] as string).getTime()).toBeLessThanOrEqual(Date.now());

    expect(await grantStatus(bound.grantId)).toBe('revoked');
    expect(await grantStatus(childGrantId)).toBe('revoked');
    expect(await grantStatus(unrelated.grantId)).toBe('active');

    // The code approved under the key is no longer exchangeable.
    const exchange = await call(tenant, 'POST', '/v1/token', { code: pendingCode, agentId });
    expect(exchange.statusCode).toBe(400);

    // Paths that still read the single registered key now see the replacement.
    const agent = await sql`SELECT key_thumbprint, key_verified_thumbprint, public_jwk, status FROM agents WHERE id = ${agentId}`;
    expect(agent[0]).toMatchObject({
      key_thumbprint: replacement.thumbprint, key_verified_thumbprint: replacement.thumbprint, status: 'active',
    });

    const chain = await verifyChain(tenant.id);
    const actions = chain.map((entry) => entry['action']);
    expect(actions).toContain('grantex.agent_key.compromised');
    const revocations = chain.filter((entry) => entry['action'] === 'grantex.grant.revoked');
    expect(revocations.map((entry) => entry['grant_id']).sort()).toEqual([bound.grantId, childGrantId].sort());
    expect(revocations[0]!['metadata']).toMatchObject({ key_thumbprint: legacyKey.thumbprint, cause: 'api' });

    // Never usable again, by this agent or any other.
    const challenged = await challenge(tenant, agentId, legacyKey);
    expect(challenged.statusCode).toBe(409);
    expect(challenged.json()).toMatchObject({ code: 'key_not_active' });
    const rotateAway = await call(tenant, 'POST', keyUrl(agentId, legacyKey.thumbprint, 'rotate'), { replacementThumbprint: replacement.thumbprint });
    expect(rotateAway.statusCode).toBe(409);
    const readd = await addKey(tenant, subAgent, legacyKey);
    expect(readd.statusCode).toBe(409);
    const repatch = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: legacyKey.jwk });
    expect(repatch.statusCode).toBe(409);
    expect(repatch.json()).toMatchObject({ code: 'key_not_active' });
    const repost = await call(tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4 (f)', scopes: SCOPES, publicJwk: legacyKey.jwk });
    expect(repost.statusCode).toBe(409);

    // Reporting it again is safe: nothing left to revoke.
    const again = await call(tenant, 'POST', keyUrl(agentId, legacyKey.thumbprint, 'compromise'), {});
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ grantsRevoked: 0, alreadyCompromised: true });
  }, 120_000);

  it('a compromise of the only key suspends the agent and clears its registered key', async () => {
    const tenant = await newTenant();
    const key = await newKey('EdDSA');
    const agentId = await createAgent(tenant, key.jwk);
    const res = await call(tenant, 'POST', keyUrl(agentId, key.thumbprint, 'compromise'), {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ agentKey: 'cleared', agentSuspended: true, grantsRevoked: 0 });
    const agent = await sql`SELECT key_thumbprint, public_jwk, key_verified_thumbprint, status FROM agents WHERE id = ${agentId}`;
    expect(agent[0]).toMatchObject({ key_thumbprint: null, public_jwk: null, key_verified_thumbprint: null, status: 'suspended' });
    expect(await keyRow(key.thumbprint)).toMatchObject({ status: 'compromised' });
  }, 60_000);

  it('suspension from key compromise also revokes an unbound grant with lifecycle enabled', async () => {
    vi.stubEnv('AGENT_LIFECYCLE_STATES_ENABLED', 'true');
    const tenant = await newTenant();
    const key = await newKey('EdDSA');
    const agentId = await createAgent(tenant, key.jwk);
    const grantId = `grnt_key_lifecycle_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
              VALUES (${grantId}, ${agentId}, 'shopper-01', ${tenant.id}, ${SCOPES}, NOW() + INTERVAL '1 hour')`;

    const res = await call(tenant, 'POST', keyUrl(agentId, key.thumbprint, 'compromise'), {});

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ agentSuspended: true, grantsRevoked: 1 });
    expect(await grantStatus(grantId)).toBe('revoked');
  }, 60_000);

  it('a compromise of a key other than the registered one leaves the agent as it was', async () => {
    const tenant = await newTenant();
    const registered = await newKey();
    const agentId = await createAgent(tenant, registered.jwk);
    const extra = await activeKey(tenant, agentId);
    const res = await call(tenant, 'POST', keyUrl(agentId, extra.thumbprint, 'compromise'), {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ agentKey: 'unchanged', agentSuspended: false });
    const agent = await sql`SELECT key_thumbprint, status FROM agents WHERE id = ${agentId}`;
    expect(agent[0]).toMatchObject({ key_thumbprint: registered.thumbprint, status: 'active' });
  }, 60_000);

  it('a compromised key stays refused after its agent is deleted, through every route that registers a key', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const key = await newKey();
    const agentId = await createAgent(tenant, key.jwk);
    expect((await call(tenant, 'POST', keyUrl(agentId, key.thumbprint, 'compromise'), {})).statusCode).toBe(200);
    const deleted = await call(tenant, 'DELETE', `/v1/agents/${agentId}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await keyRow(key.thumbprint)).toBeUndefined();

    const viaPost = await call(other, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4 (f)', scopes: SCOPES, publicJwk: key.jwk });
    expect(viaPost.statusCode, viaPost.body).toBe(409);
    expect(viaPost.json()).toMatchObject({ code: 'key_not_active' });

    const fresh = await createAgent(other, undefined, 'Nimbus Shopper 2.4 (g)');
    const viaKeys = await addKey(other, fresh, key);
    expect(viaKeys.statusCode, viaKeys.body).toBe(409);
    expect(viaKeys.json()).toMatchObject({ code: 'key_not_active' });

    const viaPatch = await call(other, 'PATCH', `/v1/agents/${fresh}`, { publicJwk: key.jwk });
    expect(viaPatch.statusCode, viaPatch.body).toBe(409);
    expect(viaPatch.json()).toMatchObject({ code: 'key_not_active' });

    // Even a write straight to the table cannot bring it back.
    await expect(sql`
      INSERT INTO agent_keys (thumbprint, agent_id, developer_id, jwk, alg, status)
      VALUES (${key.thumbprint}, ${fresh}, ${other.id}, ${sql.json(key.jwk as never)}, 'ES256', 'pending')`)
      .rejects.toMatchObject({ constraint_name: 'chk_agent_keys_not_compromised' });
  }, 60_000);

  it('the documented rotation: rotate in the history, then make the replacement the registered key', async () => {
    const tenant = await newTenant();
    const oldKey = await newKey();
    const agentId = await createAgent(tenant, oldKey.jwk);
    await dpopVerified(agentId, oldKey.thumbprint);
    const replacement = await activeKey(tenant, agentId);

    const rotated = await call(tenant, 'POST', keyUrl(agentId, oldKey.thumbprint, 'rotate'), {
      replacementThumbprint: replacement.thumbprint,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    // Rotation alone leaves the registered key, the one the token endpoints bind to, as it was.
    const before = await sql`SELECT key_thumbprint FROM agents WHERE id = ${agentId}`;
    expect(before[0]).toMatchObject({ key_thumbprint: oldKey.thumbprint });
    const validTo = (await keyRow(oldKey.thumbprint))!['valid_to'];

    const patched = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: replacement.jwk });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ keyPossessionVerified: false });
    const after = await sql`SELECT key_thumbprint FROM agents WHERE id = ${agentId}`;
    expect(after[0]).toMatchObject({ key_thumbprint: replacement.thumbprint });
    // The history is unchanged: the replacement stays proven, the old key keeps its overlap.
    expect(await keyRow(replacement.thumbprint)).toMatchObject({ status: 'active', rotated_from: oldKey.thumbprint });
    const old = await keyRow(oldKey.thumbprint);
    expect(old).toMatchObject({ status: 'rotated' });
    expect(new Date(old!['valid_to'] as string).toISOString()).toBe(new Date(validTo as string).toISOString());
  }, 60_000);

  it('a payments rail cannot be declared while the registered key is not P-256, even after its overlap', async () => {
    const tenant = await newTenant();
    const ed = await newKey('EdDSA');
    const agentId = await createAgent(tenant, ed.jwk);
    await dpopVerified(agentId, ed.thumbprint);
    const p256 = await activeKey(tenant, agentId);
    const rotated = await call(tenant, 'POST', keyUrl(agentId, ed.thumbprint, 'rotate'), {
      replacementThumbprint: p256.thumbprint, overlapSeconds: 0,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);

    const refused = await call(tenant, 'PUT', `/v1/agents/${agentId}/declared-rails`, { declaredRails: ['ap2'] });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });

    // Once the P-256 key is the registered key, the rail can be declared.
    expect((await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: p256.jwk })).statusCode).toBe(200);
    const declared = await call(tenant, 'PUT', `/v1/agents/${agentId}/declared-rails`, { declaredRails: ['ap2'] });
    expect(declared.statusCode, declared.body).toBe(200);

    // And the rotated-out Ed25519 key cannot be brought back as the registered key.
    const back = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: ed.jwk });
    expect(back.statusCode, back.body).toBe(400);
    expect(back.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });
    expect(await keyRow(ed.thumbprint)).toMatchObject({ status: 'rotated' });
  }, 60_000);

  it('keeps every key route to the agent\'s own developer', async () => {
    const owner = await newTenant();
    const stranger = await newTenant();
    const agentId = await createAgent(owner);
    const key = await activeKey(owner, agentId);
    const replacement = await activeKey(owner, agentId);
    const foreign = await newKey();

    const attempts = [
      await call(stranger, 'GET', keysUrl(agentId)),
      await call(stranger, 'POST', keysUrl(agentId), { publicJwk: foreign.jwk }),
      await call(stranger, 'PUT', `/v1/agents/${agentId}/declared-rails`, { declaredRails: [] }),
      await call(stranger, 'POST', keyUrl(agentId, key.thumbprint, 'challenge')),
      await call(stranger, 'POST', keyUrl(agentId, key.thumbprint, 'prove'), { proof: 'a.b.c' }),
      await call(stranger, 'POST', keyUrl(agentId, key.thumbprint, 'rotate'), { replacementThumbprint: replacement.thumbprint }),
      await call(stranger, 'POST', keyUrl(agentId, key.thumbprint, 'compromise'), {}),
    ];
    for (const res of attempts) {
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(await keyRow(key.thumbprint)).toMatchObject({ status: 'active' });

    // A thumbprint of another agent, even the owner's own, is not found under this agent.
    const sibling = await createAgent(owner, undefined, 'Nimbus Shopper 2.4 (sibling)');
    const crossed = await call(owner, 'POST', keyUrl(sibling, key.thumbprint, 'compromise'), {});
    expect(crossed.statusCode).toBe(404);
  }, 60_000);

  it('caps the keys an agent holds at once', async () => {
    const tenant = await newTenant();
    const agentId = await createAgent(tenant);
    for (let i = 0; i < 10; i += 1) {
      expect((await addKey(tenant, agentId, await newKey('EdDSA'))).statusCode).toBe(201);
    }
    const eleventh = await addKey(tenant, agentId, await newKey('EdDSA'));
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json()).toMatchObject({ code: 'KEY_LIMIT_REACHED' });
  }, 60_000);
});

describePostgres('POST and PATCH /v1/agents with the history mirror off (the default)', () => {
  const AGENT_FIELDS = [
    'agentId', 'createdAt', 'description', 'developerId', 'did', 'keyBindingConfigured', 'keyPossessionVerified',
    'keyThumbprint', 'name', 'publicJwk', 'redirectUris', 'resourceServers', 'retiredAt', 'scopes', 'status',
    'statusChangedAt', 'statusReason', 'updatedAt',
  ];

  beforeEach(() => {
    // Anything but exactly 'true' is off.
    vi.stubEnv('AGENT_KEY_HISTORY_MIRROR_ENABLED', 'TRUE');
  });

  it('installs nothing on agents: no trigger and no mirror function', async () => {
    const triggers = await sql`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'agents'::regclass AND NOT tgisinternal`;
    expect(triggers.map((row) => row['tgname'])).not.toContain('agents_key_mirror_trg');
    const functions = await sql`SELECT proname FROM pg_proc WHERE proname = 'grantex_agent_key_mirror'`;
    expect(functions).toHaveLength(0);
  }, 60_000);

  it('writes only the agents row, with the response the routes gave before the history existed', async () => {
    const tenant = await newTenant();
    const first = await newKey('EdDSA');
    const second = await newKey();

    const created = await call(tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4', scopes: SCOPES, publicJwk: first.jwk });
    expect(created.statusCode, created.body).toBe(201);
    expect(Object.keys(created.json()).sort()).toEqual(AGENT_FIELDS);
    expect(created.json()).toMatchObject({ keyThumbprint: first.thumbprint, keyBindingConfigured: true, keyPossessionVerified: false });
    const agentId = created.json<{ agentId: string }>().agentId;
    expect(await keyRow(first.thumbprint)).toBeUndefined();

    await dpopVerified(agentId, first.thumbprint);
    const patched = await call(tenant, 'PATCH', `/v1/agents/${agentId}`, { publicJwk: second.jwk, name: 'Nimbus Shopper 2.4 (renamed)' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(Object.keys(patched.json()).sort()).toEqual(AGENT_FIELDS);
    expect(patched.json()).toMatchObject({
      keyThumbprint: second.thumbprint, keyPossessionVerified: false, name: 'Nimbus Shopper 2.4 (renamed)',
      did: `did:web:grantex.dev:agents:${agentId}`,
    });
    expect(await keyRow(first.thumbprint)).toBeUndefined();
    expect(await keyRow(second.thumbprint)).toBeUndefined();
    const history = await sql`SELECT thumbprint FROM agent_keys WHERE agent_id = ${agentId}`;
    expect(history).toHaveLength(0);

    // The agents index still decides a conflict between registered keys, as before.
    const taken = await call(tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4 (b)', scopes: SCOPES, publicJwk: second.jwk });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });
    const missing = await call(tenant, 'PATCH', '/v1/agents/ag_does_not_exist', { publicJwk: first.jwk });
    expect(missing.statusCode).toBe(404);
  }, 60_000);

  it('refuses nothing the history would: those refusals need the flag', async () => {
    const tenant = await newTenant();
    // A key held in another agent's history.
    const holder = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (holder)');
    const held = await newKey();
    expect((await addKey(tenant, holder, held)).statusCode).toBe(201);
    const viaPost = await call(tenant, 'POST', '/v1/agents', { name: 'Nimbus Shopper 2.4 (c)', scopes: SCOPES, publicJwk: held.jwk });
    expect(viaPost.statusCode, viaPost.body).toBe(201);

    // A key reported compromised.
    const reporter = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (reporter)');
    const leaked = await newKey();
    expect((await addKey(tenant, reporter, leaked)).statusCode).toBe(201);
    expect((await call(tenant, 'POST', keyUrl(reporter, leaked.thumbprint, 'compromise'), {})).statusCode).toBe(200);
    const target = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (target)');
    const viaPatch = await call(tenant, 'PATCH', `/v1/agents/${target}`, { publicJwk: leaked.jwk });
    expect(viaPatch.statusCode, viaPatch.body).toBe(200);
    // The history itself still refuses it.
    const readd = await addKey(tenant, target, leaked);
    expect(readd.statusCode).toBe(409);
    expect(readd.json()).toMatchObject({ code: 'key_not_active' });

    // A non-P-256 key under a payments rail.
    const payments = await createAgent(tenant, undefined, 'Nimbus Shopper 2.4 (payments)');
    expect((await call(tenant, 'PUT', `/v1/agents/${payments}/declared-rails`, { declaredRails: ['ap2'] })).statusCode).toBe(200);
    const ed = await newKey('EdDSA');
    const edPatch = await call(tenant, 'PATCH', `/v1/agents/${payments}`, { publicJwk: ed.jwk });
    expect(edPatch.statusCode, edPatch.body).toBe(200);
    const edAdd = await addKey(tenant, payments, await newKey('EdDSA'));
    expect(edAdd.statusCode).toBe(400);
    expect(edAdd.json()).toMatchObject({ code: 'KEY_ALGORITHM_NOT_ALLOWED' });
  }, 60_000);

  it('the key routes still work for keys added through them, including the registered key', async () => {
    const tenant = await newTenant();
    const registered = await newKey();
    const agentId = await createAgent(tenant, registered.jwk);
    expect(await keyRow(registered.thumbprint)).toBeUndefined();

    // The registered key enters the history through the key route; a DPoP
    // proof of it counts as possession.
    const added = await addKey(tenant, agentId, registered);
    expect(added.statusCode, added.body).toBe(201);
    await dpopVerified(agentId, registered.thumbprint);
    const listed = await call(tenant, 'GET', keysUrl(agentId));
    expect(listed.json()).toMatchObject({ keys: [{ thumbprint: registered.thumbprint, status: 'active', usable: true }] });

    const replacement = await activeKey(tenant, agentId);
    const rotated = await call(tenant, 'POST', keyUrl(agentId, registered.thumbprint, 'rotate'), {
      replacementThumbprint: replacement.thumbprint,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json()).toMatchObject({ rotated: { status: 'rotated' }, replacement: { status: 'active' } });

    const compromised = await call(tenant, 'POST', keyUrl(agentId, registered.thumbprint, 'compromise'), {});
    expect(compromised.statusCode, compromised.body).toBe(200);
    expect(compromised.json()).toMatchObject({ agentKey: 'promoted', promotedThumbprint: replacement.thumbprint });
    const agent = await sql`SELECT key_thumbprint FROM agents WHERE id = ${agentId}`;
    expect(agent[0]).toMatchObject({ key_thumbprint: replacement.thumbprint });
  }, 60_000);
});

describePostgres('migration 122 backfill', () => {
  let backfillSql: Sql;
  let dropBackfill: (() => Promise<void>) | undefined;
  const notices: Array<{ severity?: string; message?: string }> = [];

  beforeAll(async () => {
    const db = await createTestDatabase('agent-keys-backfill');
    dropBackfill = db.drop;
    backfillSql = postgres(db.url, {
      max: 2, idle_timeout: 5, connect_timeout: 10,
      onnotice: (notice) => { notices.push(notice as { severity?: string; message?: string }); },
    });
  }, 60_000);

  afterAll(async () => {
    await backfillSql?.end({ timeout: 5 }).catch(() => undefined);
    await dropBackfill?.();
  }, 60_000);

  it('backfills every registered key: active when DPoP-proven, pending otherwise', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
    const before = files.filter((file) => file < MIGRATION);
    for (const file of before) await backfillSql.unsafe(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));

    const proven = await newKey();
    const unproven = await newKey('EdDSA');
    const stale = await newKey();
    const staleOther = await newKey();
    const developer = `dev_backfill_${randomBytes(4).toString('hex')}`;
    await backfillSql`INSERT INTO developers (id, api_key_hash, name, mode)
                      VALUES (${developer}, ${hashApiKey(`gx_test_${developer}`)}, 'Backfill', 'sandbox')`;
    const insert = (id: string, key: Key | null, verified: string | null) => backfillSql`
      INSERT INTO agents (id, did, developer_id, name, scopes, public_jwk, key_thumbprint, key_verified_thumbprint, key_verified_at)
      VALUES (${id}, ${`did:grantex:${id}`}, ${developer}, 'Nimbus Shopper 2.4', ${SCOPES},
              ${key ? backfillSql.json(key.jwk as never) : null}, ${key?.thumbprint ?? null},
              ${verified}, ${verified ? new Date('2026-09-01T00:00:00.000Z') : null})`;
    await insert('ag_backfill_proven', proven, proven.thumbprint);
    await insert('ag_backfill_unproven', unproven, null);
    // Proven once, for a key it no longer holds.
    await insert('ag_backfill_stale', stale, staleOther.thumbprint);
    await insert('ag_backfill_keyless', null, null);
    // A key type no route accepts (secp256k1): it cannot enter the history,
    // and the migration says so rather than leaving it out silently.
    const unsupported = { kty: 'EC', crv: 'secp256k1', x: stale.jwk.x!, y: stale.jwk.y! } as JWK;
    await backfillSql`
      INSERT INTO agents (id, did, developer_id, name, scopes, public_jwk, key_thumbprint)
      VALUES ('ag_backfill_unsupported', 'did:grantex:ag_backfill_unsupported', ${developer}, 'Nimbus Shopper 2.4', ${SCOPES},
              ${backfillSql.json(unsupported as never)}, ${randomBytes(32).toString('base64url')})`;

    notices.length = 0;
    await backfillSql.unsafe(readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf-8'));
    const warnings = notices.filter((notice) => notice.severity === 'WARNING');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('1 registered agent key');
    expect(warnings[0]!.message).toContain('ag_backfill_unsupported');

    const rows = await backfillSql<Array<{ thumbprint: string; agent_id: string; status: string; alg: string; possession_proved_at: Date | null; jwk: JWK }>>`
      SELECT thumbprint, agent_id, status, alg, possession_proved_at, jwk FROM agent_keys ORDER BY agent_id`;
    expect(rows.map((row) => [row.agent_id, row.status, row.alg])).toEqual([
      ['ag_backfill_proven', 'active', 'ES256'],
      ['ag_backfill_stale', 'pending', 'ES256'],
      ['ag_backfill_unproven', 'pending', 'EdDSA'],
    ]);
    const byAgent = new Map(rows.map((row) => [row.agent_id, row]));
    expect(byAgent.get('ag_backfill_proven')!.possession_proved_at?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(byAgent.get('ag_backfill_stale')!.possession_proved_at).toBeNull();
    // The stored thumbprints are RFC 7638 thumbprints of the stored keys.
    for (const row of rows) expect(jwkThumbprint(row.jwk)).toBe(row.thumbprint);

    // Idempotent: applying it again, then the whole runner, changes nothing.
    await backfillSql.unsafe(readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf-8'));
    await runMigrations(backfillSql);
    const again = await backfillSql`SELECT thumbprint, status FROM agent_keys ORDER BY thumbprint`;
    expect(again).toHaveLength(3);
    const declared = await backfillSql`SELECT declared_rails FROM agents WHERE id = 'ag_backfill_keyless'`;
    expect(declared[0]!['declared_rails']).toEqual([]);
  }, 120_000);
});

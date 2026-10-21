// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * OACP artifact authority against real Postgres, through the routes: ES256
 * issuance with a DB-backed issuer key, persistence of every issue and
 * refusal, replay, revocation through the OACP Token Status List, the
 * revocation artifact, JWKS publication, and key rotation and revocation.
 * The SQL mock forwards to a database of this file's own.
 */
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { verifyOacpArtifact, type OacpStatusValue } from '../src/lib/commerce/oacp-jws.js';
import { resetOacpIssuerKeyCache } from '../src/lib/commerce/oacp-issuer-keys.js';
import { resetOacpStatusCache } from '../src/lib/commerce/oacp-status.js';
import { decodeTokenStatusList } from '../src/lib/registry/status-list-codec.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres OACP artifact tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const SERVICE_TOKEN = 'agenticorg-oacp-fixture-service-key';
const TENANT = 'cten_OACPINT';
type Sql = ReturnType<typeof postgres>;

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
const savedFlag = process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'];

function authorityRequest(overrides: Record<string, unknown> = {}) {
  const observed = new Date(Date.now() - 60_000).toISOString();
  return {
    request_id: 'agenticorg_oacp_req_001',
    tenant_id: TENANT,
    merchant_id: 'mch_OACPINT',
    seller_agent_id: 'seller_OACPINT',
    merchant_display_name: 'Synthetic Store',
    commerce_categories: ['home_goods'],
    connector_choice: 'shopify',
    connector_mode: 'read_only',
    requested_authority_scope: ['merchant_profile', 'catalog_snapshot'],
    artifact_cache_scope: { tenant_id: TENANT, merchant_id: 'mch_OACPINT', seller_agent_id: 'seller_OACPINT' },
    source_freshness_policy: { max_age_seconds: 600 },
    source_evidence_ref: 'agenticorg:shopify:evidence:oacp_int:redacted',
    source_observed_at: observed,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

function connectorEvidence(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: 'shopify_evidence_OACPINT',
    tenant_id: TENANT,
    merchant_id: 'mch_OACPINT',
    seller_agent_id: 'seller_OACPINT',
    source_system: 'shopify',
    source_evidence_ref: 'agenticorg:shopify:evidence:oacp_int:redacted',
    source_observed_at: new Date(Date.now() - 60_000).toISOString(),
    product_count: 2,
    variant_count: 3,
    catalog_sample_refs: ['agenticorg:catalog:item:1:redacted'],
    price_snapshot_refs: ['agenticorg:price:item:1:redacted'],
    inventory_snapshot_refs: ['agenticorg:inventory:item:1:redacted'],
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

const service = { authorization: `Bearer ${SERVICE_TOKEN}` };
const admin = { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };

async function issue() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commerce/oacp/c6z/authority-requests',
    headers: service,
    payload: { request: authorityRequest(), connector_evidence: connectorEvidence() },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ artifacts: Array<{ artifact_family: string; envelope: Record<string, any>; payload: Record<string, unknown> }> }>();
}

async function jwks(): Promise<{ keys: Array<Record<string, unknown>> }> {
  const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** What a relying party does: fetch the list, verify it with the JWKS, read the entry. */
async function statusOf(envelope: Record<string, any>): Promise<OacpStatusValue> {
  const { uri, idx } = envelope['status']['status_list'] as { uri: string; idx: number };
  const path = new URL(uri).pathname;
  const res = await app.inject({ method: 'GET', url: path });
  if (res.statusCode !== 200) return 'unavailable';
  expect(res.headers['content-type']).toContain('application/statuslist+jwt');
  const keySet = createLocalJWKSet((await jwks()) as never);
  const { payload, protectedHeader } = await jwtVerify(res.body, keySet, { typ: 'statuslist+jwt' });
  expect(protectedHeader.typ).toBe('statuslist+jwt');
  expect(payload.sub).toBe(uri);
  return decodeTokenStatusList(payload['status_list'] as { bits: number; lst: string }).statusAt(idx);
}

async function verifyThroughPublicSurfaces(item: { envelope: Record<string, any>; payload: unknown }) {
  return verifyOacpArtifact({
    envelope: item.envelope,
    payload: item.payload,
    jwks: await jwks(),
    now_iso: new Date().toISOString(),
    status: await statusOf(item.envelope),
  });
}

describePostgres('OACP artifacts against Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('oacp-artifacts');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    // The public status route is registered at boot.
    process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'] = 'true';
    app = await buildTestApp();
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'];
    else process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'] = savedFlag;
    await app?.close();
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await dropTestDatabase?.();
  }, 60_000);

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
    vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'true');
    resetOacpIssuerKeyCache();
    resetOacpStatusCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed with 503 when no issuer key exists and auto-generation is off', async () => {
    vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'false');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: service,
      payload: { request: authorityRequest(), connector_evidence: connectorEvidence() },
    });
    expect(res.statusCode, res.body).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('oacp_issuer_key_unavailable');
    expect(await sql`SELECT 1 FROM oacp_artifacts WHERE status = 'issued'`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM oacp_status_entries`).toHaveLength(0);
  });

  it('binds mandate_capability_evidence from the authority request into the signed, stored artifact (G43)', async () => {
    const evidence = {
      schema_version: 'oacp.mandate_capability_evidence.v1',
      evidence_id: 'plural_pine_capability_int',
      tenant_id: TENANT,
      merchant_id: 'mch_OACPINT',
      provider: 'plural_pine',
      provider_environment: 'sandbox',
      result_status: 'available',
      external_validation_performed: true,
      rails: ['plural'],
      caps: [{ rail: 'plural', max_amount: 250000, currency: 'INR' }],
      token_types: ['network_token'],
      verified_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      redacted_evidence_ref: 'provider:plural_pine:capability:abcdef0123456789abcdef01:redacted',
      evidence_hash: 'b'.repeat(64),
    };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: service,
      payload: { request: authorityRequest(), connector_evidence: connectorEvidence(), mandate_capability_evidence: evidence },
    });
    expect(res.statusCode, res.body).toBe(201);
    const artifact = res.json<{ artifacts: Array<{ artifact_family: string; envelope: Record<string, any>; payload: Record<string, unknown> }> }>()
      .artifacts.find((a) => a.artifact_family === 'mandate_capability')!;
    expect(artifact.payload).toMatchObject({ mandate_capability_status: 'verified', mandate_capability_ref: evidence.redacted_evidence_ref });
    expect(await verifyThroughPublicSurfaces(artifact)).toMatchObject({ valid: true });
    const [row] = await sql`SELECT payload FROM oacp_artifacts WHERE artifact_id = ${artifact.envelope['artifact_id'] as string}`;
    expect((row!['payload'] as Record<string, any>)['mandate_capability_evidence']['evidence_hash']).toBe(evidence.evidence_hash);

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: service,
      payload: { request: authorityRequest(), connector_evidence: connectorEvidence(), mandate_capability_evidence: { ...evidence, client_secret: 'x' } },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ refusal_code: string }>().refusal_code).toBe('mandate_capability_evidence_invalid');
  });

  it('suspends and reinstates an artifact through the status list (status 2)', async () => {
    const body = await issue();
    const artifact = body.artifacts[0]!;
    const id = artifact.envelope['artifact_id'] as string;
    const suspend = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/suspend`, headers: service, payload: { reason_code: 'source_review' } });
    expect(suspend.statusCode, suspend.body).toBe(201);
    expect(suspend.json()).toMatchObject({ artifact_id: id, status: 'issued', suspension_reason: 'source_review', changed: true });
    resetOacpStatusCache();
    expect(await verifyThroughPublicSurfaces(artifact)).toMatchObject({ valid: false, refusal_code: 'artifact_suspended' });
    const reinstate = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/reinstate`, headers: admin, payload: {} });
    expect(reinstate.statusCode, reinstate.body).toBe(201);
    expect(reinstate.json()).toMatchObject({ suspended_at: null, changed: true });
    resetOacpStatusCache();
    expect(await verifyThroughPublicSurfaces(artifact)).toMatchObject({ valid: true });
    // Revocation stays final: a revoked artifact cannot be suspended or reinstated.
    await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/revoke`, headers: service, payload: {} });
    const late = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/suspend`, headers: service, payload: {} });
    expect(late.statusCode).toBe(409);
  });

  it('issues, persists and publishes 11 signed artifacts that verify through the JWKS and status list', async () => {
    const body = await issue();
    expect(body.artifacts).toHaveLength(11);
    const keys = await jwks();
    const kid = body.artifacts[0]!.envelope['issuer_key_id'] as string;
    expect(kid).toMatch(/^oacp-\d{8}-[0-9a-f]{16}$/);
    expect(keys.keys.filter((key) => key['kid'] === kid)).toEqual([
      expect.objectContaining({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid }),
    ]);
    expect(JSON.stringify(keys)).not.toMatch(/"d":/);

    for (const artifact of body.artifacts) {
      expect(artifact.envelope['issuer']).toBe('https://grantex.dev');
      expect(artifact.envelope['revocation_status_url']).toMatch(/^https:\/\/grantex\.dev\/status\/oacp\/oacpl_/);
      expect(await verifyThroughPublicSurfaces(artifact)).toMatchObject({ valid: true });
    }

    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT a.artifact_id, a.status, a.jws, a.envelope, e.status AS entry_status
      FROM oacp_artifacts a JOIN oacp_status_entries e ON e.artifact_id = a.artifact_id
      WHERE a.artifact_id = ANY(${body.artifacts.map((a) => a.envelope['artifact_id'] as string)})`;
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row['status']).toBe('issued');
      expect(row['entry_status']).toBe(0);
      expect(row['jws']).toBe((row['envelope'] as Record<string, unknown>)['signature']);
    }
  });

  it('refuses a tampered payload or envelope read back from the store', async () => {
    const { artifacts } = await issue();
    const item = artifacts.find((a) => a.artifact_family === 'catalog_snapshot')!;
    const stored = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts/${item.envelope['artifact_id']}`, headers: service });
    expect(stored.statusCode).toBe(200);
    const view = stored.json<{ envelope: Record<string, any>; payload: Record<string, unknown>; status: string }>();
    expect(view.status).toBe('issued');
    expect(await verifyThroughPublicSurfaces(view)).toMatchObject({ valid: true });
    expect(await verifyThroughPublicSurfaces({ envelope: view.envelope, payload: { ...view.payload, product_count: 999 } }))
      .toMatchObject({ refusal_code: 'payload_hash_mismatch' });
    expect(await verifyThroughPublicSurfaces({ envelope: { ...view.envelope, merchant_id: 'mch_OTHER' }, payload: view.payload }))
      .toMatchObject({ refusal_code: 'detached_jws_verification_failed' });
  });

  it('records refusals without a signature or status entry', async () => {
    const entriesBefore = (await sql`SELECT count(*)::int AS n FROM oacp_status_entries`)[0]!['n'];
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: service,
      payload: { request: authorityRequest(), connector_evidence: connectorEvidence({ source_observed_at: '2020-01-01T00:00:00.000Z' }) },
    });
    expect(stale.statusCode, stale.body).toBe(422);
    expect(stale.json()).toMatchObject({ status: 'pending_sandbox_review', refusal_code: 'connector_evidence_stale' });
    const unsafe = await app.inject({
      method: 'POST',
      url: '/v1/commerce/oacp/c6z/authority-requests',
      headers: service,
      payload: { request: authorityRequest({ requested_authority_scope: ['checkout.create'] }), connector_evidence: connectorEvidence() },
    });
    expect(unsafe.statusCode, unsafe.body).toBe(422);
    const recordId = unsafe.json<{ refusal_record_id: string }>().refusal_record_id;
    expect(recordId).toMatch(/^oacp_ref_/);

    const refused = await sql<Array<Record<string, unknown>>>`
      SELECT refusal_code, jws, envelope, status_list_uri FROM oacp_artifacts
      WHERE status = 'refused' AND tenant_id = ${TENANT} ORDER BY created_at`;
    expect(refused.map((row) => row['refusal_code'])).toEqual(expect.arrayContaining(['connector_evidence_stale', 'private_or_executable_authority_request']));
    for (const row of refused) {
      expect(row['jws']).toBeNull();
      expect(row['envelope']).toBeNull();
      expect(row['status_list_uri']).toBeNull();
    }
    expect((await sql`SELECT count(*)::int AS n FROM oacp_status_entries`)[0]!['n']).toBe(entriesBefore);

    const view = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts/${recordId}`, headers: service });
    expect(view.json()).toMatchObject({ status: 'refused', envelope: null, refusal_code: 'private_or_executable_authority_request' });
  });

  it('replays a tenant\'s artifacts in order, page by page, and only for allowed tenants', async () => {
    await issue();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/commerce/oacp/artifacts?tenant_id=${TENANT}&merchant_id=mch_OACPINT&limit=7${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: service });
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<{ artifacts: Array<{ artifact_id: string; envelope: unknown; payload: unknown; status: string }>; next_cursor: string | null }>();
      expect(page.artifacts.length).toBeLessThanOrEqual(7);
      for (const item of page.artifacts) {
        expect(item).toHaveProperty('envelope');
        expect(item).toHaveProperty('payload');
        expect(['issued', 'refused', 'revoked']).toContain(item.status);
        seen.push(item.artifact_id);
      }
      cursor = page.next_cursor;
    } while (cursor);
    const all = await sql<Array<{ artifact_id: string }>>`
      SELECT artifact_id FROM oacp_artifacts WHERE tenant_id = ${TENANT} AND merchant_id = 'mch_OACPINT' ORDER BY created_at, artifact_id`;
    expect(seen).toEqual(all.map((row) => row.artifact_id));
    expect(new Set(seen).size).toBe(seen.length);

    const since = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts?tenant_id=${TENANT}&since=2999-01-01T00:00:00Z`, headers: service });
    expect(since.json()).toEqual({ artifacts: [], next_cursor: null });

    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', 'cten_SOMEONE_ELSE');
    const denied = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts?tenant_id=${TENANT}`, headers: service });
    expect(denied.statusCode).toBe(403);
    const hidden = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts/${seen[0]}`, headers: service });
    expect(hidden.statusCode).toBe(404);
  });

  it('revokes: flips the status list, marks the row and issues a signed revocation artifact', async () => {
    const { artifacts } = await issue();
    const target = artifacts.find((a) => a.artifact_family === 'offer_price_snapshot')!;
    const id = target.envelope['artifact_id'] as string;
    expect(await statusOf(target.envelope)).toBe(0);

    const res = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/revoke`, headers: service, payload: { reason_code: 'price_changed' } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ artifact_id: string; status: string; revoked_at: string; revocation_artifact: { artifact_id: string; envelope: Record<string, any>; payload: Record<string, any> } }>();
    expect(body).toMatchObject({ artifact_id: id, status: 'revoked' });
    expect(body.revoked_at).toBeTruthy();

    resetOacpStatusCache();
    expect(await statusOf(target.envelope)).toBe(1);
    expect(await verifyThroughPublicSurfaces(target)).toMatchObject({ refusal_code: 'artifact_revoked' });

    const revocation = body.revocation_artifact;
    expect(revocation.envelope['artifact_type']).toBe('revocation');
    expect(revocation.payload).toMatchObject({ revoked_artifact_ids: [id], reason_codes: ['price_changed'] });
    expect(await verifyThroughPublicSurfaces(revocation)).toMatchObject({ valid: true });

    const [row] = await sql<Array<Record<string, unknown>>>`SELECT status, revoked_at, revocation_artifact_id FROM oacp_artifacts WHERE artifact_id = ${id}`;
    expect(row).toMatchObject({ status: 'revoked', revocation_artifact_id: revocation.artifact_id });
    expect(row!['revoked_at']).not.toBeNull();

    const again = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${id}/revoke`, headers: service });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'revoked', revocation_artifact: { artifact_id: revocation.artifact_id } });
    const ofRevocation = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${revocation.artifact_id}/revoke`, headers: service });
    expect(ofRevocation.statusCode).toBe(409);
  });

  it('rotates: new artifacts use the new key, old ones keep verifying while the retired key is published', async () => {
    const before = await issue();
    const oldKid = before.artifacts[0]!.envelope['issuer_key_id'] as string;

    const denied = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/issuer-keys/rotate', headers: service });
    expect(denied.statusCode).toBe(401);
    const rotated = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/issuer-keys/rotate', headers: admin });
    expect(rotated.statusCode, rotated.body).toBe(201);
    const { kid: newKid, retired_kid } = rotated.json<{ kid: string; retired_kid: string }>();
    expect(retired_kid).toBe(oldKid);
    expect(newKid).not.toBe(oldKid);

    const after = await issue();
    expect(after.artifacts[0]!.envelope['issuer_key_id']).toBe(newKid);
    const kids = (await jwks()).keys.map((key) => key['kid']);
    expect(kids).toEqual(expect.arrayContaining([oldKid, newKid]));
    expect(await verifyThroughPublicSurfaces(before.artifacts[0]!)).toMatchObject({ valid: true });

    // Once every artifact the retired key signed has expired (and the grace
    // window passed), the key leaves the JWKS.
    await sql`UPDATE oacp_issuer_keys SET retired_at = NOW() - interval '2 days' WHERE kid = ${oldKid}`;
    await sql`UPDATE oacp_artifacts SET issued_at = issued_at - interval '2 days', expires_at = issued_at - interval '2 days' WHERE issuer_key_id = ${oldKid}`;
    expect((await jwks()).keys.map((key) => key['kid'])).not.toContain(oldKid);
    expect(await verifyThroughPublicSurfaces(before.artifacts[0]!)).toMatchObject({ refusal_code: 'issuer_key_untrusted' });
  });

  it('revoking a key withdraws it from the JWKS at once', async () => {
    const { artifacts } = await issue();
    const kid = artifacts[0]!.envelope['issuer_key_id'] as string;
    const res = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/issuer-keys/${kid}/revoke`, headers: admin });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ kid, status: 'revoked' });
    expect((await jwks()).keys.map((key) => key['kid'])).not.toContain(kid);
    expect(await verifyThroughPublicSurfaces(artifacts[0]!)).toMatchObject({ refusal_code: 'issuer_key_untrusted' });

    const listing = await app.inject({ method: 'GET', url: '/v1/commerce/oacp/issuer-keys', headers: admin });
    expect(listing.statusCode).toBe(200);
    expect(JSON.stringify(listing.json())).not.toMatch(/encrypted|"d":/);
  });

  it('serves 404 for an unknown status list', async () => {
    const res = await app.inject({ method: 'GET', url: '/status/oacp/oacpl_01J0000000000000000000000Z' });
    expect(res.statusCode).toBe(404);
  });
});

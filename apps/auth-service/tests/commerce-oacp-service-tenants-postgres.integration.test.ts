// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * OACP service-tenant enrolment against real Postgres, through the routes:
 * idempotent enrolment that unions merchants and sources, the append-only
 * enrolment trail, platform-admin read and revocation, a revoked tenant
 * refused everywhere, an enrolled tenant issuing artifacts, arbiter
 * decisions, mandates and witness checkpoints for its enrolled merchants
 * only, catalogue-upload lineage, public discovery for an enrolled tenant,
 * and env-listed tenants unchanged.
 */
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { resetOacpIssuerKeyCache } from '../src/lib/commerce/oacp-issuer-keys.js';
import { resetOacpStatusCache } from '../src/lib/commerce/oacp-status.js';
import { invalidateServiceTenantAccess } from '../src/lib/commerce/oacp-service-tenants.js';
import { signCommercePassport, newCommercePassportJti } from '../src/lib/commerce/passport.js';
import { _resetCommercePassportKeyCacheForTests } from '../src/lib/commerce/passport-keys.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres service-tenant tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const SERVICE_TOKEN = 'agenticorg-service-tenant-fixture-key';
const ENV_TENANT = 'cten_SVCENV';
type Sql = ReturnType<typeof postgres>;

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
const savedFlag = process.env['OACP_STATUS_LIST_PUBLIC_ENABLED'];
const service = { authorization: `Bearer ${SERVICE_TOKEN}` };
const admin = { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };

function enrol(body: Record<string, unknown>, headers: Record<string, string> = service) {
  return app.inject({ method: 'POST', url: '/v1/commerce/oacp/service-tenants', headers, payload: body });
}

function authorityRequest(tenant: string, merchant: string, overrides: Record<string, unknown> = {}) {
  const observed = new Date(Date.now() - 60_000).toISOString();
  const seller = `seller_${merchant}`;
  return {
    request_id: `req_${merchant}`,
    tenant_id: tenant,
    merchant_id: merchant,
    seller_agent_id: seller,
    merchant_display_name: 'Enrolled Store',
    commerce_categories: ['home_goods'],
    connector_choice: 'shopify',
    connector_mode: 'read_only',
    requested_authority_scope: ['merchant_profile', 'catalog_snapshot'],
    artifact_cache_scope: { tenant_id: tenant, merchant_id: merchant, seller_agent_id: seller },
    source_freshness_policy: { max_age_seconds: 600 },
    source_evidence_ref: `agenticorg:catalog:evidence:${merchant}:redacted`,
    source_observed_at: observed,
    no_payment_execution: true,
    no_public_discovery_enablement: true,
    ...overrides,
  };
}

function connectorEvidence(tenant: string, merchant: string, overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: `evidence_${merchant}`,
    tenant_id: tenant,
    merchant_id: merchant,
    seller_agent_id: `seller_${merchant}`,
    source_system: 'shopify',
    source_evidence_ref: `agenticorg:catalog:evidence:${merchant}:redacted`,
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

function issue(tenant: string, merchant: string, request: Record<string, unknown> = {}, evidence: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/commerce/oacp/c6z/authority-requests',
    headers: service,
    payload: { request: authorityRequest(tenant, merchant, request), connector_evidence: connectorEvidence(tenant, merchant, evidence) },
  });
}

function arbiterDecision(tenant: string, merchant: string) {
  return {
    decision_id: `arb_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tenant_id: tenant,
    merchant_id: merchant,
    seller_agent_id: 'seller-01',
    buyer_agent_id: 'shopper-01',
    action: 'payment_handoff',
    action_hash: 'a'.repeat(64),
    outcome: 'refuse',
    rules_evaluated: ['artifacts_verified'],
    failing_rule: 'artifacts_verified',
    evidence: { mandate_ref: null, mandate_hash: null, consent_ref: null, consent_status: null, passport_ref: null, artifact_ids: ['oacp_art_01'] },
    decided_at: new Date().toISOString(),
    policy_version: '2026-10-29',
  };
}

function code(res: { json: <T>() => T }): string {
  return res.json<{ error: { code: string } }>().error.code;
}

describePostgres('OACP service-tenant enrolment against Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('oacp-svc-tenants');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
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
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', ENV_TENANT);
    vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'true');
    vi.stubEnv('COMMERCE_AUTO_GENERATE_PASSPORT_KEY', 'true');
    resetOacpIssuerKeyCache();
    resetOacpStatusCache();
    _resetCommercePassportKeyCacheForTests();
    invalidateServiceTenantAccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('enrolment', () => {
    it('enrols idempotently, unions merchants and sources, and records every call', async () => {
      const tenant = randomUUID();
      const first = await enrol({ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'shopify', evidence_ref: 'agenticorg:onboarding:1' });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ tenant_id: tenant, status: 'active', merchant_ids: ['mch_A'], source_systems: ['shopify'], changed: true });
      expect(typeof first.json<{ enrolled_at: string }>().enrolled_at).toBe('string');

      const again = await enrol({ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'shopify' });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ merchant_ids: ['mch_A'], source_systems: ['shopify'], changed: false,
        evidence_ref: 'agenticorg:onboarding:1', enrolled_at: first.json<{ enrolled_at: string }>().enrolled_at });

      const widened = await enrol({ tenant_id: tenant.toUpperCase(), merchant_id: 'mch_B', source_system: 'catalog_upload' });
      expect(widened.statusCode, widened.body).toBe(200);
      expect(widened.json()).toMatchObject({ tenant_id: tenant, merchant_ids: ['mch_A', 'mch_B'], source_systems: ['catalog_upload', 'shopify'], changed: true });

      const rows = await sql`SELECT merchant_ids, source_systems, status FROM oacp_service_tenant_enrolments WHERE tenant_id = ${tenant}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ merchant_ids: ['mch_A', 'mch_B'], source_systems: ['catalog_upload', 'shopify'], status: 'active' });
      const events = await sql`SELECT event_type, actor, merchant_id, jsonb_typeof(metadata) AS kind
        FROM oacp_service_tenant_enrolment_events WHERE tenant_id = ${tenant} ORDER BY occurred_at, id`;
      expect(events.map((e) => e['event_type'])).toEqual(['oacp.service_tenant.enrolled', 'oacp.service_tenant.enrolled', 'oacp.service_tenant.enrolled']);
      expect(events.every((e) => e['actor'] === 'service:agenticorg_c6z_authority' && e['kind'] === 'object')).toBe(true);
      await expect(sql`UPDATE oacp_service_tenant_enrolment_events SET actor = 'x' WHERE tenant_id = ${tenant}`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM oacp_service_tenant_enrolment_events WHERE tenant_id = ${tenant}`).rejects.toThrow(/append-only/);
    });

    it('validates the body', async () => {
      const tenant = randomUUID();
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ tenant_id: 'cten_NOTUUID', merchant_id: 'mch_A', source_system: 'shopify' }, 'tenant_id'],
        [{ tenant_id: tenant, merchant_id: '-bad id', source_system: 'shopify' }, 'merchant_id'],
        [{ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'synthetic_demo' }, 'source_system'],
        [{ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'shopify', extra: true }, 'body'],
        [{ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'shopify', evidence_ref: 'has space' }, 'evidence_ref'],
      ];
      for (const [body, field] of cases) {
        const res = await enrol(body);
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields).toHaveProperty(field);
      }
      const unknown = await enrol({ tenant_id: tenant, merchant_id: 'mch_A', source_system: 'shopify', __proto__x: 1 });
      expect(unknown.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields['body'])
        .toBe('unknown member "__proto__x"');
      expect(await sql`SELECT 1 FROM oacp_service_tenant_enrolments WHERE tenant_id = ${tenant}`).toHaveLength(0);
    });

    it('accepts only the service token with its scope or the platform admin', async () => {
      const body = { tenant_id: randomUUID(), merchant_id: 'mch_A', source_system: 'shopify' };
      const unknown = await enrol(body, { authorization: 'Bearer not-a-real-developer-key-000' });
      expect(unknown.statusCode).toBe(401);
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', 'a-different-service-token-0000');
      const wrongToken = await enrol(body);
      expect(wrongToken.statusCode).toBe(401);
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
      const byAdmin = await enrol(body, admin);
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      // The service token carries no read or revoke scope.
      const read = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/service-tenants/${body.tenant_id}`, headers: service });
      expect(read.statusCode).toBe(401);
      const revoke = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/service-tenants/${body.tenant_id}/revoke`, headers: service, payload: {} });
      expect(revoke.statusCode).toBe(401);
    });

    it('lets the platform admin read and revoke; a revoked tenant is refused until the admin re-enrols it', async () => {
      const tenant = randomUUID();
      expect((await enrol({ tenant_id: tenant, merchant_id: 'mch_R', source_system: 'shopify' })).statusCode).toBe(200);
      expect((await issue(tenant, 'mch_R')).statusCode).toBe(201);

      const read = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/service-tenants/${tenant}`, headers: admin });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ tenant_id: tenant, status: 'active', merchant_ids: ['mch_R'] });
      const missing = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/service-tenants/${randomUUID()}`, headers: admin });
      expect(missing.statusCode).toBe(404);
      expect(code(missing)).toBe('service_tenant_not_found');

      const revoked = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/service-tenants/${tenant}/revoke`, headers: admin,
        payload: { reason_code: 'merchant_offboarded' } });
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json()).toMatchObject({ status: 'revoked', revoked_reason: 'merchant_offboarded', already_revoked: false });
      const twice = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/service-tenants/${tenant}/revoke`, headers: admin, payload: {} });
      expect(twice.json()).toMatchObject({ status: 'revoked', already_revoked: true });

      const refusedIssue = await issue(tenant, 'mch_R');
      expect(refusedIssue.statusCode).toBe(403);
      expect(code(refusedIssue)).toBe('service_tenant_revoked');
      const refusedArbiter = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: service,
        payload: arbiterDecision(tenant, 'mch_R') });
      expect(refusedArbiter.statusCode).toBe(403);
      expect(code(refusedArbiter)).toBe('service_tenant_revoked');
      const refusedEnrol = await enrol({ tenant_id: tenant, merchant_id: 'mch_R', source_system: 'shopify' });
      expect(refusedEnrol.statusCode).toBe(403);
      expect(code(refusedEnrol)).toBe('service_tenant_revoked');

      const reactivated = await enrol({ tenant_id: tenant, merchant_id: 'mch_R', source_system: 'shopify' }, admin);
      expect(reactivated.statusCode, reactivated.body).toBe(200);
      expect(reactivated.json()).toMatchObject({ status: 'active', revoked_at: null, merchant_ids: ['mch_R'] });
      expect((await issue(tenant, 'mch_R')).statusCode).toBe(201);

      const events = await sql`SELECT event_type, actor FROM oacp_service_tenant_enrolment_events WHERE tenant_id = ${tenant} ORDER BY occurred_at, id`;
      expect(events.map((e) => e['event_type'])).toEqual([
        'oacp.service_tenant.enrolled',
        'oacp.service_tenant.read',
        'oacp.service_tenant.revoked',
        'oacp.service_tenant.revoked',
        'oacp.service_tenant.enrolment_refused',
        'oacp.service_tenant.reactivated',
      ]);
      expect(events[1]!['actor']).toBe('platform_admin');
    });
  });

  describe('access for an enrolled tenant', () => {
    it('issues, reads, lists and renders for an enrolled merchant only', async () => {
      const tenant = randomUUID();
      const notEnrolled = await issue(tenant, 'mch_E1');
      expect(notEnrolled.statusCode).toBe(403);
      expect(code(notEnrolled)).toBe('service_tenant_not_allowed');

      await enrol({ tenant_id: tenant, merchant_id: 'mch_E1', source_system: 'shopify' });
      const issued = await issue(tenant, 'mch_E1');
      expect(issued.statusCode, issued.body).toBe(201);
      const artifacts = issued.json<{ artifacts: Array<{ envelope: { artifact_id: string }; payload: Record<string, unknown> }> }>().artifacts;
      expect(artifacts[0]!.payload['source_system']).toBe('shopify');

      const otherMerchant = await issue(tenant, 'mch_OTHER');
      expect(otherMerchant.statusCode).toBe(403);
      expect(code(otherMerchant)).toBe('service_tenant_merchant_not_enrolled');

      const id = artifacts[0]!.envelope.artifact_id;
      expect((await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts/${id}`, headers: service })).statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts?tenant_id=${tenant}&merchant_id=mch_E1`, headers: service });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ artifacts: unknown[] }>().artifacts.length).toBe(artifacts.length);
      const unscoped = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts?tenant_id=${tenant}`, headers: service });
      expect(unscoped.statusCode).toBe(403);
      expect(code(unscoped)).toBe('service_tenant_merchant_not_enrolled');
      const ucp = await app.inject({ method: 'GET', headers: service,
        url: `/v1/commerce/oacp/ucp-profile?tenant_id=${tenant}&merchant_id=mch_OTHER&seller_agent_id=seller_mch_OTHER&served=dev.ucp.shopping.checkout` });
      expect(ucp.statusCode).toBe(403);
      expect(code(ucp)).toBe('service_tenant_merchant_not_enrolled');

      // Revoking an artifact of a merchant outside the enrolment answers like a missing one.
      await enrol({ tenant_id: tenant, merchant_id: 'mch_E2', source_system: 'shopify' });
      const second = await issue(tenant, 'mch_E2');
      expect(second.statusCode).toBe(201);
      const secondId = second.json<{ artifacts: Array<{ envelope: { artifact_id: string } }> }>().artifacts[0]!.envelope.artifact_id;
      await sql`UPDATE oacp_service_tenant_enrolments SET merchant_ids = ARRAY['mch_E1'] WHERE tenant_id = ${tenant}`;
      invalidateServiceTenantAccess(tenant);
      const hidden = await app.inject({ method: 'POST', url: `/v1/commerce/oacp/artifacts/${secondId}/revoke`, headers: service, payload: {} });
      expect(hidden.statusCode).toBe(404);
    });

    it('records arbiter decisions and settlement evidence only for enrolled merchants', async () => {
      const tenant = randomUUID();
      await enrol({ tenant_id: tenant, merchant_id: 'mch_ARB', source_system: 'shopify' });
      const ok = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: service,
        payload: arbiterDecision(tenant, 'mch_ARB') });
      expect(ok.statusCode, ok.body).toBe(201);
      const other = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: service,
        payload: arbiterDecision(tenant, 'mch_NOPE') });
      expect(other.statusCode).toBe(403);
      expect(code(other)).toBe('service_tenant_merchant_not_enrolled');
      const unknownTenant = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: service,
        payload: arbiterDecision(randomUUID(), 'mch_ARB') });
      expect(code(unknownTenant)).toBe('service_tenant_not_allowed');
      const settlement = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/commitment-evidence/settlement-receipts', headers: service,
        payload: { tenant_id: tenant, merchant_id: 'mch_NOPE' } });
      expect(settlement.statusCode).toBe(403);
      expect(code(settlement)).toBe('service_tenant_merchant_not_enrolled');
    });

    it('issues mandates for a passport of an enrolled merchant and refuses another merchant', async () => {
      const tenant = randomUUID();
      const merchant = 'mch_MNDENROL';
      const other = 'mch_MNDOTHER';
      const agent = `cag_${tenant.slice(0, 8)}`;
      const [preset] = await sql`SELECT preset_key FROM commerce_category_presets ORDER BY preset_key LIMIT 1`;
      await sql`INSERT INTO commerce_tenants (id, display_name) VALUES (${tenant}, 'Enrolled tenant')`;
      for (const id of [merchant, other]) {
        await sql`INSERT INTO commerce_merchants (id, tenant_id, legal_name, display_name, category_preset)
          VALUES (${id}, ${tenant}, 'Store Pvt Ltd', 'Store', ${preset!['preset_key'] as string})`;
      }
      const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
      await sql`INSERT INTO commerce_agents (id, tenant_id, display_name, public_key_jwk, trust_status)
        VALUES (${agent}, ${tenant}, 'shopper', ${sql.json({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as never)}, 'trusted')`;
      const passportFor = async (merchantId: string) => {
        const consentId = `crec_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        await sql`
          INSERT INTO commerce_consent_records (
            id, tenant_id, merchant_id, agent_id, consent_request_id, passport_type, requested_scopes,
            approved_scopes, max_amount, currency, consent_text_version, status, user_principal_id,
            approved_at, expires_at, presence, amr
          ) VALUES (
            ${consentId}, ${tenant}, ${merchantId}, ${agent}, ${`req_${consentId}`}, 'checkout',
            ${['commerce:checkout.create', 'commerce:payment.initiate']}, ${['commerce:checkout.create', 'commerce:payment.initiate']}, ${100000}, 'INR', '2026-05-01', 'granted',
            'buyer_enrolled', NOW(), NOW() + interval '10 minutes', 'human_not_present', ${['consent', 'otp']}
          )`;
        const now = Math.floor(Date.now() / 1000);
        const { jwt } = await signCommercePassport(sql, {
          jti: newCommercePassportJti(), passportType: 'checkout', tenantId: tenant, merchantId, agentId: agent,
          consentRecordId: consentId, subject: 'buyer_enrolled', scopes: ['commerce:checkout.create', 'commerce:payment.initiate'],
          maxAmount: 100000, currency: 'INR', presence: 'human_not_present', amr: ['consent', 'otp'],
          environment: 'sandbox', issuedAt: now, notBefore: now, expiresAt: now + 600,
        });
        return jwt;
      };
      await enrol({ tenant_id: tenant, merchant_id: merchant, source_system: 'shopify' });
      const body = (jwt: string) => ({ tenant_id: tenant, passport_jwt: jwt, description: 'A kettle',
        max_amount: { value: 50000, currency: 'INR' } });
      const ok = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/mandates/intent', headers: service, payload: body(await passportFor(merchant)) });
      expect(ok.statusCode, ok.body).toBe(201);
      const refused = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/mandates/intent', headers: service, payload: body(await passportFor(other)) });
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('service_tenant_merchant_not_enrolled');
      const verify = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/mandates/verify', headers: service,
        payload: { tenant_id: tenant, mandate: ok.json<{ mandate: string }>().mandate } });
      expect(verify.json()).toMatchObject({ valid: true });
    });

    it('applies the tenant check to witness checkpoints whose tenant_ref is a tenant UUID', async () => {
      const tenant = randomUUID();
      const checkpoint = (tenantRef: string) => ({ source: 'agenticorg', tenant_ref: tenantRef, chain: 'audit_log', head_seq: 1,
        head_hash: 'c'.repeat(64), anchored_at: new Date(Date.now() - 1000).toISOString() });
      const refused = await app.inject({ method: 'POST', url: '/v1/audit/witness-checkpoints', headers: service, payload: checkpoint(tenant) });
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe('SERVICE_TENANT_NOT_ALLOWED');
      const read = await app.inject({ method: 'GET', url: `/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=${tenant}`, headers: service });
      expect(read.statusCode).toBe(403);
      await enrol({ tenant_id: tenant, merchant_id: 'mch_W', source_system: 'shopify' });
      const ok = await app.inject({ method: 'POST', url: '/v1/audit/witness-checkpoints', headers: service, payload: checkpoint(tenant) });
      expect(ok.statusCode, ok.body).toBe(201);
      // An opaque, non-UUID reference has no tenant to check and is accepted as before.
      const opaque = await app.inject({ method: 'POST', url: '/v1/audit/witness-checkpoints', headers: service, payload: checkpoint('tenant-0001') });
      expect(opaque.statusCode, opaque.body).toBe(201);
    });
  });

  describe('catalogue upload and public discovery', () => {
    it('issues from a catalogue upload with honest lineage once the tenant enrolled that source', async () => {
      const tenant = randomUUID();
      await enrol({ tenant_id: tenant, merchant_id: 'mch_UP', source_system: 'shopify' });
      const upload = { connector_choice: 'catalog_upload' };
      const before = await issue(tenant, 'mch_UP', upload, { source_system: 'catalog_upload' });
      expect(before.statusCode).toBe(422);
      expect(before.json<{ refusal_code: string }>().refusal_code).toBe('unsupported_or_enabling_authority_request');

      await enrol({ tenant_id: tenant, merchant_id: 'mch_UP', source_system: 'catalog_upload' });
      const res = await issue(tenant, 'mch_UP', upload, { source_system: 'catalog_upload' });
      expect(res.statusCode, res.body).toBe(201);
      const artifacts = res.json<{ artifacts: Array<{ payload: Record<string, any> }> }>().artifacts;
      expect(artifacts.length).toBeGreaterThan(0);
      for (const { payload } of artifacts) {
        expect(payload['source_system']).toBe('catalog_upload');
        expect(payload).not.toHaveProperty('synthetic_data');
        expect(payload['source_lineage']).toMatchObject({
          source_system: 'catalog_upload', merchant_system_source_of_record: true, raw_provider_payload_stored_by_grantex: false,
        });
      }
      const synthetic = await issue(tenant, 'mch_UP', { ...upload, synthetic_data: true }, { source_system: 'catalog_upload', synthetic_data: true });
      expect(synthetic.statusCode).toBe(422);
      const mismatch = await issue(tenant, 'mch_UP', upload, { source_system: 'shopify' });
      expect(mismatch.json<{ refusal_code: string }>().refusal_code).toBe('connector_evidence_scope_mismatch');
    });

    it('enables public discovery for an enrolled tenant behind the issuance flag', async () => {
      const tenant = randomUUID();
      await enrol({ tenant_id: tenant, merchant_id: 'mch_PD', source_system: 'shopify' });
      const optIn = { public_discovery_requested: true, no_public_discovery_enablement: false,
        namespace_attestation_ref: 'agenticorg:ns:mch_PD', serving_host: 'store.example.com' };
      const off = await issue(tenant, 'mch_PD', optIn);
      expect(off.statusCode, off.body).toBe(201);
      const offState = off.json<{ artifacts: Array<{ artifact_family: string; payload: Record<string, unknown> }> }>().artifacts
        .find((a) => a.artifact_family === 'public_discovery_state')!;
      expect(offState.payload['public_discovery_withheld_reason']).toBe('issuance_flag_off');
      vi.stubEnv('OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED', 'true');
      const on = await issue(tenant, 'mch_PD', optIn);
      expect(on.statusCode, on.body).toBe(201);
      const onState = on.json<{ artifacts: Array<{ artifact_family: string; payload: Record<string, unknown> }> }>().artifacts
        .find((a) => a.artifact_family === 'public_discovery_state')!;
      expect(onState.payload['public_discovery_state']).toBe('enabled');
    });
  });

  describe('env-listed tenants', () => {
    it('keep their behaviour: any merchant, no enrolment, list without a merchant, catalogue upload allowed', async () => {
      const merchant = `mch_ENV${randomUUID().slice(0, 6)}`;
      const res = await issue(ENV_TENANT, merchant);
      expect(res.statusCode, res.body).toBe(201);
      const list = await app.inject({ method: 'GET', url: `/v1/commerce/oacp/artifacts?tenant_id=${ENV_TENANT}`, headers: service });
      expect(list.statusCode).toBe(200);
      const upload = await issue(ENV_TENANT, merchant, { connector_choice: 'catalog_upload' }, { source_system: 'catalog_upload' });
      expect(upload.statusCode, upload.body).toBe(201);
      const arbiter = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: service,
        payload: arbiterDecision(ENV_TENANT, 'mch_ANYTHING') });
      expect(arbiter.statusCode, arbiter.body).toBe(201);
    });
  });
});

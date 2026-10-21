// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Agent network identity against real Postgres: migration 136, the key
 * directory and the scheme-agent-id lookup queries (G50, G51), and settlement
 * receipts bound into signed commitment_evidence artifacts through the route
 * (G59). The SQL mock forwards to a database of this file's own.
 */
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { verifyOacpArtifact } from '../src/lib/commerce/oacp-jws.js';
import { resetOacpIssuerKeyCache } from '../src/lib/commerce/oacp-issuer-keys.js';
import { resetOacpStatusCache } from '../src/lib/commerce/oacp-status.js';
import { loadDirectoryDocument } from '../src/lib/registry/signature-directory.js';
import { lookupAgent } from '../src/lib/registry/lookup.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres agent network identity tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const SERVICE_TOKEN = 'agenticorg-network-identity-fixture-service-key';
const TENANT = 'cten_NETID';
const MERCHANT = 'mch_NETID';
const SELLER = 'seller_NETID';
type Sql = ReturnType<typeof postgres>;

let sql: Sql;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;
const service = { authorization: `Bearer ${SERVICE_TOKEN}` };

describePostgres('agent network identity against Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('network-identity');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    app = await buildTestApp();
  }, 180_000);

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
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
    vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'true');
    resetOacpIssuerKeyCache();
    resetOacpStatusCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('migration 136 adds the opt-in column and the scheme agent id column', async () => {
    const columns = await sql`
      SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
      WHERE (table_name = 'agents' AND column_name = 'http_signature_directory')
         OR (table_name = 'registry_attestations' AND column_name = 'scheme_agent_ids')
      ORDER BY table_name`;
    expect(columns).toEqual([
      { table_name: 'agents', column_name: 'http_signature_directory', data_type: 'boolean', column_default: 'false', is_nullable: 'NO' },
      { table_name: 'registry_attestations', column_name: 'scheme_agent_ids', data_type: 'jsonb', column_default: null, is_nullable: 'YES' },
    ]);
    const indexes = await sql`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_agents_http_signature_directory', 'idx_registry_attestations_scheme_agent_ids') ORDER BY indexname`;
    expect(indexes.map((i) => i['indexname'])).toEqual(['idx_agents_http_signature_directory', 'idx_registry_attestations_scheme_agent_ids']);
  });

  it('the directory and scheme-id lookup queries run against the schema', async () => {
    expect(await loadDirectoryDocument(sql)).toEqual({ keys: [] });
    expect(await lookupAgent(sql, { by: 'scheme_agent_id', scheme: 'visa_tap', schemeAgentId: 'tap-agent-0001' }, { authenticated: false })).toBeNull();
  });

  describe('settlement receipts as commitment evidence', () => {
    let refs: string[];

    beforeAll(async () => {
      sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
      sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin((tx) => cb(tx) as never)) as never);
      sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
      sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
      vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
      vi.stubEnv('OACP_AUTO_GENERATE_ISSUER_KEY', 'true');
      const observed = new Date(Date.now() - 60_000).toISOString();
      const res = await app.inject({
        method: 'POST', url: '/v1/commerce/oacp/c6z/authority-requests', headers: service,
        payload: {
          request: {
            request_id: 'netid_req_001', tenant_id: TENANT, merchant_id: MERCHANT, seller_agent_id: SELLER,
            merchant_display_name: 'Synthetic Store', commerce_categories: ['home_goods'], connector_choice: 'shopify',
            connector_mode: 'read_only', requested_authority_scope: ['merchant_profile', 'catalog_snapshot'],
            artifact_cache_scope: { tenant_id: TENANT, merchant_id: MERCHANT, seller_agent_id: SELLER },
            source_freshness_policy: { max_age_seconds: 600 }, source_evidence_ref: 'agenticorg:shopify:evidence:netid:redacted',
            source_observed_at: observed, no_payment_execution: true, no_public_discovery_enablement: true,
          },
          connector_evidence: {
            evidence_id: 'shopify_evidence_NETID', tenant_id: TENANT, merchant_id: MERCHANT, seller_agent_id: SELLER,
            source_system: 'shopify', source_evidence_ref: 'agenticorg:shopify:evidence:netid:redacted', source_observed_at: observed,
            product_count: 1, variant_count: 1, catalog_sample_refs: ['agenticorg:catalog:item:1:redacted'],
            price_snapshot_refs: ['agenticorg:price:item:1:redacted'], inventory_snapshot_refs: ['agenticorg:inventory:item:1:redacted'],
            no_payment_execution: true, no_public_discovery_enablement: true,
          },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      refs = res.json<{ artifacts: Array<{ envelope: { artifact_id: string } }> }>().artifacts.slice(0, 2).map((a) => a.envelope.artifact_id);
      vi.unstubAllEnvs();
    }, 60_000);

    const x402 = (transaction = '0x' + 'ab'.repeat(32), success = true) => ({
      protocol: 'x402', x402_version: 2,
      settlement: { success, transaction, network: 'eip155:84532', payer: '0x' + '12'.repeat(20) },
      gdt_jti: 'gdt_01NETID',
    });
    const post = (payload: Record<string, unknown>, headers: Record<string, string> = service) => app.inject({
      method: 'POST', url: '/v1/commerce/oacp/commitment-evidence/settlement-receipts', headers, payload,
    });
    const body = (commitment: string, receipt: unknown, artifactRefs = refs) => ({
      tenant_id: TENANT, merchant_id: MERCHANT, seller_agent_id: SELLER, buyer_agent_id: 'shopper-01',
      commitment_id: commitment, artifact_refs_used: artifactRefs, policy_version: '2026-10-01', receipt,
    });

    it('issues a signed commitment_evidence artifact that binds the x402 receipt by hash, without the payer', async () => {
      const res = await post(body('commit_NETID_1', x402()));
      expect(res.statusCode, res.body).toBe(201);
      const answer = res.json<{ artifact_id: string; envelope: Record<string, unknown>; payload: Record<string, any>; created: boolean }>();
      expect(answer.created).toBe(true);
      expect(answer.envelope['artifact_type']).toBe('commitment_evidence');
      expect(answer.payload['commitment_type']).toBe('settlement_receipt_reference');
      expect(answer.payload['forbidden_execution_claims']).toEqual([]);
      expect(answer.payload['settlement_receipt']).toMatchObject({
        protocol: 'x402', x402_version: 2, network: 'eip155:84532', transaction: '0x' + 'ab'.repeat(32), gdt_jti: 'gdt_01NETID',
        receipt_verification: 'reported_not_verified_by_grantex',
      });
      expect(answer.payload['settlement_receipt'].receipt_hash).toMatch(/^sha-256:[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(answer.payload)).not.toContain('12'.repeat(20));
      const jwks = (await app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json();
      expect(verifyOacpArtifact({ envelope: answer.envelope as never, payload: answer.payload, jwks, now_iso: new Date().toISOString(), status: 0 }))
        .toMatchObject({ valid: true });

      const replay = await post(body('commit_NETID_1', x402()));
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ artifact_id: string; created: boolean }>()).toMatchObject({ artifact_id: answer.artifact_id, created: false });
      const conflict = await post(body('commit_NETID_1', x402('0x' + 'cd'.repeat(32))));
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ error: { code: string } }>().error.code).toBe('commitment_receipt_conflict');
    });

    it('binds an MPP Payment-Receipt', async () => {
      const res = await post(body('commit_NETID_2', {
        protocol: 'mpp', receipt: { status: 'success', method: 'tempo', timestamp: new Date().toISOString(), reference: 'mpp-ref-0001' },
      }));
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json<{ payload: Record<string, any> }>().payload['settlement_receipt']).toMatchObject({ protocol: 'mpp', method: 'tempo', reference: 'mpp-ref-0001' });
    });

    it('refuses a failed settlement, unknown artifact refs, a malformed body and a missing service token', async () => {
      const failed = await post(body('commit_NETID_3', x402(undefined, false)));
      expect(failed.statusCode).toBe(422);
      expect(failed.json<{ error: { code: string } }>().error.code).toBe('settlement_not_successful');
      const unknown = await post(body('commit_NETID_4', x402(), ['oacp_art_UNKNOWN']));
      expect(unknown.statusCode).toBe(422);
      expect(unknown.json<{ error: { code: string } }>().error.code).toBe('artifact_ref_unknown');
      const malformed = await post({ ...body('commit_NETID_5', x402()), extra: true });
      expect(malformed.statusCode).toBe(400);
      const anonymous = await post(body('commit_NETID_6', x402()), {});
      expect([401, 403]).toContain(anonymous.statusCode);
      expect(await sql`SELECT 1 FROM oacp_artifacts WHERE payload->>'commitment_id' IN ('commit_NETID_3', 'commit_NETID_4', 'commit_NETID_5', 'commit_NETID_6')`).toHaveLength(0);
    });
  });
});

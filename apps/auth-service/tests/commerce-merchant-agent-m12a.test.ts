import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const openapiPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const MERCHANT_TOKEN = 'grtx_sk_sandbox_abcd1234abcd1234abcd1234abcd1234';
const AGENT_TOKEN = 'grtx_agent_M12AXXXXXXXXXXXXXXXXXXXXXXXX';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

function seedMerchantCaller(merchantId = 'mch_M12A'): void {
  sqlMock.mockResolvedValueOnce([{
    id: 'mkey_M12A',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: merchantId,
    environment: 'sandbox',
    tenant_status: 'active',
  }]);
  // resolveMerchantApiKey performs a best-effort last_used_at update.
  sqlMock.mockResolvedValueOnce([]);
}

function seedAgentCaller(agentId = 'cag_M12A'): void {
  sqlMock.mockResolvedValueOnce([{
    id: agentId,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    trust_status: 'trusted',
    public_key_jwk: null,
    api_key_hash: 'sha256:test',
    tenant_status: 'active',
  }]);
}

function merchantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mch_M12A',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    legal_name: 'Acme Electronics Pvt Ltd',
    display_name: 'Acme Electronics',
    category_preset: 'electronics_appliances',
    verification_status: 'unverified',
    environment: 'sandbox',
    agentic_commerce_enabled: true,
    default_currency: 'INR',
    country_code: 'IN',
    support_email: 'support@acme.example',
    disabled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function agentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cag_M12A',
    tenant_id: TEST_COMMERCE_TENANT_ID,
    display_name: 'Acme Sales Agent',
    agent_type: 'sales',
    public_key_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    trust_status: 'trusted',
    status: 'active',
    disabled_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function sqlText(call: unknown[]): string {
  return Array.isArray(call[0]) ? (call[0] as string[]).join(' ') : '';
}

function findSqlCall(pattern: RegExp): unknown[] | undefined {
  return sqlMock.mock.calls.find((call) => pattern.test(sqlText(call)));
}

function findAuditCall(eventType: string): unknown[] | undefined {
  return sqlMock.mock.calls.find((call) => {
    return /INSERT INTO commerce_audit_events/i.test(sqlText(call))
      && call.slice(1).includes(eventType);
  });
}

describe('M12A PATCH /v1/commerce/merchants/:merchantId', () => {
  it('updates allowlisted merchant fields and writes merchant.updated audit metadata', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchantRow({ display_name: 'Acme Updated' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_MERCHANT_UPDATED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/merchants/mch_M12A',
      headers: authHeader(),
      payload: { display_name: 'Acme Updated', agentic_commerce_enabled: true },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; display_name: string }; audit_event_id: string }>();
    expect(body.data.id).toBe('mch_M12A');
    expect(body.data.display_name).toBe('Acme Updated');
    expect(body.audit_event_id).toBe('caud_MERCHANT_UPDATED');

    const auditCall = findAuditCall('merchant.updated');
    expect(auditCall).toBeDefined();
    const metadata = auditCall?.find((value) => typeof value === 'string' && value.includes('changed_fields')) as string;
    expect(metadata).toContain('display_name');
    expect(metadata).toContain('agentic_commerce_enabled');
    expect(metadata).not.toContain('Acme Updated');
  });

  it('rejects unknown, immutable, and sensitive merchant patch keys', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/merchants/mch_M12A',
      headers: authHeader(),
      payload: {
        tenant_id: 'cten_OTHER',
        environment: 'live',
        provider_account_refs: { plural: 'x' },
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('tenant_id');
    expect(fields.unsupported_fields).toContain('environment');
    expect(fields.unsupported_fields).toContain('provider_account_refs');
  });

  it('returns non-enumerating 404 when merchant is absent or outside the tenant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/merchants/mch_OTHER_TENANT',
      headers: authHeader(),
      payload: { display_name: 'Nope' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });

  it('denies CommerceAgent callers on merchant update', async () => {
    seedAgentCaller();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/merchants/mch_M12A',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { display_name: 'Agent Cannot Change Merchant' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('caller_not_authorized');
  });
});

describe('M12A GET /v1/commerce/agents', () => {
  it('lists tenant CommerceAgents for operators without selecting secret-bearing fields', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([agentRow()]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/agents?trust_status=trusted&status=active&limit=10',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: Array<{ id: string; api_key_hash?: string }>; next_cursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.id).toBe('cag_M12A');
    expect(JSON.stringify(body)).not.toContain('api_key_hash');
    expect(JSON.stringify(body)).not.toContain('provider_credential');
    expect(body.next_cursor).toBeNull();

    const listCall = findSqlCall(/FROM commerce_agents[\s\S]*ORDER BY created_at DESC/i);
    expect(listCall).toBeDefined();
    expect(sqlText(listCall!)).not.toMatch(/api_key_hash|private_key|provider_credential/i);
  });

  it('allows a merchant caller to list only its verified own merchant scope', async () => {
    seedMerchantCaller('mch_M12A');
    sqlMock.mockResolvedValueOnce([{ id: 'mch_M12A' }]);
    sqlMock.mockResolvedValueOnce([agentRow()]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/agents?merchant_id=mch_M12A',
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: Array<{ id: string }> }>().items[0]!.id).toBe('cag_M12A');
  });

  it('rejects a merchant caller listing another merchant scope', async () => {
    seedMerchantCaller('mch_M12A');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/agents?merchant_id=mch_OTHER',
      headers: { authorization: `Bearer ${MERCHANT_TOKEN}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_scope_violation');
  });
});

describe('M12A PATCH /v1/commerce/agents/:agentId', () => {
  it('updates allowlisted agent status, trust_status, and display_name with audit', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ id: 'cag_M12A', disabled_at: null }]);
    sqlMock.mockResolvedValueOnce([agentRow({ display_name: 'Trusted Sales Agent', trust_status: 'trusted' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_AGENT_UPDATED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/agents/cag_M12A',
      headers: authHeader(),
      payload: { display_name: 'Trusted Sales Agent', trust_status: 'trusted', status: 'active' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; trust_status: string; status: string }; audit_event_id: string }>();
    expect(body.data.id).toBe('cag_M12A');
    expect(body.data.trust_status).toBe('trusted');
    expect(body.data.status).toBe('active');
    expect(body.audit_event_id).toBe('caud_AGENT_UPDATED');

    const auditCall = findAuditCall('agent.updated');
    expect(auditCall).toBeDefined();
    const metadata = auditCall?.find((value) => typeof value === 'string' && value.includes('changed_fields')) as string;
    expect(metadata).toContain('display_name');
    expect(metadata).toContain('trust_status');
    expect(metadata).toContain('status');
    expect(metadata).not.toContain('Trusted Sales Agent');
  });

  it('rejects unknown, immutable, and sensitive agent patch keys', async () => {
    seedCommerceContext();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/agents/cag_M12A',
      headers: authHeader(),
      payload: {
        tenant_id: TEST_COMMERCE_TENANT_ID,
        merchant_id: 'mch_M12A',
        api_key_hash: 'sha256:do-not-accept',
        public_key_jwk: { kty: 'oct', k: 'secret' },
      },
    });

    expect(res.statusCode).toBe(422);
    const fields = res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields;
    expect(fields.unsupported_fields).toContain('tenant_id');
    expect(fields.unsupported_fields).toContain('merchant_id');
    expect(fields.unsupported_fields).toContain('api_key_hash');
    expect(fields.unsupported_fields).toContain('public_key_jwk');
  });

  it('prevents CommerceAgent self-elevation of trust/status', async () => {
    seedAgentCaller('cag_M12A');

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/agents/cag_M12A',
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      payload: { trust_status: 'trusted', status: 'active' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('returns 404 when the agent is absent or outside the tenant', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/commerce/agents/cag_OTHER_TENANT',
      headers: authHeader(),
      payload: { status: 'disabled' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('agent_not_found');
  });
});

describe('M12A OpenAPI drift guard', () => {
  function pathBlock(path: string): string {
    const content = readFileSync(openapiPath, 'utf8');
    const start = content.indexOf(`  ${path}:`);
    expect(start, `OpenAPI must declare ${path}`).toBeGreaterThan(-1);
    const after = content.slice(start + path.length + 3);
    const next = after.search(/\n {2}\/[A-Za-z0-9{]/);
    return next === -1 ? after : after.slice(0, next);
  }

  it('marks merchant update and CommerceAgent list/update as implemented', () => {
    expect(pathBlock('/v1/commerce/merchants/{merchant_id}'))
      .toMatch(/patch:[\s\S]*operationId:\s*updateMerchant[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/agents'))
      .toMatch(/get:[\s\S]*operationId:\s*listAgents[\s\S]*x-implemented:\s*true/);
    expect(pathBlock('/v1/commerce/agents/{agent_id}'))
      .toMatch(/patch:[\s\S]*operationId:\s*updateAgent[\s\S]*x-implemented:\s*true/);
  });
});

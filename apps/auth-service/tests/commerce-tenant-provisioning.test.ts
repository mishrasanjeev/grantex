import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sqlMock, buildTestApp, TEST_DEVELOPER, TEST_ADMIN_API_KEY, authHeader } from './helpers.js';
import { TEST_COMMERCE_TENANT_ID, seedCommerceContext } from './commerce-helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });

const adminAuth = { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };

describe('POST /v1/commerce/tenants — admin only (Decision C)', () => {
  it('admin caller creates a tenant', async () => {
    // Admin path: developer lookup empty + isPlatformAdmin true → caller resolved without tenant.
    sqlMock.mockResolvedValueOnce([]);  // developer lookup empty
    sqlMock.mockResolvedValueOnce([{
      id: 'cten_NEW', display_name: 'Acme Org', status: 'active',
      metadata: {}, created_at: new Date(), updated_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_T', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/tenants', headers: adminAuth,
      payload: { display_name: 'Acme Org' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string }; audit_event_id: string }>();
    expect(body.data.id).toBe('cten_NEW');
    expect(body.audit_event_id).toBe('caud_T');
  });

  it('non-admin operator → 403 admin_required', async () => {
    seedCommerceContext();  // operator (developer) caller, NOT admin
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/tenants', headers: authHeader(),
      payload: { display_name: 'X' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('admin_required');
  });

  it('missing display_name → 422', async () => {
    sqlMock.mockResolvedValueOnce([]);  // admin path — no developer
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/tenants', headers: adminAuth,
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /v1/commerce/developer-tenants — owner or admin', () => {
  it('admin can bind any developer to any tenant', async () => {
    sqlMock.mockResolvedValueOnce([]);  // admin path
    sqlMock.mockResolvedValueOnce([{ id: TEST_COMMERCE_TENANT_ID, status: 'active' }]);  // tenant lookup
    // begin: clear default + insert + audit (3 mock slots inside begin)
    sqlMock.mockResolvedValueOnce([]);  // UPDATE clear default
    sqlMock.mockResolvedValueOnce([{
      developer_id: 'dev_OTHER', tenant_id: TEST_COMMERCE_TENANT_ID, is_default: true, created_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_B', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/developer-tenants', headers: adminAuth,
      payload: { developer_id: 'dev_OTHER', tenant_id: TEST_COMMERCE_TENANT_ID, is_default: true },
    });
    expect(res.statusCode).toBe(201);
  });

  it('non-owner operator → 403 tenant_owner_required', async () => {
    // Operator caller exists but doesn't own the target tenant.
    sqlMock.mockResolvedValueOnce([TEST_DEVELOPER]);
    sqlMock.mockResolvedValueOnce([{ tenant_id: TEST_COMMERCE_TENANT_ID, status: 'active', role: 'owner' }]);
    sqlMock.mockResolvedValueOnce([]);  // ownership check on cten_OTHER returns no row
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/developer-tenants', headers: authHeader(),
      payload: { developer_id: 'dev_OTHER', tenant_id: 'cten_OTHER', is_default: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_owner_required');
  });

  it('disabled tenant cannot accept new bindings → 409 tenant_disabled', async () => {
    sqlMock.mockResolvedValueOnce([]);  // admin path
    sqlMock.mockResolvedValueOnce([{ id: TEST_COMMERCE_TENANT_ID, status: 'disabled' }]);
    const res = await app.inject({
      method: 'POST', url: '/v1/commerce/developer-tenants', headers: adminAuth,
      payload: { developer_id: 'dev_X', tenant_id: TEST_COMMERCE_TENANT_ID },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('tenant_disabled');
  });
});

describe('PATCH /v1/commerce/tenants/:id — owner or admin', () => {
  it('owner can update display_name', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ ok: true }]);  // ownership check passes
    // begin: UPDATE + audit
    sqlMock.mockResolvedValueOnce([{
      id: TEST_COMMERCE_TENANT_ID, display_name: 'New Name', status: 'active',
      metadata: {}, created_at: new Date(), updated_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_U', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'PATCH', url: `/v1/commerce/tenants/${TEST_COMMERCE_TENANT_ID}`,
      headers: authHeader(), payload: { display_name: 'New Name' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('admin disabling a tenant emits tenant.disabled audit event', async () => {
    sqlMock.mockResolvedValueOnce([]);  // admin path
    sqlMock.mockResolvedValueOnce([{
      id: TEST_COMMERCE_TENANT_ID, display_name: 'X', status: 'disabled',
      metadata: {}, created_at: new Date(), updated_at: new Date(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_D', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'PATCH', url: `/v1/commerce/tenants/${TEST_COMMERCE_TENANT_ID}`,
      headers: adminAuth, payload: { status: 'disabled' },
    });
    expect(res.statusCode).toBe(200);
    // Inspect the audit insert — last sqlMock call before reply.
    const auditCall = sqlMock.mock.calls.find((c) => {
      const tpl = c[0] as unknown;
      return Array.isArray(tpl)
        && tpl.some((s) => typeof s === 'string' && /INSERT INTO commerce_audit_events/i.test(s));
    });
    expect(auditCall).toBeDefined();
    expect(auditCall!.slice(1)).toContain('tenant.disabled');
  });
});

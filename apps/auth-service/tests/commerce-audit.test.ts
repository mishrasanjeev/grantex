import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, sqlMock, buildTestApp } from './helpers.js';
import { seedCommerceContext } from './commerce-helpers.js';
import * as auditModule from '../src/lib/commerce/audit.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });

describe('GET /v1/commerce/audit/events', () => {
  it('returns items array and a null cursor when fewer than limit rows', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([
      { id: 'caud_1', tenant_id: 'cten_TESTTENANT', event_type: 'merchant.created', occurred_at: new Date(), metadata: {} },
      { id: 'caud_2', tenant_id: 'cten_TESTTENANT', event_type: 'product.created', occurred_at: new Date(), metadata: {} },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/audit/events',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { id: string }[]; next_cursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).toBeNull();
  });

  it('emits a next_cursor when result count exceeds limit', async () => {
    seedCommerceContext();
    // limit=2 -> route asks for limit+1 = 3 rows; first 2 returned, cursor emitted
    sqlMock.mockResolvedValueOnce([
      { id: 'caud_a', occurred_at: new Date(), metadata: {} },
      { id: 'caud_b', occurred_at: new Date(), metadata: {} },
      { id: 'caud_c', occurred_at: new Date(), metadata: {} },
    ]);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/audit/events?limit=2',
      headers: authHeader(),
    });
    const body = res.json<{ items: unknown[]; next_cursor: string | null }>();
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).toBeTruthy();
  });
});

describe('Commerce audit writer module surface', () => {
  it('exports appendCommerceAudit', () => {
    expect(typeof auditModule.appendCommerceAudit).toBe('function');
  });

  it('does NOT export updateCommerceAudit or deleteCommerceAudit (append-only)', () => {
    expect((auditModule as unknown as Record<string, unknown>)['updateCommerceAudit']).toBeUndefined();
    expect((auditModule as unknown as Record<string, unknown>)['deleteCommerceAudit']).toBeUndefined();
  });
});

describe('Commerce audit append-only DDL (verified by reading the migration file)', () => {
  it('migration 036 declares the trigger function and BEFORE UPDATE/DELETE triggers', async () => {
    const fs = await import('node:fs/promises');
    const url = new URL('../src/db/migrations/036_commerce_audit_events.sql', import.meta.url);
    const sql = await fs.readFile(url, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS commerce_audit_events/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION commerce_audit_events_block_mutation/);
    expect(sql).toMatch(/RAISE EXCEPTION 'commerce_audit_events is append-only/);
    expect(sql).toMatch(/BEFORE UPDATE ON commerce_audit_events/);
    expect(sql).toMatch(/BEFORE DELETE ON commerce_audit_events/);
    // Layer (2): role-based grant/revoke wrapped in DO block
    expect(sql).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON commerce_audit_events/);
    expect(sql).toMatch(/GRANT INSERT, SELECT ON commerce_audit_events/);
  });
});

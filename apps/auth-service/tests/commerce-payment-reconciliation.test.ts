import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { reconcilePendingPaymentIntents } from '../src/lib/commerce/payment-reconciliation.js';

let app: FastifyInstance;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const RECONCILIATION_MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/048_commerce_payment_reconciliation.sql');

const MERCHANT = 'mch_RECON';
const AGENT = 'cag_RECON';
const CART = 'ccart_RECON';
const PAYMENT_INTENT = 'cpi_RECON';

beforeAll(async () => {
  app = await buildTestApp();
});

function paymentIntentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_INTENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    cart_id: CART,
    passport_jti: 'cpsp_RECON',
    amount: 1000,
    currency: 'INR',
    provider: 'mock',
    provider_environment: 'sandbox',
    provider_payment_id: `mock_pay_${PAYMENT_INTENT}`,
    provider_order_id: `mock_order_${PAYMENT_INTENT}`,
    checkout_url: 'https://mock-payments.grantex.local/checkout/cpi_RECON',
    checkout_expires_at: new Date(Date.now() + 600_000).toISOString(),
    status: 'payment_pending',
    line_items_snapshot: [],
    idempotency_key_hash: 'hash_recon',
    provider_metadata: { deterministic: true },
    provider_raw_status: 'mock_payment_pending',
    policy_version: 'v1',
    decision_id: 'cpdec_RECON',
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    reconciled_at: null,
    last_reconciliation_attempt_at: null,
    last_reconciliation_error: null,
    last_reconciliation_retryable: null,
    created_at: new Date(Date.now() - 900_000).toISOString(),
    updated_at: new Date(Date.now() - 180_000).toISOString(),
    ...overrides,
  };
}

function primeManualTransition(targetStatus: 'paid' | 'failed' | 'expired'): void {
  seedCommerceContext();
  const base = paymentIntentRow({
    provider_payment_id: `mock_pay_${PAYMENT_INTENT}_${targetStatus}`,
  });
  sqlMock.mockResolvedValueOnce([base]);
  sqlMock.mockResolvedValueOnce([paymentIntentRow({
    ...base,
    status: targetStatus,
    provider_raw_status: `mock_${targetStatus}`,
    reconciled_at: new Date().toISOString(),
    last_reconciliation_attempt_at: new Date().toISOString(),
  })]);
  sqlMock.mockResolvedValueOnce([{ id: `caud_RECON_${targetStatus.toUpperCase()}`, occurred_at: new Date().toISOString() }]);
}

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

function sqlCallCount(pattern: RegExp): number {
  return sqlMock.mock.calls.filter((call) => {
    const tpl = call[0] as unknown;
    return Array.isArray(tpl) && tpl.some((part) => typeof part === 'string' && pattern.test(part));
  }).length;
}

describe('Commerce payment reconciliation', () => {
  it('manual reconcile transitions pending intent to paid via MockPaymentProvider', async () => {
    primeManualTransition('paid');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string }; reconciliation: { status: string; to_status: string }; audit_event_id: string }>())
      .toMatchObject({
        data: { status: 'paid' },
        reconciliation: { status: 'transitioned', to_status: 'paid' },
        audit_event_id: 'caud_RECON_PAID',
      });
    expect(flattenedSqlCalls()).toContain('payment_intent.paid');
  });

  it('manual reconcile transitions pending intent to failed via MockPaymentProvider', async () => {
    primeManualTransition('failed');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string }; reconciliation: { to_status: string } }>())
      .toMatchObject({ data: { status: 'failed' }, reconciliation: { to_status: 'failed' } });
    expect(flattenedSqlCalls()).toContain('payment_intent.failed');
  });

  it('manual reconcile transitions pending intent to expired via MockPaymentProvider', async () => {
    primeManualTransition('expired');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string }; reconciliation: { to_status: string } }>())
      .toMatchObject({ data: { status: 'expired' }, reconciliation: { to_status: 'expired' } });
    expect(flattenedSqlCalls()).toContain('payment_intent.expired');
  });

  it('expires pending intent older than 15 minutes when provider still reports pending', async () => {
    seedCommerceContext();
    const base = paymentIntentRow({
      provider_payment_id: `mock_pay_${PAYMENT_INTENT}`,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    sqlMock.mockResolvedValueOnce([base]);
    sqlMock.mockResolvedValueOnce([paymentIntentRow({
      ...base,
      status: 'expired',
      provider_raw_status: 'mock_payment_pending',
      reconciled_at: new Date().toISOString(),
      last_reconciliation_attempt_at: new Date().toISOString(),
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_RECON_TIMEOUT_EXPIRED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string }; reconciliation: { to_status: string; provider_status: string } }>())
      .toMatchObject({
        data: { status: 'expired' },
        reconciliation: { to_status: 'expired', provider_status: 'payment_pending' },
      });
  });

  it('batch helper ignores intents younger than the two minute reconciliation window', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await reconcilePendingPaymentIntents({ limit: 10, olderThanSeconds: 120 });

    expect(result).toMatchObject({ scanned: 0, transitioned: 0, noChange: 0 });
    expect(flattenedSqlCalls()).toContain("status = 'payment_pending'");
    expect(flattenedSqlCalls()).toContain("updated_at <= NOW()");
    expect(flattenedSqlCalls()).toContain("seconds");
  });

  it('batch reconciliation processes only payment_pending intents older than two minutes', async () => {
    const base = paymentIntentRow({ provider_payment_id: `mock_pay_${PAYMENT_INTENT}_paid` });
    sqlMock.mockResolvedValueOnce([base]);
    sqlMock.mockResolvedValueOnce([paymentIntentRow({
      ...base,
      status: 'paid',
      provider_raw_status: 'mock_paid',
      reconciled_at: new Date().toISOString(),
      last_reconciliation_attempt_at: new Date().toISOString(),
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_BATCH_PAID', occurred_at: new Date().toISOString() }]);

    const result = await reconcilePendingPaymentIntents({ limit: 25, olderThanSeconds: 120 });

    expect(result).toMatchObject({ scanned: 1, transitioned: 1, noChange: 0, failed: 0 });
    expect(result.results[0]).toMatchObject({ kind: 'transitioned', toStatus: 'paid' });
    expect(flattenedSqlCalls()).toContain("status = 'payment_pending'");
    expect(flattenedSqlCalls()).toContain('last_reconciliation_retryable');
  });

  it('already terminal paid/failed/expired intent is idempotently ignored', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'paid', provider_payment_id: `mock_pay_${PAYMENT_INTENT}_failed` })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ reconciliation: { status: string; reason: string; payment_status: string } }>().reconciliation)
      .toMatchObject({ status: 'ignored', reason: 'terminal_status', payment_status: 'paid' });
    expect(sqlCallCount(/SET status =/i)).toBe(0);
  });

  it('invalid transition is rejected and audited', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({
      status: 'authorized',
      provider_payment_id: `mock_pay_${PAYMENT_INTENT}_paid`,
    })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_RECON_INVALID_TRANSITION', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id: string } }>().error)
      .toMatchObject({ code: 'invalid_payment_status_transition', audit_event_id: 'caud_RECON_INVALID_TRANSITION' });
    expect(flattenedSqlCalls()).toContain('protected_action.denied');
    expect(sqlCallCount(/SET status =/i)).toBe(0);
  });

  it('provider blocked error is stored safely and does not transition', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([paymentIntentRow({
      provider: 'plural',
      provider_payment_id: `plural_pay_${PAYMENT_INTENT}`,
    })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string; details: { provider_key: string; provider_error_code: string } } }>().error)
      .toMatchObject({
        code: 'provider_validation_failed',
        details: { provider_key: 'plural', provider_error_code: 'plural_sandbox_blocked' },
      });
    expect(flattenedSqlCalls()).toContain('last_reconciliation_error');
    expect(sqlCallCount(/SET status =/i)).toBe(0);
  });

  it('manual reconcile enforces tenant and caller boundary', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/payments/intents/${PAYMENT_INTENT}/reconcile`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('payment_intent_not_found');
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('adds reconciliation persistence metadata without raw provider payloads', () => {
    const content = readFileSync(RECONCILIATION_MIGRATION_PATH, 'utf8');
    expect(content).toContain('reconciled_at');
    expect(content).toContain('last_reconciliation_error');
    expect(content).toContain('last_reconciliation_retryable');
    expect(content).toContain('idx_payment_intents_pending_reconciliation');
    expect(content).not.toContain('raw_payload');
  });

  it('marks manual reconcile route implemented in OpenAPI', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const route = '/v1/commerce/payments/intents/{id}/reconcile';
    const start = content.indexOf(route);
    const end = content.indexOf('/v1/webhooks/providers', start);
    const section = content.slice(start, end);
    expect(section).toContain('operationId: reconcilePaymentIntent');
    expect(section).toContain('x-implemented: true');
    expect(section).toContain('x-milestone: M4E');
    expect(section).toContain('PaymentReconciliation');
  });
});

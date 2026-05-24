import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTestApp, sqlMock } from './helpers.js';
import { TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { stableJson } from '../src/lib/commerce/idempotency.js';

let app: FastifyInstance;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const WEBHOOK_MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/047_commerce_provider_webhooks.sql');

const MERCHANT = 'mch_WEBHOOK';
const AGENT = 'cag_WEBHOOK';
const PAYMENT_INTENT = 'cpi_WEBHOOK';
const PROVIDER_PAYMENT_ID = `mock_pay_${PAYMENT_INTENT}`;
const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

beforeAll(async () => {
  app = await buildTestApp();
});

function paymentIntentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_INTENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    passport_jti: 'cpsp_WEBHOOK',
    amount: 1000,
    currency: 'INR',
    provider: 'mock',
    provider_payment_id: PROVIDER_PAYMENT_ID,
    status: 'payment_pending',
    provider_raw_status: 'mock_payment_pending',
    policy_version: 'v1',
    decision_id: 'cpdec_WEBHOOK',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function webhookEventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cwh_WEBHOOK',
    payment_intent_id: PAYMENT_INTENT,
    processing_status: 'processed',
    ...overrides,
  };
}

function webhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt_WEBHOOK',
    event_type: 'payment.updated',
    merchant_ref: MERCHANT,
    provider_payment_id: PROVIDER_PAYMENT_ID,
    status: 'paid',
    ...overrides,
  };
}

function signedHeaders(payload: Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const rawBody = stableJson(payload);
  const signature = createHmac('sha256', MOCK_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return {
    'x-mock-timestamp': String(timestamp),
    'x-mock-signature': `sha256=${signature}`,
  };
}

function primeWebhookTransition(targetStatus: 'paid' | 'failed' | 'expired'): void {
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
  sqlMock.mockResolvedValueOnce([webhookEventRow()]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_RECEIVED', occurred_at: new Date().toISOString() }]);
  sqlMock.mockResolvedValueOnce([paymentIntentRow({
    status: targetStatus,
    provider_raw_status: targetStatus,
  })]);
  sqlMock.mockResolvedValueOnce([]);
  sqlMock.mockResolvedValueOnce([{ id: `caud_PAYMENT_${targetStatus.toUpperCase()}`, occurred_at: new Date().toISOString() }]);
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

describe('Commerce provider webhook route', () => {
  it('mock provider webhook success transitions payment_pending to paid', async () => {
    const payload = webhookPayload({ event_id: 'evt_PAID', status: 'paid' });
    primeWebhookTransition('paid');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; payment_status: string }; audit_event_id: string }>())
      .toMatchObject({ data: { status: 'processed', payment_status: 'paid' }, audit_event_id: 'caud_PAYMENT_PAID' });
    expect(flattenedSqlCalls()).toContain('provider.webhook.received');
    expect(flattenedSqlCalls()).toContain('payment_intent.paid');
  });

  it('mock provider webhook failure transitions payment_pending to failed', async () => {
    const payload = webhookPayload({ event_id: 'evt_FAILED', status: 'failed' });
    primeWebhookTransition('failed');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { payment_status: string } }>().data.payment_status).toBe('failed');
    expect(flattenedSqlCalls()).toContain('payment_intent.failed');
  });

  it('mock provider webhook expired transitions payment_pending to expired', async () => {
    const payload = webhookPayload({ event_id: 'evt_EXPIRED', status: 'expired' });
    primeWebhookTransition('expired');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { payment_status: string } }>().data.payment_status).toBe('expired');
    expect(flattenedSqlCalls()).toContain('payment_intent.expired');
  });

  it('duplicate webhook event id is idempotently accepted without a second transition', async () => {
    const payload = webhookPayload({ event_id: 'evt_DUPLICATE', status: 'paid' });
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_DUPLICATE', processing_status: 'processed' })]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; processing_status: string } }>().data)
      .toMatchObject({ status: 'duplicate', processing_status: 'processed' });
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('invalid signature records provider.webhook.signature_failed and returns an explicit error', async () => {
    const payload = webhookPayload({ event_id: 'evt_BAD_SIGNATURE', status: 'paid' });
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_BAD_SIGNATURE' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_SIGNATURE_FAILED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: {
        'x-mock-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-mock-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string; audit_event_id: string } }>().error)
      .toMatchObject({ code: 'webhook_signature_invalid', audit_event_id: 'caud_SIGNATURE_FAILED' });
    expect(flattenedSqlCalls()).toContain('provider.webhook.signature_failed');
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('stale timestamp replay is rejected and recorded', async () => {
    const staleTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const payload = webhookPayload({ event_id: 'evt_STALE', status: 'paid' });
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_STALE' })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_STALE_DENY', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload, staleTimestamp),
      payload,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id: string } }>().error)
      .toMatchObject({ code: 'webhook_replay_detected', audit_event_id: 'caud_STALE_DENY' });
    expect(flattenedSqlCalls()).toContain('protected_action.denied');
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('unsupported provider event is recorded and ignored safely', async () => {
    const payload = webhookPayload({ event_id: 'evt_UNSUPPORTED', event_type: 'payment.refunded', status: 'paid' });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_UNSUPPORTED' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_RECEIVED', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_UNSUPPORTED_DENY', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; reason: string }; audit_event_id: string }>())
      .toMatchObject({ data: { status: 'ignored', reason: 'unsupported_provider_event' }, audit_event_id: 'caud_UNSUPPORTED_DENY' });
    expect(flattenedSqlCalls()).toContain('protected_action.denied');
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('invalid payment transition is rejected and audited', async () => {
    const payload = webhookPayload({ event_id: 'evt_INVALID_TRANSITION', status: 'paid' });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized' })]);
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_INVALID_TRANSITION' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_WEBHOOK_RECEIVED', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_INVALID_TRANSITION_DENY', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; audit_event_id: string } }>().error)
      .toMatchObject({ code: 'invalid_payment_status_transition', audit_event_id: 'caud_INVALID_TRANSITION_DENY' });
    expect(flattenedSqlCalls()).toContain('invalid_payment_status_transition');
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('plural provider webhook is blocked by the central live-mode guard before any provider call', async () => {
    const payload = webhookPayload({ event_id: 'evt_PLURAL', status: 'paid' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/plural',
      payload,
    });

    // P0-23: with both PLURAL flags unset (default in vitest.config.ts),
    // the guard rejects before provider.handleWebhook runs. No SQL ran,
    // no audit row was written.
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string; details?: { reason?: string; provider_key?: string } } }>().error)
      .toMatchObject({
        code: 'plural_live_disabled',
        details: { reason: 'plural_live_disabled', provider_key: 'plural' },
      });
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('does not update a payment intent when merchant boundary does not match', async () => {
    const payload = webhookPayload({
      event_id: 'evt_CROSS_TENANT',
      merchant_ref: 'mch_OTHER_TENANT',
      status: 'paid',
    });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_CROSS_TENANT', payment_intent_id: null })]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; reason: string; payment_intent_id: string | null } }>().data)
      .toMatchObject({ status: 'ignored', reason: 'payment_intent_not_found', payment_intent_id: null });
    expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
  });

  it('adds provider webhook persistence with event-id idempotency', () => {
    const content = readFileSync(WEBHOOK_MIGRATION_PATH, 'utf8');
    expect(content).toContain('commerce_provider_webhook_events');
    expect(content).toContain('provider_event_id');
    expect(content).toContain('payload_hash');
    expect(content).toContain('uq_provider_webhook_provider_event');
    expect(content).not.toContain('raw_payload JSONB');
  });

  it('marks provider webhook route implemented in OpenAPI', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const route = '/v1/webhooks/providers/{provider_key}';
    const start = content.indexOf(route);
    const end = content.indexOf('/v1/webhooks/merchant', start);
    const section = content.slice(start, end);
    expect(section).toContain('operationId: handleProviderWebhook');
    expect(section).toContain('x-implemented: true');
    expect(section).toContain('ProviderWebhookResponse');
    expect(section).toContain('Plural returns an explicit blocked configuration');
  });
});

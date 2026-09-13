import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTestApp, sqlMock } from './helpers.js';
import { TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';

let app: FastifyInstance;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const WEBHOOK_MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/047_commerce_provider_webhooks.sql');

const MERCHANT = 'mch_WEBHOOK';
const AGENT = 'cag_WEBHOOK';
const PAYMENT_INTENT = 'cpi_WEBHOOK';
const PROVIDER_PAYMENT_ID = `mock_pay_${PAYMENT_INTENT}`;
const MOCK_WEBHOOK_SECRET = 'test-mock-webhook-secret-not-a-default';
const PREVIOUS_MOCK_WEBHOOK_SECRET = process.env['MOCK_PAYMENT_WEBHOOK_SECRET'];

beforeAll(async () => {
  process.env['MOCK_PAYMENT_WEBHOOK_SECRET'] = MOCK_WEBHOOK_SECRET;
  app = await buildTestApp();
});

afterAll(() => {
  if (PREVIOUS_MOCK_WEBHOOK_SECRET === undefined) {
    delete process.env['MOCK_PAYMENT_WEBHOOK_SECRET'];
  } else {
    process.env['MOCK_PAYMENT_WEBHOOK_SECRET'] = PREVIOUS_MOCK_WEBHOOK_SECRET;
  }
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

// Sign the exact bytes that will be sent: app.inject serialises object
// payloads with JSON.stringify, and string payloads are sent verbatim.
function signedHeaders(payload: Record<string, unknown> | string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = createHmac('sha256', MOCK_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return {
    'x-mock-timestamp': String(timestamp),
    'x-mock-signature': `sha256=${signature}`,
  };
}

function primeWebhookTransition(targetStatus: 'paid' | 'failed' | 'expired'): void {
  sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
  sqlMock.mockResolvedValueOnce([]);
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

  it('verifies the signature over the raw bytes as sent (non-canonical whitespace and key order)', async () => {
    const payload = webhookPayload({ event_id: 'evt_RAW_BYTES', status: 'paid' });
    // Reverse key order and add whitespace — a canonical (key-sorted,
    // whitespace-free) re-rendering would produce a different HMAC input.
    const rawBody = `{
  ${Object.keys(payload).reverse()
      .map((key) => `${JSON.stringify(key)} :  ${JSON.stringify(payload[key])}`)
      .join(',\n  ')}
}
`;
    primeWebhookTransition('paid');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: { ...signedHeaders(rawBody), 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; payment_status: string } }>().data)
      .toMatchObject({ status: 'processed', payment_status: 'paid' });
  });

  it('rejects a signature computed over a canonical re-serialisation of the raw bytes', async () => {
    const payload = webhookPayload({ event_id: 'evt_CANONICAL_SIG', status: 'paid' });
    const rawBody = `{ ${Object.keys(payload).reverse()
      .map((key) => `${JSON.stringify(key)}: ${JSON.stringify(payload[key])}`)
      .join(', ')} }`;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: { ...signedHeaders(payload), 'content-type': 'application/json' },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('webhook_signature_invalid');
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
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
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
    sqlMock.mockResolvedValueOnce([paymentIntentRow()]);
    sqlMock.mockResolvedValueOnce([]);
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
    sqlMock.mockResolvedValueOnce([paymentIntentRow({ status: 'authorized' })]);
    sqlMock.mockResolvedValueOnce([]);
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

  describe('plural sandbox environment', () => {
    const PLURAL_SECRET = Buffer.from('plural-webhook-secret', 'utf8');

    function pluralHeaders(rawBody: string): Record<string, string> {
      const webhookId = `wh_${Math.random().toString(16).slice(2)}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', PLURAL_SECRET)
        .update(Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`, 'utf8'), Buffer.from(rawBody, 'utf8')]))
        .digest('base64');
      return {
        'content-type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      };
    }

    function stubPluralCredentials(): void {
      vi.stubEnv('PLURAL_PINE_CLIENT_ID', 'plural-client-sandbox');
      vi.stubEnv('PLURAL_PINE_CLIENT_SECRET', 'plural-secret');
      vi.stubEnv('PLURAL_WEBHOOK_SECRET', PLURAL_SECRET.toString('base64'));
    }

    const sandboxIntent = (overrides: Record<string, unknown> = {}) => paymentIntentRow({
      provider: 'plural',
      provider_environment: 'sandbox',
      provider_payment_id: PAYMENT_INTENT,
      provider_raw_status: 'PENDING',
      ...overrides,
    });

    afterAll(() => vi.unstubAllEnvs());

    it('accepts a sandbox webhook when only PLURAL_SANDBOX_ENABLED is set (no live flags)', async () => {
      vi.unstubAllEnvs();
      vi.stubEnv('PLURAL_SANDBOX_ENABLED', 'true');
      stubPluralCredentials();
      const rawBody = JSON.stringify({
        event_id: 'evt_PLURAL_SANDBOX',
        event_type: 'payment.paid',
        merchant_order_reference: PAYMENT_INTENT,
        order_id: 'order_PLURAL_SANDBOX',
        status: 'paid',
      });
      sqlMock.mockResolvedValueOnce([sandboxIntent()]);
      sqlMock.mockResolvedValueOnce([]);
      sqlMock.mockResolvedValueOnce([webhookEventRow({ id: 'cwh_PLURAL_SANDBOX' })]);
      // (no replay-payload insert: that store is mock-provider only)
      sqlMock.mockResolvedValueOnce([{ id: 'caud_PLURAL_RECEIVED', occurred_at: new Date().toISOString() }]);
      sqlMock.mockResolvedValueOnce([paymentIntentRow({ provider: 'plural', provider_environment: 'sandbox', status: 'paid', provider_raw_status: 'PAID' })]);
      sqlMock.mockResolvedValueOnce([]);
      sqlMock.mockResolvedValueOnce([{ id: 'caud_PLURAL_PAID', occurred_at: new Date().toISOString() }]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/providers/plural',
        headers: pluralHeaders(rawBody),
        payload: rawBody,
      });

      // Previously the receiver defaulted to 'live' and rejected every
      // sandbox-only deployment with plural_live_disabled.
      expect(res.statusCode).not.toBe(403);
      expect(res.json()).toMatchObject({ data: { status: 'processed', payment_status: 'paid' } });
      expect(res.statusCode).toBe(200);
      expect(sqlCallCount(/FROM commerce_payment_intents/i)).toBeGreaterThan(0);
    });

    it('rejects a live intent on a sandbox-only deployment once the intent environment is known', async () => {
      vi.unstubAllEnvs();
      vi.stubEnv('PLURAL_SANDBOX_ENABLED', 'true');
      stubPluralCredentials();
      const rawBody = JSON.stringify({
        event_id: 'evt_PLURAL_LIVE_ON_SANDBOX',
        event_type: 'payment.paid',
        merchant_order_reference: PAYMENT_INTENT,
        status: 'paid',
      });
      // The receiver gate passes (sandbox is permitted); the exact
      // environment check after the intent loads must still reject.
      sqlMock.mockResolvedValueOnce([sandboxIntent({ provider_environment: 'live' })]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/providers/plural',
        headers: pluralHeaders(rawBody),
        payload: rawBody,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string; details?: { reason?: string } } }>().error)
        .toMatchObject({ code: 'plural_live_disabled', details: { reason: 'plural_live_disabled' } });
      expect(sqlCallCount(/FROM commerce_payment_intents/i)).toBe(1);
      expect(sqlCallCount(/UPDATE commerce_payment_intents/i)).toBe(0);
    });
  });

  it('does not update a payment intent when merchant boundary does not match', async () => {
    const payload = webhookPayload({
      event_id: 'evt_CROSS_TENANT',
      merchant_ref: 'mch_OTHER_TENANT',
      status: 'paid',
    });
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
    expect(content).toContain('uq_provider_webhook_tenant_merchant_event');
    expect(content).not.toContain('uq_provider_webhook_provider_event');
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

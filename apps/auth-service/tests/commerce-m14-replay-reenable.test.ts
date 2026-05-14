import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { stableJson } from '../src/lib/commerce/idempotency.js';
import { encrypt } from '../src/lib/vault-crypto.js';
import { sha256hex } from '../src/lib/hash.js';

let app: FastifyInstance;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const REPLAY_MIGRATION_PATH = join(TEST_DIR, '../src/db/migrations/050_commerce_provider_webhook_replay.sql');

const MERCHANT = 'mch_M14';
const AGENT = 'cag_M14';
const PAYMENT_INTENT = 'cpi_M14';
const PROVIDER_PAYMENT_ID = `mock_pay_${PAYMENT_INTENT}`;
const WEBHOOK_EVENT = 'cwh_M14';
const PROVIDER_EVENT = 'evt_M14';
const POLICY_ID = 'cpol_M14';
const MOCK_WEBHOOK_SECRET = ['mock', 'webhook', 'secret'].join('-');

beforeAll(async () => {
  app = await buildTestApp();
});

function paymentIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYMENT_INTENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    agent_id: AGENT,
    passport_jti: 'cpsp_M14',
    amount: 1000,
    currency: 'INR',
    provider: 'mock',
    provider_payment_id: PROVIDER_PAYMENT_ID,
    status: 'payment_pending',
    provider_raw_status: 'mock_payment_pending',
    policy_version: 'v1',
    decision_id: 'cpdec_M14',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function webhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: PROVIDER_EVENT,
    event_type: 'payment.updated',
    merchant_ref: MERCHANT,
    provider_payment_id: PROVIDER_PAYMENT_ID,
    status: 'paid',
    ...overrides,
  };
}

function encryptedPayload(payload: Record<string, unknown> = webhookPayload()): {
  rawBody: string;
  payloadHash: string;
  encrypted: string;
} {
  const rawBody = stableJson(payload);
  return {
    rawBody,
    payloadHash: sha256hex(rawBody),
    encrypted: encrypt(rawBody),
  };
}

function replayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = encryptedPayload();
  return {
    id: WEBHOOK_EVENT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    provider_key: 'mock',
    merchant_id: MERCHANT,
    payment_intent_id: PAYMENT_INTENT,
    provider_payment_id: PROVIDER_PAYMENT_ID,
    merchant_ref: MERCHANT,
    provider_event_id: PROVIDER_EVENT,
    provider_event_type: 'payment.updated',
    signature_validation_status: 'valid',
    replay_status: 'fresh',
    processing_status: 'failed',
    payload_hash: payload.payloadHash,
    error_code: 'invalid_payment_status_transition',
    error_message: 'Safe transition error',
    attempt_count: 1,
    replay_count: 0,
    last_replayed_at: null,
    has_replay_payload: true,
    encrypted_payload: payload.encrypted,
    safe_headers_json: { signature_scheme: 'mock-hmac-sha256-v1' },
    received_at: new Date().toISOString(),
    processed_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function merchant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MERCHANT,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    environment: 'sandbox',
    default_currency: 'INR',
    agentic_commerce_enabled: false,
    disabled_at: null,
    tenant_status: 'active',
    ...overrides,
  };
}

function activePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: POLICY_ID,
    tenant_id: TEST_COMMERCE_TENANT_ID,
    merchant_id: MERCHANT,
    version: 'v2',
    rules: { emergency_disable: false },
    status: 'active',
    created_by: 'dev_TEST',
    activated_by: 'dev_TEST',
    activated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

describe('M14 provider webhook replay', () => {
  it('stores encrypted replay payload only for future valid mock provider events', async () => {
    const payload = webhookPayload({ event_id: 'evt_STORE_PAYLOAD' });
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([paymentIntent()]);
    sqlMock.mockResolvedValueOnce([{ id: 'cwh_STORE_PAYLOAD' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_RECEIVED', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([paymentIntent({ status: 'paid', provider_raw_status: 'paid' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PAID', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/mock',
      headers: signedHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    const calls = flattenedSqlCalls();
    expect(calls).toContain('commerce_provider_webhook_event_payloads');
    expect(calls).toContain('encrypted_payload');
    expect(res.body).not.toContain(MOCK_WEBHOOK_SECRET);
    expect(res.body).not.toContain('sha256=');
  });

  it('lists replay availability without exposing raw or encrypted payload material', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([replayRow({
      encrypted_payload: 'encrypted-material-must-not-render',
      safe_headers_json: { signature: 'signature-must-not-render' },
    })]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/ops/provider-webhook-events?merchant_id=mch_M14&processing_status=failed',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{ replay_available: boolean; replay_blocker: string | null; replay_count: number }>;
      replay_available: boolean;
    }>();
    expect(body.items[0]).toMatchObject({
      replay_available: true,
      replay_blocker: null,
      replay_count: 0,
    });
    expect(body.replay_available).toBe(true);
    expect(res.body).not.toContain('encrypted-material-must-not-render');
    expect(res.body).not.toContain('signature-must-not-render');
    expect(res.body).not.toContain(MOCK_WEBHOOK_SECRET);
  });

  it('supports replay dry-run with a required reason', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([replayRow()]);
    sqlMock.mockResolvedValueOnce([paymentIntent()]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/ops/provider-webhook-events/${WEBHOOK_EVENT}/replay`,
      headers: authHeader(),
      payload: { reason: 'ops_review', dry_run: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; dry_run: boolean; target_payment_status: string } }>().data)
      .toMatchObject({ status: 'eligible', dry_run: true, target_payment_status: 'paid' });
    expect(flattenedSqlCalls()).not.toContain('UPDATE commerce_payment_intents');
  });

  it('replays a valid failed provider webhook through the payment state machine', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([replayRow()]);
    sqlMock.mockResolvedValueOnce([paymentIntent()]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REPLAY_REQUESTED', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([paymentIntent({ status: 'paid', provider_raw_status: 'paid' })]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_PAYMENT_PAID', occurred_at: new Date().toISOString() }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REPLAYED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/ops/provider-webhook-events/${WEBHOOK_EVENT}/replay`,
      headers: authHeader(),
      payload: { reason: 'ops_review', dry_run: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { status: string; payment_status: string }; audit_event_id: string }>())
      .toMatchObject({ data: { status: 'processed', payment_status: 'paid' }, audit_event_id: 'caud_REPLAYED' });
    const calls = flattenedSqlCalls();
    expect(calls).toContain('provider_webhook.replay_requested');
    expect(calls).toContain('provider_webhook.replayed');
    expect(calls).toContain('payment_intent.paid');
  });

  it('refuses invalid-signature and missing-payload events', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([replayRow({
      signature_validation_status: 'invalid',
      has_replay_payload: false,
      encrypted_payload: null,
    })]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REPLAY_DENIED', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/ops/provider-webhook-events/${WEBHOOK_EVENT}/replay`,
      headers: authHeader(),
      payload: { reason: 'ops_review' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string; details: { blocker: string } } }>().error)
      .toMatchObject({ code: 'provider_webhook_replay_denied', details: { blocker: 'original_signature_not_valid' } });
    expect(flattenedSqlCalls()).toContain('provider_webhook.replay_denied');
  });
});

describe('M14 emergency re-enable', () => {
  it('re-enables agentic commerce only with reviewed active policy evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([activePolicy()]);
    sqlMock.mockResolvedValueOnce([{
      id: MERCHANT,
      tenant_id: TEST_COMMERCE_TENANT_ID,
      agentic_commerce_enabled: true,
      updated_at: new Date().toISOString(),
    }]);
    sqlMock.mockResolvedValueOnce([{ id: 'caud_REENABLE', occurred_at: new Date().toISOString() }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/enable-agentic-commerce`,
      headers: authHeader(),
      payload: {
        reason: 'post_incident_review',
        reviewed_policy_id: POLICY_ID,
        incident_reference: 'inc_M14',
        confirm_reenable: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { agentic_commerce_enabled: boolean; reviewed_policy_id: string }; audit_event_id: string }>())
      .toMatchObject({ data: { agentic_commerce_enabled: true, reviewed_policy_id: POLICY_ID }, audit_event_id: 'caud_REENABLE' });
    const calls = flattenedSqlCalls();
    expect(calls).toContain('merchant.agentic_commerce_reenabled');
    expect(calls).toContain('agentic_commerce_enabled = TRUE');
    expect(calls).not.toContain('PLURAL_LIVE_ENABLED');
    expect(calls).not.toContain('COMMERCE_LIVE_MODE_ENABLED');
  });

  it('requires reason, reviewed policy, and explicit confirmation', async () => {
    seedCommerceContext();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/enable-agentic-commerce`,
      headers: authHeader(),
      payload: { reason: '', reviewed_policy_id: POLICY_ID, confirm_reenable: false },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { details: { fields: Record<string, string> } } }>().error.details.fields)
      .toHaveProperty('confirm_reenable');
  });

  it('rejects invalid reviewed policy evidence', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([merchant()]);
    sqlMock.mockResolvedValueOnce([activePolicy({ id: 'cpol_OTHER' })]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/enable-agentic-commerce`,
      headers: authHeader(),
      payload: { reason: 'review', reviewed_policy_id: POLICY_ID, confirm_reenable: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('reviewed_policy_not_active');
  });

  it('denies merchant callers for re-enable', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cmak_M14',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: MERCHANT,
      environment: 'sandbox',
      tenant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/enable-agentic-commerce`,
      headers: { authorization: `${'Bearer'} ${'grtx_sk_sandbox_merchant_m14_test_key'}` },
      payload: { reason: 'review', reviewed_policy_id: POLICY_ID, confirm_reenable: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('returns non-enumerating not found for tenant mismatch', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/merchants/${MERCHANT}/enable-agentic-commerce`,
      headers: authHeader(),
      payload: { reason: 'review', reviewed_policy_id: POLICY_ID, confirm_reenable: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('merchant_not_found');
  });
});

describe('M14 OpenAPI and migration drift guards', () => {
  it('adds encrypted provider webhook replay storage', () => {
    const migration = readFileSync(REPLAY_MIGRATION_PATH, 'utf8');
    expect(migration).toContain('commerce_provider_webhook_event_payloads');
    expect(migration).toContain('encrypted_payload');
    expect(migration).toContain('payload_hash');
    expect(migration).toContain('replay_count');
    expect(migration).not.toContain('raw_payload JSONB');
  });

  it('documents replay and re-enable endpoints in OpenAPI', () => {
    const openapi = readFileSync(OPENAPI_PATH, 'utf8');
    expect(openapi).toContain('/v1/commerce/ops/provider-webhook-events/{event_id}/replay');
    expect(openapi).toContain('operationId: replayCommerceProviderWebhookEvent');
    expect(openapi).toContain('/v1/commerce/merchants/{merchant_id}/enable-agentic-commerce');
    expect(openapi).toContain('operationId: enableMerchantAgenticCommerce');
    expect(openapi).toContain('ReplayProviderWebhookRequest');
    expect(openapi).toContain('EnableMerchantAgenticCommerceRequest');
  });
});

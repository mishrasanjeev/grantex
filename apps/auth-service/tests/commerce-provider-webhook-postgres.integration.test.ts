/**
 * Provider webhooks against real Postgres (#1987): a correctly signed Plural
 * webhook resolves its payment intent through the real lookup predicate when
 * the payment intent id and the merchant id differ, and moves the intent to
 * paid. The mock provider's merchant_ref (the Grantex merchant id) still
 * scopes the lookup, so a webhook naming another merchant changes nothing.
 * The route tests in commerce-provider-webhook.test.ts mock the SQL, so they
 * cannot catch a predicate that never matches.
 */
import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own (FINDINGS G-24).
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !adminDatabaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres provider webhook tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const TENANT = 'cten_WEBHOOK_PG';
const MERCHANT = 'mch_WEBHOOK_PG';
const OTHER_MERCHANT = 'mch_WEBHOOK_PG_OTHER';
const AGENT = 'cag_WEBHOOK_PG';
const KID = 'commerce-passport-20261116-whpg0001';
const PLURAL_SECRET = Buffer.from('plural-webhook-secret-integration', 'utf8');
const MOCK_SECRET = 'mock-webhook-secret-integration';

let sql: ReturnType<typeof postgres>;
let app: FastifyInstance;
let dropTestDatabase: (() => Promise<void>) | undefined;

async function seedPaymentIntent(input: {
  id: string;
  provider: 'plural' | 'mock';
  providerPaymentId: string;
  providerOrderId?: string;
}): Promise<void> {
  const suffix = input.id.slice(4);
  const consent = `crec_${suffix}`;
  const passport = `cpsp_${suffix}`;
  const cart = `ccart_${suffix}`;
  await sql`
    INSERT INTO commerce_consent_records (
      id, tenant_id, merchant_id, agent_id, consent_request_id, passport_type,
      requested_scopes, approved_scopes, consent_text_version, status, expires_at
    ) VALUES (
      ${consent}, ${TENANT}, ${MERCHANT}, ${AGENT}, ${`creq_${suffix}`}, 'checkout',
      ${['checkout']}, ${['checkout']}, 'v1', 'granted', NOW() + INTERVAL '1 hour'
    )
  `;
  await sql`
    INSERT INTO commerce_passports (
      jti, tenant_id, merchant_id, agent_id, consent_record_id, passport_type, kid,
      subject, scopes, max_amount, currency, environment, not_before, expires_at, agent_auth_method
    ) VALUES (
      ${passport}, ${TENANT}, ${MERCHANT}, ${AGENT}, ${consent}, 'checkout', ${KID},
      'principal_WEBHOOK_PG', ${['checkout']}, 100000, 'INR', 'sandbox',
      NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour', 'api_key'
    )
  `;
  await sql`
    INSERT INTO commerce_carts (
      id, tenant_id, merchant_id, agent_id, passport_jti, line_items, line_items_snapshot,
      currency, subtotal_amount, total_amount, status, expires_at, line_items_snapshot_hash
    ) VALUES (
      ${cart}, ${TENANT}, ${MERCHANT}, ${AGENT}, ${passport}, ${sql.json([])}, ${sql.json([])},
      'INR', 1000, 1000, 'payment_intent_created', NOW() + INTERVAL '1 hour', ${'c'.repeat(64)}
    )
  `;
  await sql`
    INSERT INTO commerce_payment_intents (
      id, tenant_id, merchant_id, agent_id, cart_id, passport_jti,
      amount, currency, provider, provider_environment,
      provider_payment_id, provider_order_id, status,
      line_items_snapshot, idempotency_key_hash, provider_raw_status,
      policy_version, decision_id, expires_at
    ) VALUES (
      ${input.id}, ${TENANT}, ${MERCHANT}, ${AGENT}, ${cart}, ${passport},
      1000, 'INR', ${input.provider}, 'sandbox',
      ${input.providerPaymentId}, ${input.providerOrderId ?? null}, 'payment_pending',
      ${sql.json([])}, ${'d'.repeat(64)}, 'PENDING',
      'v1', ${`cpdec_${suffix}`}, NOW() + INTERVAL '15 minutes'
    )
  `;
}

async function intentStatus(id: string): Promise<string | undefined> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM commerce_payment_intents WHERE id = ${id}`;
  return rows[0]?.status;
}

function pluralHeaders(rawBody: string, webhookId: string): Record<string, string> {
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

function mockHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', MOCK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  return {
    'content-type': 'application/json',
    'x-mock-timestamp': String(timestamp),
    'x-mock-signature': `sha256=${signature}`,
  };
}

describePostgres('provider webhooks against real Postgres', () => {
  beforeAll(async () => {
    const db = await createTestDatabase('provider-webhooks');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 6, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    await sql`INSERT INTO commerce_tenants (id, display_name) VALUES (${TENANT}, 'Webhook tenant')`;
    const [preset] = await sql`SELECT preset_key FROM commerce_category_presets ORDER BY preset_key LIMIT 1`;
    for (const merchant of [MERCHANT, OTHER_MERCHANT]) {
      await sql`
        INSERT INTO commerce_merchants (id, tenant_id, legal_name, display_name, category_preset)
        VALUES (${merchant}, ${TENANT}, 'Synthetic Store Pvt Ltd', 'Synthetic Store', ${preset!['preset_key'] as string})
      `;
    }
    await sql`
      INSERT INTO commerce_agents (id, tenant_id, display_name, api_key_hash, trust_status)
      VALUES (${AGENT}, ${TENANT}, 'shopper-01', ${'a'.repeat(64)}, 'trusted')
    `;
    await sql`
      INSERT INTO commerce_passport_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk)
      VALUES (${KID}, 'ES256', ${sql.json({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' })}, 'not-a-real-key')
    `;
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
    vi.stubEnv('PLURAL_SANDBOX_ENABLED', 'true');
    vi.stubEnv('PLURAL_PINE_CLIENT_ID', 'plural-client-sandbox');
    vi.stubEnv('PLURAL_PINE_CLIENT_SECRET', 'plural-secret');
    vi.stubEnv('PLURAL_WEBHOOK_SECRET', PLURAL_SECRET.toString('base64'));
    vi.stubEnv('MOCK_PAYMENT_WEBHOOK_SECRET', MOCK_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a signed Plural webhook carrying merchant_order_reference moves its payment intent to paid', async () => {
    // The payment intent id and the merchant id differ, as they always do.
    const intent = 'cpi_PLURALPG01';
    await seedPaymentIntent({ id: intent, provider: 'plural', providerPaymentId: intent, providerOrderId: 'order_PLURALPG01' });
    const rawBody = JSON.stringify({
      event_id: 'evt_PLURALPG01',
      event_type: 'payment.paid',
      merchant_order_reference: intent,
      order_id: 'order_PLURALPG01',
      status: 'PROCESSED',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/plural',
      headers: pluralHeaders(rawBody, 'wh_PLURALPG01'),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { status: 'processed', payment_status: 'paid', payment_intent_id: intent } });
    expect(await intentStatus(intent)).toBe('paid');
    const events = await sql<{ merchant_id: string | null; merchant_ref: string | null; processing_status: string }[]>`
      SELECT merchant_id, merchant_ref, processing_status
        FROM commerce_provider_webhook_events
       WHERE provider_key = 'plural' AND provider_event_id = 'evt_PLURALPG01'
    `;
    expect(events).toEqual([{ merchant_id: MERCHANT, merchant_ref: null, processing_status: 'processed' }]);
  });

  it('a signed Plural webhook that only carries the Plural order id still resolves its payment intent', async () => {
    const intent = 'cpi_PLURALPG02';
    await seedPaymentIntent({ id: intent, provider: 'plural', providerPaymentId: intent, providerOrderId: 'order_PLURALPG02' });
    const rawBody = JSON.stringify({ event_type: 'payment.failed', order_id: 'order_PLURALPG02', status: 'FAILED' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/plural',
      headers: pluralHeaders(rawBody, 'wh_PLURALPG02'),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { status: 'processed', payment_status: 'failed', payment_intent_id: intent } });
    expect(await intentStatus(intent)).toBe('failed');
  });

  it('a signed Plural webhook for an unknown reference is recorded as ignored and changes nothing', async () => {
    const intent = 'cpi_PLURALPG03';
    await seedPaymentIntent({ id: intent, provider: 'plural', providerPaymentId: intent });
    const rawBody = JSON.stringify({ event_type: 'payment.paid', merchant_order_reference: 'cpi_UNKNOWNREF', status: 'PROCESSED' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/providers/plural',
      headers: pluralHeaders(rawBody, 'wh_PLURALPG03'),
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ data: { status: 'ignored', reason: 'payment_intent_not_found', payment_intent_id: null } });
    expect(await intentStatus(intent)).toBe('payment_pending');
  });

  it('the mock provider merchant_ref still scopes the lookup to the Grantex merchant', async () => {
    const intent = 'cpi_MOCKPG01';
    const providerPaymentId = `mock_pay_${intent}`;
    await seedPaymentIntent({ id: intent, provider: 'mock', providerPaymentId });

    const crossMerchant = JSON.stringify({
      event_id: 'evt_MOCKPG_CROSS', event_type: 'payment.updated',
      merchant_ref: OTHER_MERCHANT, provider_payment_id: providerPaymentId, status: 'paid',
    });
    const denied = await app.inject({
      method: 'POST', url: '/v1/webhooks/providers/mock', headers: mockHeaders(crossMerchant), payload: crossMerchant,
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ data: { status: 'ignored', reason: 'payment_intent_not_found', payment_intent_id: null } });
    expect(await intentStatus(intent)).toBe('payment_pending');

    const sameMerchant = JSON.stringify({
      event_id: 'evt_MOCKPG_SAME', event_type: 'payment.updated',
      merchant_ref: MERCHANT, provider_payment_id: providerPaymentId, status: 'paid',
    });
    const accepted = await app.inject({
      method: 'POST', url: '/v1/webhooks/providers/mock', headers: mockHeaders(sameMerchant), payload: sameMerchant,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ data: { status: 'processed', payment_status: 'paid', payment_intent_id: intent } });
    expect(await intentStatus(intent)).toBe('paid');
  });
});

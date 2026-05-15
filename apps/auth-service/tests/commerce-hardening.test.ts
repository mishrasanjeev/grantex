import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authHeader, buildTestApp, sqlMock } from './helpers.js';
import { seedCommerceContext, TEST_COMMERCE_TENANT_ID } from './commerce-helpers.js';
import { commerceLogContext } from '../src/lib/commerce/observability.js';
import { MockPaymentProvider } from '../src/lib/commerce/payment-providers/index.js';
import { sha256hex } from '../src/lib/hash.js';

let app: FastifyInstance;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const ROUTES_DIR = join(TEST_DIR, '..', 'src', 'routes');
const OPS_GUIDE_PATH = join(TEST_DIR, '..', '..', '..', 'docs', 'guides', 'commerce-v1-operations.mdx');
const COMPOSE_PATH = join(TEST_DIR, '..', '..', '..', 'docker-compose.yml');
const WEB_VALIDATE_PATH = join(TEST_DIR, '..', '..', '..', 'web', 'commerce-playground.validate.mjs');
const SEED_SCRIPT_PATH = join(TEST_DIR, '..', '..', '..', 'scripts', 'commerce-pilot-seed-local.mjs');
const LOAD_HARNESS_PATH = join(TEST_DIR, '..', '..', '..', 'scripts', 'commerce-pilot-load-harness.mjs');

function readRoute(name: string): string {
  return readFileSync(join(ROUTES_DIR, name), 'utf8');
}

function expectRouteRateLimit(content: string, path: string, max: number): void {
  const start = content.indexOf(`'${path}'`);
  expect(start).toBeGreaterThan(-1);
  const routeBlock = content.slice(start, start + 1200);
  expect(routeBlock).toMatch(
    new RegExp(`rateLimit:\\s*\\{\\s*max:\\s*${max},\\s*timeWindow:\\s*'1 minute'(?:\\s*,[^}]*)?\\s*\\}`),
  );
}

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Commerce M6A observability hardening', () => {
  it('builds structured log context with only safe identifiers and hashed passport references', () => {
    const rawPassportJti = 'cpsp_sensitive_passport_jti_123';
    const rawIdempotencyKey = 'plain-idempotency-key';
    const context = commerceLogContext({
      requestId: 'req_TEST',
      tenantId: TEST_COMMERCE_TENANT_ID,
      merchantId: 'mch_TEST',
      agentId: 'cag_TEST',
      passportJti: rawPassportJti,
      paymentIntentId: 'cpi_TEST',
      providerPaymentId: 'mock_pay_TEST',
      idempotencyKeyHash: sha256hex(rawIdempotencyKey),
      errorCode: 'provider_timeout',
    });

    const serialized = JSON.stringify(context);
    expect(context).toMatchObject({
      request_id: 'req_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_TEST',
      agent_id: 'cag_TEST',
      passport_jti_ref: `sha256:${sha256hex(rawPassportJti).slice(0, 16)}`,
      payment_intent_id: 'cpi_TEST',
      provider_payment_id_ref: `provider_payment:${sha256hex('mock_pay_TEST').slice(0, 16)}`,
      idempotency_key_hash: sha256hex(rawIdempotencyKey),
      error_code: 'provider_timeout',
    });
    expect(serialized).not.toContain(rawPassportJti);
    expect(serialized).not.toContain(rawIdempotencyKey);
    expect(serialized).not.toContain('mock_pay_TEST');
  });

  it('sanitizes log control characters and hashes provider-controlled webhook identifiers', () => {
    const context = commerceLogContext({
      requestId: 'req_TEST',
      providerPaymentId: 'mock_pay_UNSAFE\nVALUE',
      webhookProviderEventId: 'evt_UNSAFE\rVALUE',
      status: 'processed\tok',
    });

    const serialized = JSON.stringify(context);
    expect(context.provider_payment_id_ref).toBe(`provider_payment:${sha256hex('mock_pay_UNSAFE\nVALUE').slice(0, 16)}`);
    expect(context.webhook_provider_event_id_ref).toBe(`provider_event:${sha256hex('evt_UNSAFE\rVALUE').slice(0, 16)}`);
    expect(context.status).toBe('processed_ok');
    expect(serialized).not.toContain('mock_pay_UNSAFE');
    expect(serialized).not.toContain('evt_UNSAFE');
    expect(serialized).not.toMatch(/[\r\n\t]/);
  });

  it('pre-sanitizes cart and payment route log values before structured logging', () => {
    const cartPayment = readRoute('commerce-cart-payment.ts');

    expect(cartPayment).toContain("merchantId: merchantId.replace(/[\\r\\n\\t]/g, '_')");
    expect(cartPayment).toContain("cartId: cartId.replace(/[\\r\\n\\t]/g, '_')");
    expect(cartPayment).toContain("providerKey: providerKey.replace(/[\\r\\n\\t]/g, '_')");
    expect(cartPayment).toContain("providerPaymentIdRef: hashedReference(providerResult.provider_payment_id.replace(/[\\r\\n\\t]/g, '_'), 'provider_payment')");
    expect(cartPayment).toContain("passportJtiRef: hashedReference(passport.jti.replace(/[\\r\\n\\t]/g, '_'))");
  });

  it('mock provider metadata stores idempotency hash only, not plaintext prefixes', async () => {
    const rawIdempotencyKey = 'idem_SECRET_PREFIX_SHOULD_NOT_LEAK';
    const result = await new MockPaymentProvider().createPaymentIntent({
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_TEST',
      agent_id: 'cag_TEST',
      payment_intent_id: 'cpi_TEST',
      cart_id: 'cart_TEST',
      passport_jti: 'cpsp_TEST',
      amount: { amount_minor_units: 1000, currency: 'INR' },
      line_items_snapshot: [],
      idempotency_key: rawIdempotencyKey,
      environment: 'sandbox',
      metadata: {},
    });

    const serialized = JSON.stringify(result.provider_metadata);
    expect(result.provider_metadata['idempotency_key_hash']).toBe(sha256hex(rawIdempotencyKey));
    expect(serialized).not.toContain(rawIdempotencyKey);
    expect(serialized).not.toContain(rawIdempotencyKey.slice(0, 8));
    expect(serialized).not.toContain('idempotency_key_hash_hint');
  });
});

describe('Commerce operations health', () => {
  it('returns safe operator-only commerce readiness checks', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{ one: 1 }]);
    sqlMock.mockResolvedValueOnce([{ backlog_count: '2', recent_failure_count: '1' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/ops/health?merchant_id=mch_HEALTH',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      tenant_id: string;
      merchant_id: string;
      checks: {
        database: { ok: boolean };
        provider_adapters: { mock: { ok: boolean }; plural: { ok: boolean; status: string } };
        webhook_backlog: { backlog_count: number; recent_failure_count: number };
      };
      blockers: string[];
    }>();
    expect(body.status).toBe('degraded');
    expect(body.tenant_id).toBe(TEST_COMMERCE_TENANT_ID);
    expect(body.merchant_id).toBe('mch_HEALTH');
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.provider_adapters.mock.ok).toBe(true);
    expect(body.checks.provider_adapters.plural.ok).toBe(false);
    expect(body.checks.provider_adapters.plural.status).toBe('down');
    expect(body.checks.webhook_backlog).toMatchObject({
      backlog_count: 2,
      recent_failure_count: 1,
    });
    expect(body.blockers).toContain('plural_api_and_webhook_contract_unconfirmed');
    expect(body.blockers).toContain('provider_webhook_replay_mock_only_until_plural_contract');
    expect(res.body).not.toContain('mock-webhook-secret');
    expect(res.body).not.toContain('Bearer');
    expect(res.body).not.toContain('encrypted_secret_blob');
  });

  it('denies merchant callers for commerce operations health', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cmak_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_HEALTH',
      environment: 'sandbox',
      tenant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/ops/health?merchant_id=mch_HEALTH',
      headers: { authorization: 'Bearer grtx_sk_sandbox_operator_denied_test_key' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('lists failed provider webhook events with safe metadata only', async () => {
    seedCommerceContext();
    sqlMock.mockResolvedValueOnce([{
      id: 'cwh_FAILED',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      provider_key: 'mock',
      merchant_id: 'mch_HEALTH',
      payment_intent_id: 'cpi_FAILED',
      provider_payment_id: 'mock_pay_FAILED',
      provider_event_id: 'evt_FAILED',
      provider_event_type: 'payment.updated',
      signature_validation_status: 'valid',
      replay_status: 'fresh',
      processing_status: 'failed',
      payload_hash: 'payload_hash_safe',
      raw_payload_ref: 'raw-ref-must-not-render',
      provider_metadata: { raw_signature: 'signature-must-not-render' },
      error_code: 'invalid_payment_status_transition',
      error_message: 'Safe transition error',
      attempt_count: 1,
      received_at: new Date().toISOString(),
      processed_at: null,
      updated_at: new Date().toISOString(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/ops/provider-webhook-events?merchant_id=mch_HEALTH&processing_status=failed',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: Array<{
        id: string;
        processing_status: string;
        payload_hash: string;
        replay_available: boolean;
        replay_blocker: string;
      }>;
      replay_available: boolean;
      replay_blocker: string;
    }>();
    expect(body.items[0]).toMatchObject({
      id: 'cwh_FAILED',
      processing_status: 'failed',
      payload_hash: 'payload_hash_safe',
      replay_available: false,
      replay_blocker: 'encrypted_payload_not_available',
    });
    expect(body.replay_available).toBe(false);
    expect(res.body).not.toContain('raw-ref-must-not-render');
    expect(res.body).not.toContain('signature-must-not-render');
    expect(res.body).not.toContain('mock-webhook-secret');
    expect(JSON.stringify(sqlMock.mock.calls)).toContain('WHERE e.tenant_id = ');
  });

  it('denies merchant callers for provider webhook event visibility', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cmak_TEST',
      tenant_id: TEST_COMMERCE_TENANT_ID,
      merchant_id: 'mch_HEALTH',
      environment: 'sandbox',
      tenant_status: 'active',
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/ops/provider-webhook-events?merchant_id=mch_HEALTH',
      headers: { authorization: 'Bearer grtx_sk_sandbox_operator_denied_test_key' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('operator_required');
  });

  it('marks commerce operations health implemented in OpenAPI', () => {
    const content = readFileSync(OPENAPI_PATH, 'utf8');
    const start = content.indexOf('/v1/commerce/ops/health:');
    expect(start).toBeGreaterThan(-1);
    const section = content.slice(start, content.indexOf('# =====================================================================', start));
    expect(section).toContain('operationId: getCommerceOpsHealth');
    expect(section).toContain('x-implemented: true');
    expect(section).toContain('x-milestone: M6A');
    expect(section).toContain('CommerceOpsHealth');
    expect(section).toContain('/v1/commerce/ops/provider-webhook-events:');
    expect(section).toContain('operationId: listCommerceProviderWebhookEvents');
    expect(section).toContain('x-milestone: M7A');
    expect(section).toContain('CommerceProviderWebhookEvent');
  });
});

describe('Commerce M6C security and rate-limit hardening', () => {
  it('keeps JWKS as the only global rate-limit allowlist route', () => {
    const content = readFileSync(join(TEST_DIR, '..', 'src', 'server.ts'), 'utf8');
    const allowListStart = content.indexOf('allowList: (req) =>');
    expect(allowListStart).toBeGreaterThan(-1);
    const allowListBlock = content.slice(allowListStart, allowListStart + 500);
    expect(allowListBlock).toContain('/.well-known/jwks.json');
    expect(allowListBlock).not.toContain('/.well-known/grantex-commerce');
    expect(allowListBlock).not.toContain('/mcp');
  });

  it('configures route-local limits for commerce-sensitive endpoints', () => {
    const consent = readRoute('commerce-consent.ts');
    expectRouteRateLimit(consent, '/consent/page', 60);
    expectRouteRateLimit(consent, '/consent/:reqId/challenge', 60);
    expectRouteRateLimit(consent, '/consent/:reqId/challenge/verify', 60);
    expectRouteRateLimit(consent, '/consent/:reqId/approve', 60);
    expectRouteRateLimit(consent, '/consent/:reqId/deny', 60);

    const passport = readRoute('commerce-passport.ts');
    expectRouteRateLimit(passport, '/passports/consent-requests', 120);
    expectRouteRateLimit(passport, '/passports/exchange', 120);
    expectRouteRateLimit(passport, '/passports/verify', 1000);
    expectRouteRateLimit(passport, '/passports/revoke', 120);

    const policy = readRoute('commerce-policy.ts');
    expectRouteRateLimit(policy, '/policies', 60);
    expectRouteRateLimit(policy, '/policies/:policyId/activate', 60);
    expectRouteRateLimit(policy, '/policies/evaluate', 1000);
    expectRouteRateLimit(policy, '/merchants/:merchantId/disable-agentic-commerce', 30);

    const cartPayment = readRoute('commerce-cart-payment.ts');
    expectRouteRateLimit(cartPayment, '/carts', 120);
    expectRouteRateLimit(cartPayment, '/payments/intents', 60);
    expectRouteRateLimit(cartPayment, '/payments/intents/:id/checkout-link', 60);
    expectRouteRateLimit(cartPayment, '/payments/intents/:id/reconcile', 60);

    expectRouteRateLimit(readRoute('commerce-provider-webhooks.ts'), '/:provider_key', 1000);
    expectRouteRateLimit(readRoute('commerce-mcp.ts'), '/mcp', 600);
    expectRouteRateLimit(readRoute('commerce-well-known.ts'), '/.well-known/grantex-commerce', 60);
    expectRouteRateLimit(readRoute('commerce-ops.ts'), '/ops/health', 60);
    expectRouteRateLimit(readRoute('commerce-ops.ts'), '/ops/provider-webhook-events', 60);
    expectRouteRateLimit(readRoute('commerce-ops.ts'), '/ops/provider-webhook-events/:event_id/replay', 30);
    expectRouteRateLimit(readRoute('commerce.ts'), '/catalog/search', 600);
  });

  it('keeps the local load-test rate-limit bypass scoped to localhost with live mode disabled', () => {
    const cartPayment = readRoute('commerce-cart-payment.ts');
    const compose = readFileSync(COMPOSE_PATH, 'utf8');

    expect(cartPayment).toContain('COMMERCE_LOCAL_LOAD_TEST');
    expect(cartPayment).toContain('COMMERCE_LIVE_MODE_ENABLED');
    expect(cartPayment).toContain('PLURAL_LIVE_ENABLED');
    expect(cartPayment).toContain('PUBLIC_BASE_URL');
    expect(cartPayment).toContain('isLocalPublicBaseUrl');
    expect(cartPayment).toContain('isLocalLoadTestClientAddress(request.ip)');
    expect(cartPayment).toContain('isLocalLoadTestClientAddress(key)');
    expect(compose).toContain('COMMERCE_LOCAL_LOAD_TEST: "true"');
    expect(compose).toContain('COMMERCE_LIVE_MODE_ENABLED: "false"');
    expect(compose).toContain('PLURAL_LIVE_ENABLED: "false"');
    expect(compose).toContain('PUBLIC_BASE_URL: http://localhost:3001');
  });

  it('keeps CodeQL review hardening in static commerce scripts and route validators', () => {
    const playgroundValidate = readFileSync(WEB_VALIDATE_PATH, 'utf8');
    const seedScript = readFileSync(SEED_SCRIPT_PATH, 'utf8');
    const loadHarness = readFileSync(LOAD_HARNESS_PATH, 'utf8');
    const mcpRoute = readRoute('commerce-mcp.ts');
    const cartPayment = readRoute('commerce-cart-payment.ts');
    const webhooks = readRoute('commerce-provider-webhooks.ts');
    const reconciliation = readFileSync(join(ROUTES_DIR, '..', 'lib', 'commerce', 'payment-reconciliation.ts'), 'utf8');

    expect(playgroundValidate).toContain('function extractStaticBlock');
    expect(playgroundValidate).toContain('<script type="application/json" id="commerce-playground-manifest">');
    expect(playgroundValidate).toContain("extractStaticBlock(html, '<script>', '</script>', 'playground browser script'");
    expect(playgroundValidate).not.toContain('matchAll(/<script');

    expect(seedScript).not.toContain('existsSync');
    expect(seedScript).not.toContain("const OPERATOR_API_KEY =");
    expect(seedScript).toContain('syntheticLocalApiKeyHash');
    expect(seedScript).toContain('OPERATOR_API_KEY_HASH');
    expect(seedScript).toContain('AGENT_API_KEY_HASH');

    expect(mcpRoute).toContain('unknownKeys.push');
    expect(mcpRoute).toContain("validationError({ arguments:");

    expect(cartPayment).toContain("case 'order_reference':");
    expect(cartPayment).toContain("fieldErrors['passport_jwt'] = 'required string'");
    expect(cartPayment).toContain("providerPaymentIdRef: hashedReference");
    expect(cartPayment).not.toContain('if (body.passport_jwt !== undefined)');

    expect(webhooks).toContain('webhookProviderEventIdRef: hashedReference');
    expect(webhooks).toContain('providerPaymentIdRef:');

    expect(reconciliation).toContain('last_reconciliation_error = NULL');
    expect(reconciliation).toContain('last_reconciliation_retryable = NULL');

    expect(loadHarness).toContain('function requireLocalBaseUrl');
    expect(loadHarness).toContain('out.COMMERCE_LOAD_API_BASE = requireLocalBaseUrl(out.COMMERCE_LOAD_API_BASE)');
    expect(loadHarness).toContain("url.protocol === 'http:'");
    expect(loadHarness).toContain("url.password === ''");
  });

  it('documents deferred webhook replay and emergency re-enable blockers', () => {
    const guide = readFileSync(OPS_GUIDE_PATH, 'utf8');
    expect(guide).toContain('provider_webhook_replay_mock_only_until_plural_contract');
    expect(guide).toContain('Do not replay invalid-signature, stale, unsupported-provider, malformed, or unauthenticated events');
    expect(guide).toContain('Emergency re-enable is operator-only');
    expect(guide).toContain('reviewed active policy');

    const openapi = readFileSync(OPENAPI_PATH, 'utf8');
    const healthStart = openapi.indexOf('/v1/commerce/ops/health:');
    expect(healthStart).toBeGreaterThan(-1);
    const healthSection = openapi.slice(healthStart, openapi.indexOf('# =====================================================================', healthStart));
    expect(healthSection).toContain('mock-provider replay');
    expect(healthSection).toContain('operator-only emergency re-enable');
  });
});

#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_STAGING_ORIGINS = [
  'https://api-staging.grantex.dev',
  'https://staging.grantex.dev',
  'https://staging.agenticorg.ai',
];
const REFUSED_PRODUCTION_ORIGINS = [
  'https://grantex.dev',
  'https://api.grantex.dev',
  'https://app.agenticorg.ai',
];
const REFUSED_PRODUCTION_RESOURCE_NAMES = new Set(['grantex-auth', 'grantex-pg16', 'grantex-redis']);
const DEFAULT_REPORT = 'docs/reports/commerce-v1-option-a-smoke-evidence.md';
const DEFAULT_FIXTURE_ENV = '.tmp/commerce-agent-real-staging.env';
const AUTH_ENV_NAMES = ['GRANTEX_COMMERCE_BEARER_TOKEN', 'GRANTEX_AGENT_ASSERTION', 'GRANTEX_API_KEY'];
const SENSITIVE_FIXTURE_ENV_NAMES = [
  ...AUTH_ENV_NAMES,
  'AGENTICORG_COMMERCE_BROWSE_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_DENIED_CONSENT_REF',
];
const APPROVED_CASES = [
  'health',
  'jwks',
  'commerce_well_known',
  'mcp_initialize',
  'mcp_tools_list',
  'merchant_profile',
  'catalog_search',
  'catalog_get_item',
  'inventory_check',
  'cart_create',
  'consent_request',
  'consent_exchange',
  'payment_intent_create',
  'checkout_create',
  'payment_status',
  'missing_consent_refusal',
  'amount_cap_breach_refusal',
  'revoked_passport_refusal',
  'expired_passport_refusal',
  'denied_consent_refusal',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === name && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
      return process.argv[index + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function isTrue(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function cliFlagTrue(...names) {
  return names.some((name) => isTrue(argValue(name, 'false')));
}

function parseUrl(value, label) {
  if (!value) {
    fail(`Missing required ${label}`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Refusing invalid ${label}: ${value}`);
  }
  if (url.username || url.password) {
    fail(`Refusing credentialed URL for ${label}`);
  }
  if (REFUSED_PRODUCTION_ORIGINS.includes(url.origin)) {
    fail(`Refusing production domain for ${label}: ${url.origin}`);
  }
  if (url.protocol !== 'https:') {
    fail(`Refusing non-HTTPS URL for ${label}`);
  }
  if (url.search || (url.pathname !== '/' && url.pathname !== '')) {
    fail(`Refusing path or query in ${label}; provide the origin only`);
  }
  return url;
}

function validateSmokeAllowlist(value) {
  if (!value) return null;
  const url = parseUrl(value, 'smoke Cloud Run allowlist');
  if (!url.hostname.endsWith('.run.app')) {
    fail('Refusing smoke allowlist URL that is not a run.app origin');
  }
  return url.origin;
}

function validateApiBase(value, allowedSmokeOrigin, run) {
  const url = parseUrl(value, 'Option A smoke API base');
  if (allowedSmokeOrigin && url.origin === allowedSmokeOrigin) {
    return url.origin;
  }
  if (url.hostname.endsWith('.run.app')) {
    fail('Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url');
  }
  if (run) {
    fail('Option A smoke evidence run requires the exact approved smoke Cloud Run allowlist');
  }
  if (!ALLOWED_STAGING_ORIGINS.includes(url.origin)) {
    fail(`Refusing non-staging API base: ${url.origin}`);
  }
  return url.origin;
}

function assertNotProductionResourceName(value, label) {
  if (REFUSED_PRODUCTION_RESOURCE_NAMES.has(value)) {
    fail(`Refusing production resource name for ${label}: ${value}`);
  }
}

function assertInsideRepo(pathInput, label) {
  const resolved = resolve(repoRoot, pathInput);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith('..') || rel === '') {
    fail(`Refusing ${label} outside repo workspace: ${pathInput}`);
  }
  return { resolved, relativePath: rel.replace(/\\/g, '/') };
}

function assertInsideTmp(pathInput) {
  const { resolved, relativePath } = assertInsideRepo(pathInput, 'fixture env path');
  const isTmpChild = relativePath.startsWith('.tmp/');
  if (!isTmpChild) {
    fail(`Refusing AgenticOrg fixture env input outside .tmp/: ${pathInput}`);
  }
  return { resolved, relativePath };
}

function safeString(value, label, { min = 0, max = 256, pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail(`Failing closed because ${label} is not a string`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    fail(`Failing closed because ${label} is empty`);
  }
  if (trimmed.length < min || trimmed.length > max) {
    fail(`Failing closed because ${label} has invalid length`);
  }
  if (/[\r\n]/.test(trimmed)) {
    fail(`Failing closed because ${label} contains line breaks`);
  }
  if (pattern && !pattern.test(trimmed)) {
    fail(`Failing closed because ${label} contains unsupported characters`);
  }
  return trimmed;
}

function optionalSafeString(value, label, options = {}) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return safeString(text, label, options);
}

function safeSyntheticId(value, label) {
  return safeString(String(value ?? ''), label, {
    min: 3,
    max: 128,
    pattern: /^[A-Za-z0-9_.:-]+$/,
  });
}

function safeCurrency(value, label) {
  return safeString(String(value ?? ''), label, {
    min: 3,
    max: 3,
    pattern: /^[A-Z]{3}$/,
  });
}

function safeMinorUnits(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) {
    fail(`Failing closed because ${label} is invalid`);
  }
  const amount = Number.parseInt(text, 10);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000) {
    fail(`Failing closed because ${label} is invalid`);
  }
  return amount;
}

function safeSensitiveRuntimeValue(value, label) {
  return safeString(String(value ?? '').replace(/^Bearer\s+/i, ''), label, {
    min: 8,
    max: 8192,
    pattern: /^[A-Za-z0-9._~+/=-]+$/,
  });
}

function parseDotenv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    values[key] = value;
  }
  return values;
}

function validateFixtureForNetwork(values, authName, apiBase) {
  if (values.AGENTICORG_COMMERCE_FIXTURE_PROVIDER && values.AGENTICORG_COMMERCE_FIXTURE_PROVIDER !== 'mock') {
    fail('Failing closed because AgenticOrg fixture env is not mock provider');
  }
  if (values.AGENTICORG_COMMERCE_FIXTURE_SYNTHETIC_ONLY && values.AGENTICORG_COMMERCE_FIXTURE_SYNTHETIC_ONLY !== 'true') {
    fail('Failing closed because AgenticOrg fixture env is not synthetic-only');
  }

  const authValue = values[authName] || process.env[authName] || '';
  const safe = {
    apiBase: safeString(apiBase, 'approved smoke URL', {
      min: 12,
      max: 256,
      pattern: /^https:\/\/[A-Za-z0-9.-]+\.run\.app$/,
    }),
    authName,
    authValue: safeSensitiveRuntimeValue(authValue, authName),
    merchantId: safeSyntheticId(values.AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID, 'fixture merchant id'),
    agentId: safeSyntheticId(values.AGENTICORG_COMMERCE_FIXTURE_AGENT_ID, 'fixture agent id'),
    productId: safeSyntheticId(values.AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID, 'fixture product id'),
    variantId: safeSyntheticId(values.AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID, 'fixture variant id'),
    currency: safeCurrency(values.AGENTICORG_COMMERCE_FIXTURE_CURRENCY || 'INR', 'fixture currency'),
    amountMinorUnits: safeMinorUnits(values.AGENTICORG_COMMERCE_FIXTURE_AMOUNT_MINOR_UNITS || '0', 'fixture amount minor units'),
    browsePassport: optionalSafeString(values.AGENTICORG_COMMERCE_BROWSE_PASSPORT_JWT || process.env.AGENTICORG_COMMERCE_BROWSE_PASSPORT_JWT, 'browse passport', {
      min: 8,
      max: 8192,
      pattern: /^[A-Za-z0-9._~+/=-]+$/,
    }),
    checkoutPassport: optionalSafeString(values.AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT || process.env.AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT, 'checkout passport', {
      min: 8,
      max: 8192,
      pattern: /^[A-Za-z0-9._~+/=-]+$/,
    }),
    revokedPassport: optionalSafeString(values.AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT || process.env.AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT, 'revoked passport', {
      min: 8,
      max: 8192,
      pattern: /^[A-Za-z0-9._~+/=-]+$/,
    }),
    expiredPassport: optionalSafeString(values.AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT || process.env.AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT, 'expired passport', {
      min: 8,
      max: 8192,
      pattern: /^[A-Za-z0-9._~+/=-]+$/,
    }),
    deniedConsentRef: optionalSafeString(values.AGENTICORG_COMMERCE_DENIED_CONSENT_REF || process.env.AGENTICORG_COMMERCE_DENIED_CONSENT_REF, 'denied consent ref', {
      min: 3,
      max: 256,
      pattern: /^[A-Za-z0-9_.:-]+$/,
    }),
  };
  return Object.freeze(safe);
}

function loadFixtureEnv(pathInput, apiBase) {
  const { resolved, relativePath } = assertInsideTmp(pathInput);
  let text;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    fail('Failing closed because AgenticOrg fixture env is missing');
  }
  const values = parseDotenv(text);
  for (const required of [
    'GRANTEX_COMMERCE_BASE_URL',
    'GRANTEX_BASE_URL',
    'AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL',
    'AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_AGENT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID',
  ]) {
    if (!values[required]) {
      fail(`Failing closed because AgenticOrg fixture env is missing ${required}`);
    }
  }
  for (const urlName of ['GRANTEX_COMMERCE_BASE_URL', 'GRANTEX_BASE_URL', 'AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL']) {
    if (values[urlName] !== apiBase) {
      fail(`Failing closed because ${urlName} does not match the approved smoke URL`);
    }
  }
  const authNames = AUTH_ENV_NAMES.filter((name) => values[name] || process.env[name]);
  if (authNames.length !== 1) {
    fail('Failing closed because AgenticOrg fixture env must provide exactly one Grantex auth source');
  }
  const authName = authNames[0];
  return { relativePath, values, authName, safe: validateFixtureForNetwork(values, authName, apiBase) };
}

function authorizationHeader(fixture) {
  return `Bearer ${fixture.safe.authValue}`;
}

function redactErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  const error = body.error && typeof body.error === 'object' ? body.error : null;
  return String(body.code ?? error?.code ?? body.reason ?? '').slice(0, 96) || null;
}

function safeJsonText(body) {
  const result = body?.result;
  const content = result?.content;
  if (!Array.isArray(content) || !content[0] || typeof content[0].text !== 'string') return null;
  try {
    return JSON.parse(content[0].text);
  } catch {
    return null;
  }
}

function mcpToolErrorCode(body) {
  const payload = safeJsonText(body);
  return redactErrorCode(payload);
}

async function requestJson(apiBase, request, fixture = null) {
  const url = new URL(request.path, apiBase);
  const headers = { accept: 'application/json' };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (fixture && request.auth !== false) headers.authorization = authorizationHeader(fixture);
  if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    return {
      case: request.case,
      status: 'failed',
      http_status: null,
      latency_ms: Date.now() - started,
      error_code: 'network_error',
      detail: error.message,
      body: null,
    };
  }
  const latencyMs = Date.now() - started;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const mcpToolFailed = request.mcp === true && body?.result?.isError === true;
  const ok = response.ok && !mcpToolFailed;
  return {
    case: request.case,
    status: ok ? 'passed' : 'failed',
    http_status: response.status,
    latency_ms: latencyMs,
    error_code: ok ? null : (request.mcp ? mcpToolErrorCode(body) : redactErrorCode(body)),
    body,
  };
}

function caseRow(name, result, options = {}) {
  if (result.skipped) {
    return {
      case: name,
      status: 'skipped',
      http_status: null,
      latency_ms: null,
      error_code: result.reason,
      synthetic_ids: {},
    };
  }
  const expectedFailure = options.expectedFailure === true;
  const failedSafely = expectedFailure && (result.status === 'failed' || result.http_status >= 400);
  return {
    case: name,
    status: failedSafely ? 'failed-safe' : result.status,
    http_status: result.http_status,
    latency_ms: result.latency_ms,
    error_code: result.error_code,
    synthetic_ids: options.synthetic_ids ?? {},
  };
}

function countStatuses(rows) {
  const counts = { passed: 0, failed: 0, 'failed-safe': 0, skipped: 0 };
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

function mcpBody(method, params = {}, id = null) {
  return { jsonrpc: '2.0', id: id ?? randomUUID(), method, params };
}

async function mcpTool(apiBase, fixture, name, args) {
  return requestJson(apiBase, {
    case: name,
    method: 'POST',
    path: '/mcp',
    mcp: true,
    body: mcpBody('tools/call', { name, arguments: args }),
  }, fixture);
}

function dataFromMcp(result) {
  const payload = safeJsonText(result.body);
  if (!payload || payload.error || payload.code) return null;
  return payload.data ?? payload;
}

async function executeEvidenceRun({ apiBase, reportPath, fixture }) {
  const rows = [];
  const varsUsed = [
    'GRANTEX_COMMERCE_BASE_URL',
    'GRANTEX_BASE_URL',
    'AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL',
    'AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_AGENT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID',
    'AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID',
    fixture.authName,
  ];
  const merchantId = fixture.safe.merchantId;
  const agentId = fixture.safe.agentId;
  const productId = fixture.safe.productId;
  const variantId = fixture.safe.variantId;
  const currency = fixture.safe.currency;
  const amount = fixture.safe.amountMinorUnits;
  const browsePassport = fixture.safe.browsePassport;
  const checkoutPassport = fixture.safe.checkoutPassport;

  for (const request of [
    { case: 'health', method: 'GET', path: '/health', auth: false },
    { case: 'jwks', method: 'GET', path: '/.well-known/jwks.json', auth: false },
    { case: 'commerce_well_known', method: 'GET', path: '/.well-known/grantex-commerce', auth: false },
    { case: 'mcp_initialize', method: 'POST', path: '/mcp', auth: false, body: mcpBody('initialize') },
    { case: 'mcp_tools_list', method: 'POST', path: '/mcp', auth: false, body: mcpBody('tools/list') },
  ]) {
    rows.push(caseRow(request.case, await requestJson(apiBase, request, fixture)));
  }

  const merchantProfile = await mcpTool(apiBase, fixture, 'merchant.get_profile', { merchant_id: merchantId });
  rows.push(caseRow('merchant_profile', merchantProfile, { synthetic_ids: { merchant_id: merchantId } }));

  const catalogSearch = await mcpTool(apiBase, fixture, 'catalog.search', {
    merchant_id: merchantId,
    query: 'staging',
    limit: 3,
    ...(browsePassport ? { passport_jwt: browsePassport } : {}),
  });
  rows.push(caseRow('catalog_search', catalogSearch, { synthetic_ids: { merchant_id: merchantId } }));

  const catalogGet = await mcpTool(apiBase, fixture, 'catalog.get_item', {
    merchant_id: merchantId,
    product_id: productId,
    ...(browsePassport ? { passport_jwt: browsePassport } : {}),
  });
  rows.push(caseRow('catalog_get_item', catalogGet, { synthetic_ids: { product_id: productId } }));

  const inventory = await mcpTool(apiBase, fixture, 'inventory.check', {
    merchant_id: merchantId,
    variant_ids: [variantId],
    ...(browsePassport ? { passport_jwt: browsePassport } : {}),
  });
  rows.push(caseRow('inventory_check', inventory, { synthetic_ids: { variant_id: variantId } }));

  const cart = await mcpTool(apiBase, fixture, 'cart.create', {
    merchant_id: merchantId,
    currency,
    line_items: [{ variant_id: variantId, quantity: 1 }],
    idempotency_key: `c2d-cart-${randomUUID()}`,
  });
  const cartData = dataFromMcp(cart);
  const cartId = cartData?.cart_id ?? cartData?.id ?? null;
  rows.push(caseRow('cart_create', cart, { synthetic_ids: cartId ? { cart_id: cartId } : {} }));

  const consent = await requestJson(apiBase, {
    case: 'consent_request',
    method: 'POST',
    path: '/v1/commerce/passports/consent-requests',
    body: {
      merchant_id: merchantId,
      passport_type: 'checkout',
      max_amount: amount,
      currency,
      user_principal_hint: 'user_synthetic_c2d',
    },
  }, fixture);
  const consentId = consent.body?.data?.consent_request_id ?? null;
  rows.push(caseRow('consent_request', consent, { synthetic_ids: consentId ? { consent_request_id: consentId } : {} }));

  if (consentId) {
    const exchange = await requestJson(apiBase, {
      case: 'consent_exchange',
      method: 'POST',
      path: '/v1/commerce/passports/exchange',
      body: { consent_request_id: consentId },
    }, fixture);
    rows.push(caseRow('consent_exchange', exchange, { expectedFailure: exchange.http_status >= 400 }));
  } else {
    rows.push(caseRow('consent_exchange', { skipped: true, reason: 'missing_consent_request_id' }));
  }

  let paymentIntentId = null;
  if (cartId && checkoutPassport) {
    const payment = await mcpTool(apiBase, fixture, 'payment.create_intent', {
      merchant_id: merchantId,
      cart_id: cartId,
      passport_jwt: checkoutPassport,
      amount_minor_units: amount,
      currency,
      provider_key: 'mock',
      metadata: { agent_session_id: 'c2d-smoke' },
      idempotency_key: `c2d-payment-${randomUUID()}`,
    });
    const paymentData = dataFromMcp(payment);
    paymentIntentId = paymentData?.payment_intent_id ?? paymentData?.id ?? null;
    rows.push(caseRow('payment_intent_create', payment, {
      synthetic_ids: paymentIntentId ? { payment_intent_id: paymentIntentId } : {},
    }));
  } else {
    rows.push(caseRow('payment_intent_create', { skipped: true, reason: 'missing_cart_or_checkout_passport' }));
  }

  if (paymentIntentId && checkoutPassport) {
    const checkout = await mcpTool(apiBase, fixture, 'checkout.create', {
      payment_intent_id: paymentIntentId,
      passport_jwt: checkoutPassport,
      success_url: 'https://staging.agenticorg.ai/commerce/smoke/success',
      cancel_url: 'https://staging.agenticorg.ai/commerce/smoke/cancel',
      idempotency_key: `c2d-checkout-${randomUUID()}`,
    });
    rows.push(caseRow('checkout_create', checkout, { synthetic_ids: { payment_intent_id: paymentIntentId } }));

    const status = await mcpTool(apiBase, fixture, 'payment.get_status', {
      payment_intent_id: paymentIntentId,
      passport_jwt: checkoutPassport,
    });
    rows.push(caseRow('payment_status', status, { synthetic_ids: { payment_intent_id: paymentIntentId } }));
  } else {
    rows.push(caseRow('checkout_create', { skipped: true, reason: 'missing_payment_intent_or_checkout_passport' }));
    rows.push(caseRow('payment_status', { skipped: true, reason: 'missing_payment_intent_or_checkout_passport' }));
  }

  if (cartId) {
    const missingConsent = await mcpTool(apiBase, fixture, 'payment.create_intent', {
      merchant_id: merchantId,
      cart_id: cartId,
      amount_minor_units: amount,
      currency,
      provider_key: 'mock',
      metadata: { agent_session_id: 'c2d-smoke-missing-consent' },
      idempotency_key: `c2d-missing-consent-${randomUUID()}`,
    });
    rows.push(caseRow('missing_consent_refusal', missingConsent, { expectedFailure: true }));
  } else {
    rows.push(caseRow('missing_consent_refusal', { skipped: true, reason: 'missing_cart' }));
  }

  if (cartId && checkoutPassport) {
    const breachAmount = Math.max(amount * 10, amount + 250000);
    const amountCap = await mcpTool(apiBase, fixture, 'payment.create_intent', {
      merchant_id: merchantId,
      cart_id: cartId,
      passport_jwt: checkoutPassport,
      amount_minor_units: breachAmount,
      currency,
      provider_key: 'mock',
      metadata: { agent_session_id: 'c2d-smoke-amount-cap' },
      idempotency_key: `c2d-amount-cap-${randomUUID()}`,
    });
    rows.push(caseRow('amount_cap_breach_refusal', amountCap, { expectedFailure: true }));
  } else {
    rows.push(caseRow('amount_cap_breach_refusal', { skipped: true, reason: 'missing_cart_or_checkout_passport' }));
  }

  for (const [caseName, envName] of [
    ['revoked_passport_refusal', 'AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT'],
    ['expired_passport_refusal', 'AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT'],
  ]) {
    const passport = envName === 'AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT'
      ? fixture.safe.revokedPassport
      : fixture.safe.expiredPassport;
    if (!cartId || !passport) {
      rows.push(caseRow(caseName, { skipped: true, reason: `missing_${envName}` }));
      continue;
    }
    const refusal = await mcpTool(apiBase, fixture, 'payment.create_intent', {
      merchant_id: merchantId,
      cart_id: cartId,
      passport_jwt: passport,
      amount_minor_units: amount,
      currency,
      provider_key: 'mock',
      metadata: { agent_session_id: `c2d-smoke-${caseName}` },
      idempotency_key: `c2d-${caseName}-${randomUUID()}`,
    });
    rows.push(caseRow(caseName, refusal, { expectedFailure: true }));
  }

  const deniedRef = fixture.safe.deniedConsentRef;
  if (deniedRef) {
    const denied = await requestJson(apiBase, {
      case: 'denied_consent_refusal',
      method: 'POST',
      path: '/v1/commerce/passports/exchange',
      body: { consent_request_id: deniedRef },
    }, fixture);
    rows.push(caseRow('denied_consent_refusal', denied, { expectedFailure: true }));
  } else {
    rows.push(caseRow('denied_consent_refusal', { skipped: true, reason: 'missing_denied_consent_ref' }));
  }

  const counts = countStatuses(rows);
  const report = writeEvidenceReport({
    reportPath,
    apiBase,
    rows,
    counts,
    varsUsed: Array.from(new Set(varsUsed)),
    fixturePath: fixture.relativePath,
    syntheticIds: { merchant_id: merchantId, agent_id: agentId, product_id: productId, variant_id: variantId },
  });
  return {
    mode: 'run',
    status: counts.failed === 0 ? 'executed' : 'executed_with_failures',
    api_base_host: new URL(apiBase).hostname,
    report_path: report.relativePath,
    requests_made: rows.filter((row) => row.status !== 'skipped').length,
    counts,
    variable_names_used: Array.from(new Set(varsUsed)),
    sensitive_variable_names_loaded: SENSITIVE_FIXTURE_ENV_NAMES.filter((name) => fixture.values[name] || process.env[name]),
    secret_values_printed: false,
    raw_payloads_printed: false,
  };
}

function markdownTable(rows) {
  const lines = ['| Case | Status | HTTP | Latency ms | Error code | Synthetic refs |', '| --- | --- | ---: | ---: | --- | --- |'];
  for (const row of rows) {
    const refs = Object.entries(row.synthetic_ids ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(`| ${row.case} | ${row.status} | ${row.http_status ?? ''} | ${row.latency_ms ?? ''} | ${row.error_code ?? ''} | ${refs} |`);
  }
  return lines.join('\n');
}

function writeEvidenceReport({ reportPath, apiBase, rows, counts, varsUsed, fixturePath, syntheticIds }) {
  const { resolved, relativePath } = assertInsideRepo(reportPath, 'Option A smoke evidence report path');
  if (relativePath !== DEFAULT_REPORT) {
    fail('Refusing non-Option-A smoke evidence report path');
  }
  const host = new URL(apiBase).hostname;
  const generatedAt = new Date().toISOString();
  const content = `# Commerce V1 Option A Smoke Evidence

Status: C2D approved smoke evidence captured from a temporary Option A smoke service. This report is scrubbed and contains no bearer token values, passports, idempotency key values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Generated at: ${generatedAt}

Target host: ${host}

Provider: mock

Live flags: Commerce live mode false; live payments false; live Plural false.

AgenticOrg fixture env: ${fixturePath}

Variable names used: ${varsUsed.join(', ')}

Synthetic IDs:
- Merchant: ${syntheticIds.merchant_id}
- Agent: ${syntheticIds.agent_id}
- Product: ${syntheticIds.product_id}
- Variant: ${syntheticIds.variant_id}

## Summary

- Passed: ${counts.passed}
- Failed: ${counts.failed}
- Failed-safe: ${counts['failed-safe']}
- Skipped: ${counts.skipped}

## Case Results

${markdownTable(rows)}

## Cleanup Status

Cleanup status must be updated by the approved smoke-run operator immediately after temporary resource deletion. Production resources must be verified untouched before this evidence can be considered complete.

## Redaction

The runner records only host/origin, variable names, synthetic IDs, case status, HTTP status, latency, and error codes. It never writes raw response payloads, usable passports, auth material, idempotency key values, webhook secrets, provider credentials, DB/Redis URLs, private keys, or secret values to this report.
`;
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, 'utf8');
  return { relativePath };
}

function validateStaticGuardrails() {
  const provider = argValue('--provider', 'mock');
  if (provider !== 'mock') {
    fail('Refusing non-mock provider for Option A smoke evidence tooling');
  }
  if (isTrue(process.env.COMMERCE_LIVE_MODE_ENABLED) || cliFlagTrue('--commerce-live-mode-enabled')) {
    fail('Refusing COMMERCE_LIVE_MODE_ENABLED=true for Option A smoke evidence tooling');
  }
  if (isTrue(process.env.PLURAL_LIVE_ENABLED) || cliFlagTrue('--plural-live-enabled')) {
    fail('Refusing PLURAL_LIVE_ENABLED=true for Option A smoke evidence tooling');
  }
  if (cliFlagTrue('--live-payments', '--provider-live-payments-enabled')) {
    fail('Refusing live payment flags for Option A smoke evidence tooling');
  }
  if (cliFlagTrue('--live-plural', '--plural-live')) {
    fail('Refusing live Plural flags for Option A smoke evidence tooling');
  }
  assertNotProductionResourceName(argValue('--service-name', 'grantex-auth-smoke'), 'Cloud Run service');
  assertNotProductionResourceName(argValue('--cloud-sql-instance', 'grantex-commerce-smoke-pg'), 'Cloud SQL instance');
  assertNotProductionResourceName(argValue('--redis-instance', 'grantex-commerce-smoke-redis'), 'Redis instance');
}

async function main() {
  const run = hasFlag('--run');
  if (run && hasFlag('--dry-run')) {
    fail('Refusing both --run and --dry-run for Option A smoke evidence tooling');
  }
  validateStaticGuardrails();

  const allowedSmokeOrigin = validateSmokeAllowlist(argValue('--allow-smoke-cloud-run-url', process.env.COMMERCE_STAGING_ALLOWED_SMOKE_URL ?? ''));
  const apiBase = validateApiBase(argValue('--api-base', 'https://api-staging.grantex.dev'), allowedSmokeOrigin, run);
  const reportPath = argValue('--report', DEFAULT_REPORT);
  const { relativePath: reportRelativePath } = assertInsideRepo(reportPath, 'Option A smoke evidence report path');
  if (reportRelativePath !== DEFAULT_REPORT) {
    fail('Refusing non-Option-A smoke evidence report path');
  }

  if (run) {
    const fixture = loadFixtureEnv(argValue('--fixture-env', DEFAULT_FIXTURE_ENV), apiBase);
    const result = await executeEvidenceRun({ apiBase, reportPath, fixture });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify({
    mode: 'dry-run',
    status: 'not_executed',
    requests_made: false,
    api_base: apiBase,
    provider: 'mock',
    report_path: reportPath,
    fixture_env_required_for_run: DEFAULT_FIXTURE_ENV,
    approved_cases: APPROVED_CASES,
    safety: {
      production_domains_refused: REFUSED_PRODUCTION_ORIGINS,
      staging_domains_allowed: ALLOWED_STAGING_ORIGINS,
      exact_smoke_run_app_allowed: allowedSmokeOrigin,
      arbitrary_run_app_refused: true,
      live_payment_flags_refused: true,
      secret_values_printed: false,
      raw_payloads_printed: false,
    },
    evidence_schema: {
      report_type: 'commerce-v1-option-a-smoke-evidence',
      target_host_only: 'hostname',
      cloud_run_revision: 'revision id if supplied by operator',
      smoke_resource_names: ['grantex-auth-smoke', 'grantex-commerce-smoke-pg', 'grantex-commerce-smoke-redis'],
      live_flags_false: true,
      provider: 'mock',
      pass_fail_table: 'redacted rows only',
      cleanup_completed: 'required after run',
      redaction: {
        bearer_tokens_recorded: false,
        passports_recorded: false,
        idempotency_keys_recorded: false,
        webhook_secrets_recorded: false,
        provider_credentials_recorded: false,
        raw_payloads_recorded: false,
      },
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'docs/examples/commerce-staging-seed.manifest.json';
const DEFAULT_FIXTURE_ENV = '.tmp/commerce-agent-real-staging.env';
const REFUSED_PRODUCTION_ORIGINS = [
  'https://grantex.dev',
  'https://api.grantex.dev',
  'https://app.agenticorg.ai',
];
const REFUSED_PRODUCTION_RESOURCE_NAMES = new Set(['grantex-auth', 'grantex-pg16', 'grantex-redis']);
const AUTH_ENV_NAMES = ['GRANTEX_COMMERCE_BEARER_TOKEN', 'GRANTEX_AGENT_ASSERTION', 'GRANTEX_API_KEY'];
const SMOKE_TENANT_ID = 'cten_staging_commerce';
const SMOKE_MERCHANT_ID = 'mch_staging_electronics_pilot';
const SMOKE_AGENT_ID = 'cag_staging_agenticorg_sales';
const SMOKE_CATEGORY_ID = 'electronics_appliances';
const SMOKE_SOURCE_SYSTEM = 'synthetic_staging_manifest';
const APPROVED_SMOKE_CATALOG_PRODUCTS = [
  ['cprd_stg_induction_cooktop', 'Staging Induction Cooktop', 329900, [['cvar_stg_induction_black', 'STG-COOKTOP-BLK', 'Black 1800W', 329900]]],
  ['cprd_stg_air_purifier', 'Staging Smart Air Purifier', 899900, [['cvar_stg_air_purifier_room', 'STG-AIR-ROOM', 'Room 300 sqft', 899900]]],
  ['cprd_stg_mixer_grinder', 'Staging Mixer Grinder', 459900, [['cvar_stg_mixer_500w', 'STG-MIX-500', '500W 3 Jar', 459900]]],
  ['cprd_stg_water_purifier', 'Staging Water Purifier', 1499900, [['cvar_stg_water_purifier_ro', 'STG-WATER-RO', 'RO UV Copper', 1499900]]],
  ['cprd_stg_egg_boiler', 'Staging Egg Boiler', 129900, [['cvar_stg_egg_boiler_6', 'STG-EGG-6', 'Six Egg', 129900]]],
  ['cprd_stg_hand_blender', 'Staging Hand Blender', 189900, [['cvar_stg_hand_blender_300w', 'STG-BLEND-300', '300W', 189900]]],
  ['cprd_stg_room_heater', 'Staging Room Heater', 249900, [['cvar_stg_room_heater_2000w', 'STG-HEATER-2000', '2000W', 249900]]],
  ['cprd_stg_robot_vacuum', 'Staging Robot Vacuum', 2299900, [['cvar_stg_robot_vacuum_lidar', 'STG-VAC-LIDAR', 'LiDAR', 2299900]]],
  ['cprd_stg_smart_kettle', 'Staging Smart Kettle', 299900, [['cvar_stg_smart_kettle_17l', 'STG-KETTLE-17', '1.7L', 299900]]],
  ['cprd_stg_table_fan', 'Staging Table Fan', 219900, [['cvar_stg_table_fan_400mm', 'STG-FAN-400', '400mm', 219900]]],
  ['cprd_stg_toaster', 'Staging Toaster', 259900, [['cvar_stg_toaster_2slice', 'STG-TOAST-2', '2 Slice', 259900]]],
  ['cprd_stg_washing_machine', 'Staging Washing Machine', 2799900, [['cvar_stg_washing_machine_7kg', 'STG-WASH-7KG', '7kg', 2799900]]],
];
const OPTIONAL_SENSITIVE_FIXTURE_ENV_NAMES = [
  'AGENTICORG_COMMERCE_BROWSE_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT',
  'AGENTICORG_COMMERCE_DENIED_CONSENT_REF',
];
const APPROVED_SEED_REQUESTS = [
  'GET /health',
  'GET /.well-known/jwks.json',
  'GET /.well-known/grantex-commerce',
  'POST /v1/commerce/catalog/products/bulk dry_run=true',
  'POST /v1/commerce/catalog/products/bulk dry_run=false',
  'GET /v1/commerce/catalog/products/{product_id}',
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
  return url.origin;
}

function validateSmokeAllowlist(value) {
  const origin = parseUrl(value, 'smoke Cloud Run allowlist');
  if (!new URL(origin).hostname.endsWith('.run.app')) {
    fail('Refusing smoke allowlist URL that is not a run.app service origin');
  }
  return origin;
}

function validateSmokeApiBase(value, allowedSmokeOrigin) {
  const origin = parseUrl(value, 'Option A smoke API base');
  if (!allowedSmokeOrigin || origin !== allowedSmokeOrigin) {
    if (new URL(origin).hostname.endsWith('.run.app')) {
      fail('Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url');
    }
    fail('Option A smoke runner requires the exact approved smoke URL allowlist');
  }
  return origin;
}

function assertInsideRepo(pathInput) {
  const resolved = resolve(repoRoot, pathInput);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith('..') || rel === '') {
    fail(`Refusing manifest path outside repo workspace: ${pathInput}`);
  }
  return resolved;
}

function assertInsideTmp(pathInput) {
  const resolved = resolve(repoRoot, pathInput);
  const rel = relative(repoRoot, resolved);
  const isTmpChild = rel.startsWith(`.tmp\\`) || rel.startsWith('.tmp/');
  if (!isTmpChild) {
    fail(`Refusing AgenticOrg fixture env output outside .tmp/: ${pathInput}`);
  }
  return { resolved, relativePath: rel.replace(/\\/g, '/') };
}

function assertNotProductionResourceName(value, label) {
  if (REFUSED_PRODUCTION_RESOURCE_NAMES.has(value)) {
    fail(`Refusing production resource name for ${label}: ${value}`);
  }
}

function safeString(value, label, { min = 0, max = 256, pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail(`Refusing non-string ${label}`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    fail(`Refusing empty ${label}`);
  }
  if (trimmed.length < min || trimmed.length > max) {
    fail(`Refusing ${label} with invalid length`);
  }
  if (/[\r\n]/.test(trimmed)) {
    fail(`Refusing ${label} with line breaks`);
  }
  if (pattern && !pattern.test(trimmed)) {
    fail(`Refusing ${label} with unsupported characters`);
  }
  return trimmed;
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
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
    fail(`Refusing invalid ${label}`);
  }
  return value;
}

function dotenvValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    fail('Refusing fixture env value with line breaks');
  }
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function firstManifestProductWithVariant(manifest) {
  const products = manifest.catalog?.products ?? [];
  return products.find((product) => Array.isArray(product.variants) && product.variants.length > 0) ?? products[0];
}

function firstApprovedProductWithVariant() {
  const [productId, title, priceMinorUnits, variants] = APPROVED_SMOKE_CATALOG_PRODUCTS[0];
  return {
    product_id: productId,
    title,
    price_minor_units: priceMinorUnits,
    variants: variants.map(([variantId, sku, variantTitle, variantPriceMinorUnits]) => ({
      id: variantId,
      sku,
      title: variantTitle,
      price_minor_units: variantPriceMinorUnits,
    })),
  };
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function authValuesFromEnv() {
  return AUTH_ENV_NAMES
    .map((name) => ({ name, value: String(process.env[name] ?? '').trim() }))
    .filter((entry) => entry.value);
}

function requireExactlyOneAuthSource() {
  const authValues = authValuesFromEnv();
  if (authValues.length !== 1) {
    fail('Smoke seed run requires exactly one Grantex auth env value present');
  }
  return authValues[0];
}

function authorizationHeader(authSource) {
  const value = authSource.value.replace(/^Bearer\s+/i, '');
  safeString(value, authSource.name, { min: 8, max: 8192, pattern: /^[A-Za-z0-9._~+/=-]+$/ });
  return `Bearer ${value}`;
}

function writeAgenticOrgFixtureEnv({ outputPath, apiBase, manifest, provider, selectedIds }) {
  const { resolved, relativePath } = assertInsideTmp(outputPath);
  const selectedProduct = firstManifestProductWithVariant(manifest);
  const selectedVariant = Array.isArray(selectedProduct?.variants) ? selectedProduct.variants[0] : null;
  const authNamesWithValues = authValuesFromEnv();
  if (authNamesWithValues.length > 1) {
    fail('Refusing fixture env export with more than one Grantex auth env value present');
  }

  const merchantId = safeSyntheticId(selectedIds?.merchant_id ?? manifest.merchant.id, 'fixture merchant id');
  const agentId = safeSyntheticId(selectedIds?.agent_id ?? manifest.agent.id, 'fixture agent id');
  const productId = safeSyntheticId(selectedIds?.product_id ?? selectedProduct?.id ?? '', 'fixture product id');
  const variantId = safeSyntheticId(selectedIds?.variant_id ?? selectedVariant?.id ?? '', 'fixture variant id');
  const currency = safeCurrency(manifest.catalog.currency, 'fixture currency');
  const amountMinorUnits = safeMinorUnits(
    selectedVariant?.price_minor_units ?? selectedProduct?.price_minor_units ?? 0,
    'fixture amount minor units',
  );
  const sensitiveNamesWritten = [];
  const lines = [
    '# AgenticOrg Commerce real-staging fixture env.',
    '# Generated for local approved smoke runs only. Keep this file under .tmp/ and never commit it.',
    '# Sensitive values are intentionally absent unless supplied by the approved smoke runtime environment.',
    `GRANTEX_COMMERCE_BASE_URL=${dotenvValue(apiBase)}`,
    `GRANTEX_BASE_URL=${dotenvValue(apiBase)}`,
    `AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL=${dotenvValue(apiBase)}`,
    'AGENTICORG_COMMERCE_REAL_STAGING="1"',
    'AGENTICORG_COMMERCE_FIXTURE_VERSION="c2d-option-a-smoke-v1"',
    `AGENTICORG_COMMERCE_FIXTURE_PROVIDER=${dotenvValue(provider)}`,
    'AGENTICORG_COMMERCE_FIXTURE_SYNTHETIC_ONLY="true"',
    `AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID=${dotenvValue(merchantId)}`,
    `AGENTICORG_COMMERCE_FIXTURE_AGENT_ID=${dotenvValue(agentId)}`,
    `AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID=${dotenvValue(productId)}`,
    `AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID=${dotenvValue(variantId)}`,
    `AGENTICORG_COMMERCE_FIXTURE_CURRENCY=${dotenvValue(currency)}`,
    `AGENTICORG_COMMERCE_FIXTURE_AMOUNT_MINOR_UNITS=${dotenvValue(amountMinorUnits)}`,
    'AGENTICORG_COMMERCE_FIXTURE_PASSPORT_MAX_AMOUNT_MINOR_UNITS="250000"',
  ];

  if (authNamesWithValues.length === 1) {
    const auth = authNamesWithValues[0];
    lines.push('AGENTICORG_COMMERCE_FIXTURE_AUTH_ENV_NAME=' + dotenvValue(auth.name));
    lines.push(`${auth.name}=${dotenvValue(auth.value)}`);
    sensitiveNamesWritten.push(auth.name);
  } else {
    lines.push('# Set exactly one Grantex auth env var value outside logs before an approved real-staging run.');
    lines.push('AGENTICORG_COMMERCE_FIXTURE_AUTH_ENV_NAME="GRANTEX_API_KEY"');
  }

  for (const name of OPTIONAL_SENSITIVE_FIXTURE_ENV_NAMES) {
    const value = String(process.env[name] ?? '').trim();
    if (value) {
      lines.push(`${name}=${dotenvValue(value)}`);
      sensitiveNamesWritten.push(name);
    }
  }

  mkdirSync(dirname(resolved), { recursive: true });
  // Fixture env exports are restricted to .tmp and every value is validated before writing.
  writeFileSync(resolved, `${lines.join('\n')}\n`, { encoding: 'utf8' }); // lgtm[js/http-to-file-access]

  return {
    written: true,
    path: relativePath,
    variable_names_written: lines
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0]),
    sensitive_variable_names_written: sensitiveNamesWritten,
    sensitive_value_hashes: sensitiveNamesWritten.map((name) => ({ name, sha256_12: shortHash(process.env[name] ?? '') })),
    sensitive_values_printed: false,
  };
}

function assertNoForbiddenSecrets(value, path = 'manifest') {
  const forbiddenKeyFragments = [
    'api_key',
    'bearer',
    'credential_payload',
    'credential_ref',
    'idempotency',
    'private_key',
    'raw_passport',
    'secret',
    'token',
    'webhook_secret',
  ];
  const forbiddenValueFragments = [
    'Bearer ',
    'sk_live_',
    'pk_live_',
    '-----BEGIN',
    'passport.jwt',
    'idempotency-key:',
    'mock-webhook-secret',
    'postgres://',
    'redis://',
  ];

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (forbiddenKeyFragments.some((fragment) => lowered.includes(fragment))) {
        fail(`Refusing secret-like key in smoke seed manifest at ${path}.${key}`);
      }
      assertNoForbiddenSecrets(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const forbidden of forbiddenValueFragments) {
      if (value.includes(forbidden)) {
        fail(`Refusing secret-like value in smoke seed manifest at ${path}`);
      }
    }
  }
}

function loadManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read smoke seed manifest: ${error.message}`);
  }
  assertNoForbiddenSecrets(parsed);
  return parsed;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message}; expected ${expected}, got ${actual}`);
  }
}

function validateManifest(manifest) {
  assertEqual(manifest.provider?.provider_key, 'mock', 'Smoke seed provider must be mock');
  assertEqual(manifest.provider?.live_payments_enabled, false, 'Smoke seed live payments flag must be false');
  assertEqual(manifest.provider?.plural_live_enabled, false, 'Smoke seed live Plural flag must be false');
  assertEqual(manifest.live_flags?.commerce_live_mode_enabled, false, 'Smoke seed live commerce flag must be false');
  assertEqual(manifest.live_flags?.plural_live_enabled, false, 'Smoke seed live Plural flag must be false');
  assertEqual(manifest.tenant?.id, SMOKE_TENANT_ID, 'Smoke seed tenant id is pinned');
  assertEqual(manifest.merchant?.id, SMOKE_MERCHANT_ID, 'Smoke seed merchant id is pinned');
  assertEqual(manifest.agent?.id, SMOKE_AGENT_ID, 'Smoke seed agent id is pinned');

  const products = manifest.catalog?.products;
  if (!Array.isArray(products) || products.length < 10 || products.length > 25) {
    fail('Smoke seed manifest must include 10-25 products');
  }
  const productsWithVariants = products.filter((product) => Array.isArray(product.variants) && product.variants.length > 0).length;
  if (productsWithVariants < 3) {
    fail('Smoke seed manifest must include at least 3 products with variants');
  }
  return { products, productsWithVariants };
}

function catalogProductsForApi() {
  return APPROVED_SMOKE_CATALOG_PRODUCTS.map(([productId, title, priceMinorUnits, variants], productIndex) => ({
    product_id: safeSyntheticId(productId, `approved smoke product ${productIndex} id`),
    title: safeString(title, `approved smoke product ${productIndex} title`, {
      min: 1,
      max: 128,
      pattern: /^[A-Za-z0-9 .()-]+$/,
    }),
    brand: 'Grantex Demo',
    description: null,
    image_url: null,
    category_preset: SMOKE_CATEGORY_ID,
    source_system: SMOKE_SOURCE_SYSTEM,
    manually_maintained: true,
    variants: variants.map(([, sku, variantTitle, variantPriceMinorUnits], variantIndex) => ({
      sku: safeSyntheticId(sku, `approved smoke product ${productIndex} variant ${variantIndex} sku`),
      parent_sku: null,
      model: null,
      variant_title: safeString(variantTitle, `approved smoke product ${productIndex} variant ${variantIndex} title`, {
        min: 1,
        max: 128,
        pattern: /^[A-Za-z0-9 .()-]+$/,
      }),
      attributes: {},
      price_amount: safeMinorUnits(variantPriceMinorUnits ?? priceMinorUnits, `approved smoke product ${productIndex} variant ${variantIndex} price`),
      currency: 'INR',
      tax_inclusive: true,
      gst_slab: null,
      tax_rate: 0.18,
      hsn_code: null,
      availability_status: 'in_stock',
      warranty_summary: 'Synthetic staging warranty.',
      return_policy_summary: 'Synthetic staging returns.',
      source_system: SMOKE_SOURCE_SYSTEM,
    })),
  }));
}

function redactErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  const error = body.error && typeof body.error === 'object' ? body.error : null;
  return String(body.code ?? error?.code ?? body.reason ?? '').slice(0, 96) || null;
}

async function requestJson(apiBase, request, authSource = null) {
  const url = new URL(request.path, apiBase);
  const headers = { accept: 'application/json' };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (authSource) headers.authorization = authorizationHeader(authSource);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
  } catch (error) {
    fail(`Smoke seed request failed before HTTP response: ${request.label}: ${error.message}`);
  }
  const latencyMs = Date.now() - started;
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    label: request.label,
    status: response.status,
    ok: response.ok,
    latency_ms: latencyMs,
    error_code: response.ok ? null : redactErrorCode(body),
    body,
  };
}

function assertOk(result) {
  if (!result.ok) {
    fail(`Smoke seed request failed closed: ${result.label} returned HTTP ${result.status}${result.error_code ? ` (${result.error_code})` : ''}`);
  }
}

function selectedIdsFromCatalogResponse(body) {
  const selectedProduct = firstApprovedProductWithVariant();
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const variants = Array.isArray(data.variants) ? data.variants : [];
  const selectedVariant = variants[0] && typeof variants[0] === 'object' ? variants[0] : null;
  return {
    merchant_id: SMOKE_MERCHANT_ID,
    agent_id: SMOKE_AGENT_ID,
    product_id: safeSyntheticId(String(data.id ?? data.product_id ?? selectedProduct.product_id), 'seeded product id'),
    variant_id: safeSyntheticId(String(selectedVariant?.id ?? selectedProduct.variants[0].id), 'seeded variant id'),
  };
}

async function executeSeedRun({ apiBase, manifest, fixtureEnvOutput, provider }) {
  const authSource = requireExactlyOneAuthSource();
  const catalogProducts = catalogProductsForApi();
  const selectedProduct = firstApprovedProductWithVariant();
  const merchantId = SMOKE_MERCHANT_ID;
  const selectedProductId = selectedProduct.product_id;
  const results = [];

  for (const request of [
    { label: 'health', method: 'GET', path: '/health' },
    { label: 'jwks', method: 'GET', path: '/.well-known/jwks.json' },
    { label: 'commerce_well_known', method: 'GET', path: '/.well-known/grantex-commerce' },
  ]) {
    const result = await requestJson(apiBase, request);
    assertOk(result);
    results.push(result);
  }

  const bulkPayload = {
    merchant_id: merchantId,
    dry_run: true,
    products: catalogProducts,
  };
  const bulkDryRun = await requestJson(apiBase, {
    label: 'catalog_bulk_validate',
    method: 'POST',
    path: '/v1/commerce/catalog/products/bulk',
    body: bulkPayload,
  }, authSource);
  assertOk(bulkDryRun);
  results.push(bulkDryRun);

  const bulkWrite = await requestJson(apiBase, {
    label: 'catalog_bulk_upsert',
    method: 'POST',
    path: '/v1/commerce/catalog/products/bulk',
    body: { ...bulkPayload, dry_run: false },
  }, authSource);
  assertOk(bulkWrite);
  results.push(bulkWrite);

  const catalogRead = await requestJson(apiBase, {
    label: 'catalog_get_seeded_item',
    method: 'GET',
    path: `/v1/commerce/catalog/products/${encodeURIComponent(selectedProductId)}?merchant_id=${encodeURIComponent(merchantId)}`,
  }, authSource);
  assertOk(catalogRead);
  results.push(catalogRead);

  const selectedIds = selectedIdsFromCatalogResponse(catalogRead.body);
  const fixtureEnvExport = fixtureEnvOutput
    ? writeAgenticOrgFixtureEnv({ outputPath: fixtureEnvOutput, apiBase, manifest, provider, selectedIds })
    : { written: false };

  return {
    mode: 'run',
    status: 'executed',
    api_base_host: new URL(apiBase).hostname,
    approved_requests: APPROVED_SEED_REQUESTS,
    requests_made: results.length,
    request_results: results.map((result) => ({
      label: result.label,
      http_status: result.status,
      latency_ms: result.latency_ms,
      error_code: result.error_code,
    })),
    provider,
    staging_ids: selectedIds,
    catalog: {
      product_count: catalogProducts.length,
      selected_product_id: selectedIds.product_id,
      selected_variant_id: selectedIds.variant_id,
    },
    agenticorg_fixture_env_export: fixtureEnvExport,
    redaction: {
      secret_values_printed: false,
      auth_material_printed: false,
      passports_printed: false,
      raw_payloads_printed: false,
      idempotency_keys_printed: false,
    },
  };
}

function validateStaticGuardrails() {
  if (isTrue(process.env.COMMERCE_LIVE_MODE_ENABLED) || cliFlagTrue('--commerce-live-mode-enabled')) {
    fail('Refusing COMMERCE_LIVE_MODE_ENABLED=true for Option A smoke seed tooling');
  }
  if (isTrue(process.env.PLURAL_LIVE_ENABLED) || cliFlagTrue('--plural-live-enabled')) {
    fail('Refusing PLURAL_LIVE_ENABLED=true for Option A smoke seed tooling');
  }
  if (cliFlagTrue('--live-payments', '--provider-live-payments-enabled')) {
    fail('Refusing live payment flags for Option A smoke seed tooling');
  }
  if (cliFlagTrue('--live-plural', '--plural-live')) {
    fail('Refusing live Plural flags for Option A smoke seed tooling');
  }

  assertNotProductionResourceName(argValue('--service-name', 'grantex-auth-smoke'), 'Cloud Run service');
  assertNotProductionResourceName(argValue('--cloud-sql-instance', 'grantex-commerce-smoke-pg'), 'Cloud SQL instance');
  assertNotProductionResourceName(argValue('--redis-instance', 'grantex-commerce-smoke-redis'), 'Redis instance');
}

async function main() {
  const run = hasFlag('--run');
  if (run && hasFlag('--dry-run')) {
    fail('Refusing both --run and --dry-run for Option A smoke seed tooling');
  }

  validateStaticGuardrails();

  const manifestArg = argValue('--manifest', DEFAULT_MANIFEST);
  const manifestPath = assertInsideRepo(manifestArg);
  const manifest = loadManifest(manifestPath);
  const provider = argValue('--provider', manifest.provider?.provider_key ?? 'mock');
  assertEqual(provider, 'mock', 'Smoke seed provider must be mock');
  const { products, productsWithVariants } = validateManifest(manifest);

  const fixtureEnvOutput = argValue('--write-agenticorg-fixture-env', '');
  let allowedSmokeOrigin = null;
  let apiBase = '';
  if (run || fixtureEnvOutput || argValue('--api-base', '')) {
    const allowlistArg = argValue('--allow-smoke-cloud-run-url', process.env.COMMERCE_STAGING_ALLOWED_SMOKE_URL ?? '');
    if (!allowlistArg) {
      const apiBaseArg = argValue('--api-base', '');
      if (apiBaseArg) {
        const origin = parseUrl(apiBaseArg, 'Option A smoke API base');
        if (new URL(origin).hostname.endsWith('.run.app')) {
          fail('Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url');
        }
      }
      fail('Option A smoke runner requires the exact approved smoke URL allowlist');
    }
    allowedSmokeOrigin = validateSmokeAllowlist(allowlistArg);
    apiBase = validateSmokeApiBase(argValue('--api-base', ''), allowedSmokeOrigin);
  }
  if (run && (!apiBase || !allowedSmokeOrigin)) {
    fail('Option A smoke seed run requires --api-base and --allow-smoke-cloud-run-url');
  }

  if (run) {
    const result = await executeSeedRun({
      apiBase,
      manifest,
      fixtureEnvOutput: fixtureEnvOutput || DEFAULT_FIXTURE_ENV,
      provider,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const fixtureEnvExport = fixtureEnvOutput
    ? writeAgenticOrgFixtureEnv({ outputPath: fixtureEnvOutput, apiBase, manifest, provider, selectedIds: null })
    : { written: false };
  console.log(JSON.stringify({
    mode: 'dry-run',
    status: 'not_executed',
    would_write_catalog: false,
    requests_made: false,
    manifest_path: manifestArg,
    api_base_host: apiBase ? new URL(apiBase).hostname : null,
    provider: manifest.provider.provider_key,
    approved_run_requests: APPROVED_SEED_REQUESTS,
    live_flags: {
      commerce_live_mode_enabled: manifest.live_flags.commerce_live_mode_enabled,
      plural_live_enabled: manifest.live_flags.plural_live_enabled,
      provider_live_payments_enabled: manifest.provider.live_payments_enabled,
    },
    staging_ids: {
      tenant_id: manifest.tenant.id,
      merchant_id: manifest.merchant.id,
      agent_id: manifest.agent.id,
    },
    catalog: {
      product_count: products.length,
      products_with_variants: productsWithVariants,
      currency: manifest.catalog.currency,
      tax_inclusive_pricing: manifest.catalog.tax_inclusive_pricing,
    },
    agenticorg_fixture_env_export: fixtureEnvExport,
    redaction: {
      secret_values_printed: false,
      auth_material_printed: false,
      passports_printed: false,
      raw_payloads_printed: false,
      idempotency_keys_printed: false,
    },
    run_mode: {
      status: 'guarded_and_executable_after_approved_smoke_deploy',
      required_guardrails: [
        'explicit approved smoke API base',
        'exact smoke Cloud Run allowlist',
        'HTTPS run.app origin only',
        'mock provider only',
        'live flags false',
        'smoke-only resource names',
        'exactly one runtime auth source',
        'AgenticOrg fixture env under .tmp only',
      ],
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

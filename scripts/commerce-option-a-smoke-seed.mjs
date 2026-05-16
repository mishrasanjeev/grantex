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

function dotenvValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function firstManifestProductWithVariant(manifest) {
  const products = manifest.catalog?.products ?? [];
  return products.find((product) => Array.isArray(product.variants) && product.variants.length > 0) ?? products[0];
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

  const merchantId = selectedIds?.merchant_id ?? manifest.merchant.id;
  const agentId = selectedIds?.agent_id ?? manifest.agent.id;
  const productId = selectedIds?.product_id ?? selectedProduct?.id ?? '';
  const variantId = selectedIds?.variant_id ?? selectedVariant?.id ?? '';
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
    `AGENTICORG_COMMERCE_FIXTURE_CURRENCY=${dotenvValue(manifest.catalog.currency)}`,
    `AGENTICORG_COMMERCE_FIXTURE_AMOUNT_MINOR_UNITS=${dotenvValue(selectedVariant?.price_minor_units ?? selectedProduct?.price_minor_units ?? 0)}`,
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
  writeFileSync(resolved, `${lines.join('\n')}\n`, { encoding: 'utf8' });

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
  assertEqual(manifest.tenant?.id, 'cten_staging_commerce', 'Smoke seed tenant id is pinned');
  assertEqual(manifest.merchant?.id, 'mch_staging_electronics_pilot', 'Smoke seed merchant id is pinned');
  assertEqual(manifest.agent?.id, 'cag_staging_agenticorg_sales', 'Smoke seed agent id is pinned');

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

function catalogProductsForApi(manifest) {
  return manifest.catalog.products.map((product) => ({
    product_id: product.id,
    title: product.title,
    brand: product.brand ?? null,
    description: product.description ?? null,
    image_url: product.image_url ?? null,
    category_preset: manifest.category.id,
    source_system: product.source_system ?? manifest.catalog.source_system,
    manually_maintained: true,
    variants: (product.variants ?? []).map((variant) => ({
      sku: variant.sku,
      parent_sku: variant.parent_sku ?? null,
      model: variant.model ?? null,
      variant_title: variant.title ?? variant.variant_title ?? null,
      attributes: variant.attributes ?? {},
      price_amount: variant.price_minor_units ?? product.price_minor_units,
      currency: variant.currency ?? product.currency ?? manifest.catalog.currency,
      tax_inclusive: variant.tax_inclusive ?? product.tax_inclusive ?? true,
      gst_slab: variant.gst_slab ?? null,
      tax_rate: variant.gst_rate ?? product.gst_rate ?? manifest.catalog.default_gst_rate,
      hsn_code: variant.hsn_code ?? product.hsn_code ?? null,
      availability_status: variant.availability_status ?? product.availability_status ?? 'unknown',
      warranty_summary: variant.warranty_summary ?? product.warranty_summary ?? null,
      return_policy_summary: variant.return_policy_summary ?? product.return_policy_summary ?? null,
      source_system: variant.source_system ?? product.source_system ?? manifest.catalog.source_system,
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

function selectedIdsFromCatalogResponse(manifest, body) {
  const selectedProduct = firstManifestProductWithVariant(manifest);
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const variants = Array.isArray(data.variants) ? data.variants : [];
  const selectedVariant = variants[0] && typeof variants[0] === 'object' ? variants[0] : null;
  return {
    merchant_id: manifest.merchant.id,
    agent_id: manifest.agent.id,
    product_id: String(data.id ?? data.product_id ?? selectedProduct?.id ?? ''),
    variant_id: String(selectedVariant?.id ?? selectedProduct?.variants?.[0]?.id ?? ''),
  };
}

async function executeSeedRun({ apiBase, manifest, fixtureEnvOutput, provider }) {
  const authSource = requireExactlyOneAuthSource();
  const catalogProducts = catalogProductsForApi(manifest);
  const selectedProduct = firstManifestProductWithVariant(manifest);
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
    merchant_id: manifest.merchant.id,
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
    path: `/v1/commerce/catalog/products/${encodeURIComponent(selectedProduct.id)}?merchant_id=${encodeURIComponent(manifest.merchant.id)}`,
  }, authSource);
  assertOk(catalogRead);
  results.push(catalogRead);

  const selectedIds = selectedIdsFromCatalogResponse(manifest, catalogRead.body);
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
  const dryRun = hasFlag('--dry-run') || !run;
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

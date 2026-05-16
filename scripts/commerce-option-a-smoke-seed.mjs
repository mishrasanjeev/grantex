#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'docs/examples/commerce-staging-seed.manifest.json';
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

function parseUrl(value, label) {
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
  if (!value) return null;
  const origin = parseUrl(value, 'smoke Cloud Run allowlist');
  if (!new URL(origin).hostname.endsWith('.run.app')) {
    fail('Refusing smoke allowlist URL that is not a run.app service origin');
  }
  return origin;
}

function validateFixtureApiBase(value, allowedSmokeOrigin) {
  const origin = parseUrl(value, 'AgenticOrg fixture API base');
  if (!allowedSmokeOrigin || origin !== allowedSmokeOrigin) {
    if (new URL(origin).hostname.endsWith('.run.app')) {
      fail('Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url');
    }
    fail('Fixture env export requires the exact approved Option A smoke URL allowlist');
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

function writeAgenticOrgFixtureEnv({ outputPath, apiBase, manifest, provider }) {
  const { resolved, relativePath } = assertInsideTmp(outputPath);
  const selectedProduct = firstManifestProductWithVariant(manifest);
  const selectedVariant = Array.isArray(selectedProduct?.variants) ? selectedProduct.variants[0] : null;
  const authNamesWithValues = AUTH_ENV_NAMES.filter((name) => String(process.env[name] ?? '').trim());
  if (authNamesWithValues.length > 1) {
    fail('Refusing fixture env export with more than one Grantex auth env value present');
  }

  const sensitiveNamesWritten = [];
  const lines = [
    '# AgenticOrg Commerce real-staging fixture env.',
    '# Generated for local approved smoke runs only. Keep this file under .tmp/ and never commit it.',
    '# Sensitive values are intentionally absent unless supplied by the approved smoke runtime environment.',
    `GRANTEX_COMMERCE_BASE_URL=${dotenvValue(apiBase)}`,
    `GRANTEX_BASE_URL=${dotenvValue(apiBase)}`,
    `AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL=${dotenvValue(apiBase)}`,
    'AGENTICORG_COMMERCE_REAL_STAGING="1"',
    'AGENTICORG_COMMERCE_FIXTURE_VERSION="c2c-option-a-smoke-v1"',
    `AGENTICORG_COMMERCE_FIXTURE_PROVIDER=${dotenvValue(provider)}`,
    'AGENTICORG_COMMERCE_FIXTURE_SYNTHETIC_ONLY="true"',
    `AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID=${dotenvValue(manifest.merchant.id)}`,
    `AGENTICORG_COMMERCE_FIXTURE_AGENT_ID=${dotenvValue(manifest.agent.id)}`,
    `AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID=${dotenvValue(selectedProduct?.id ?? '')}`,
    `AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID=${dotenvValue(selectedVariant?.id ?? '')}`,
    `AGENTICORG_COMMERCE_FIXTURE_CURRENCY=${dotenvValue(manifest.catalog.currency)}`,
    `AGENTICORG_COMMERCE_FIXTURE_AMOUNT_MINOR_UNITS=${dotenvValue(selectedVariant?.price_minor_units ?? selectedProduct?.price_minor_units ?? 0)}`,
    'AGENTICORG_COMMERCE_FIXTURE_PASSPORT_MAX_AMOUNT_MINOR_UNITS="250000"',
  ];

  if (authNamesWithValues.length === 1) {
    const authName = authNamesWithValues[0];
    lines.push(`${authName}=${dotenvValue(process.env[authName])}`);
    sensitiveNamesWritten.push(authName);
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

const run = hasFlag('--run');
if (run) {
  fail('Run mode is blocked for C2A. Implement C2B smoke DB guardrails before any seed writes.');
}
if (isTrue(process.env.COMMERCE_LIVE_MODE_ENABLED)) {
  fail('Refusing COMMERCE_LIVE_MODE_ENABLED=true for Option A smoke seed tooling');
}
if (isTrue(process.env.PLURAL_LIVE_ENABLED)) {
  fail('Refusing PLURAL_LIVE_ENABLED=true for Option A smoke seed tooling');
}

const manifestArg = argValue('--manifest', DEFAULT_MANIFEST);
const manifestPath = assertInsideRepo(manifestArg);
const manifest = loadManifest(manifestPath);
const provider = argValue('--provider', manifest.provider?.provider_key ?? 'mock');
const fixtureEnvOutput = argValue('--write-agenticorg-fixture-env', '');
let fixtureEnvExport = { written: false };

assertNotProductionResourceName(argValue('--service-name', 'grantex-auth-smoke'), 'Cloud Run service');
assertNotProductionResourceName(argValue('--cloud-sql-instance', 'grantex-commerce-smoke-pg'), 'Cloud SQL instance');
assertNotProductionResourceName(argValue('--redis-instance', 'grantex-commerce-smoke-redis'), 'Redis instance');

assertEqual(provider, 'mock', 'Smoke seed provider must be mock');
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

if (fixtureEnvOutput) {
  const allowedSmokeOrigin = validateSmokeAllowlist(
    argValue('--allow-smoke-cloud-run-url', process.env.COMMERCE_STAGING_ALLOWED_SMOKE_URL ?? ''),
  );
  const apiBase = validateFixtureApiBase(argValue('--api-base', ''), allowedSmokeOrigin);
  fixtureEnvExport = writeAgenticOrgFixtureEnv({
    outputPath: fixtureEnvOutput,
    apiBase,
    manifest,
    provider,
  });
}

console.log(JSON.stringify({
  mode: 'dry-run',
  status: 'not_executed',
  would_write: false,
  manifest_path: manifestArg,
  provider: manifest.provider.provider_key,
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
  },
  future_run_mode: {
    status: 'blocked_until_c2b',
    required_guardrails: [
      'explicit smoke DB target',
      'smoke-only secret names',
      'no production database',
      'no generated auth material in tracked files',
      'generated harness env under .tmp only',
    ],
  },
}, null, 2));


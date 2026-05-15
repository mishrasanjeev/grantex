#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'docs/examples/commerce-staging-seed.manifest.json';

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

function assertInsideRepo(pathInput) {
  const resolved = resolve(repoRoot, pathInput);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith('..') || rel === '') {
    fail(`Refusing manifest path outside repo workspace: ${pathInput}`);
  }
  return resolved;
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

const manifestArg = argValue('--manifest', DEFAULT_MANIFEST);
const manifestPath = assertInsideRepo(manifestArg);
const manifest = loadManifest(manifestPath);

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


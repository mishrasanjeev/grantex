import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const datasetPath = join(repoRoot, 'docs', 'examples', 'commerce-c5i-synthetic-internal-merchant.dataset.json');
const guidePath = join(repoRoot, 'docs', 'guides', 'commerce-v1-c5i-synthetic-merchant-dataset.md');
const publicDiscoveryPath = join(repoRoot, 'apps', 'auth-service', 'src', 'lib', 'commerce', 'public-discovery.ts');
const wellKnownPath = join(repoRoot, 'apps', 'auth-service', 'src', 'routes', 'commerce-well-known.ts');

const joinText = (...parts) => parts.join('');

const safeFalseCredentialKeys = new Set([
  'credential_material_included',
  'provider_credentials_included',
]);

const falseOnlyKeys = new Set([
  'agentic_commerce_runtime_allowed',
  'agenticorg_public_discovery_approval',
  'agenticorg_public_discovery_enabled',
  'checkout_creation_allowed',
  'checkout_payment_creation_allowed',
  'checkout_payment_creation_enabled_by_discovery_gate',
  'commerce_public_discovery_allowlist_candidate',
  'commerce_public_discovery_enabled',
  'live_payment_enabled',
  'live_payments_enabled',
  'live_plural_enabled',
  'payment_creation_allowed',
  'plural_live_enabled',
  'production_approval',
  'production_config_value_allowed',
  'production_discovery_approval',
  'public_discovery_allowed',
  'resource_creation_allowed',
]);

const secretKeyFragments = [
  'api_key',
  'bearer',
  'client_secret',
  'credential_payload',
  'credential_ref',
  'password',
  'private_key',
  'secret',
  'token',
  'webhook_secret',
];

const secretValuePatterns = [
  new RegExp(joinText('Bearer', '\\s+[A-Za-z0-9._-]{8,}')),
  new RegExp(joinText('sk', '_live_'), 'i'),
  new RegExp(joinText('pk', '_live_'), 'i'),
  new RegExp(joinText('grtx', '_live_'), 'i'),
  new RegExp(joinText('-----', 'BEGIN'), 'i'),
  new RegExp(joinText('passport', '\\.jwt'), 'i'),
  new RegExp(joinText('idempotency', '-key:'), 'i'),
  new RegExp(joinText('mock', '-webhook', '-secret'), 'i'),
  /postgres:\/\//i,
  /redis:\/\//i,
];

const overclaimPatterns = [
  new RegExp(joinText('approved for ', 'production'), 'i'),
  new RegExp(joinText('certification ', 'complete'), 'i'),
  new RegExp(joinText('certified ', 'merchant'), 'i'),
  new RegExp(joinText('checkout creation ', 'enabled'), 'i'),
  new RegExp(joinText('live payments ', 'enabled'), 'i'),
  new RegExp(joinText('live plural ', 'enabled'), 'i'),
  new RegExp(joinText('payment creation ', 'enabled'), 'i'),
  new RegExp(joinText('production ', 'approved'), 'i'),
  new RegExp(joinText('production ', 'ready'), 'i'),
  new RegExp(joinText('public discovery ', 'enabled'), 'i'),
  new RegExp(joinText('ready for ', 'production'), 'i'),
];

const realisticMerchantNamePatterns = [
  /\bamazon\b/i,
  /\bapple\b/i,
  /\bcroma\b/i,
  /\bflipkart\b/i,
  /\breliance\b/i,
  /\bsamsung\b/i,
  /\btata\b/i,
  /\bvijay sales\b/i,
  /\bpinelabs\b/i,
  /\bplural\b/i,
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function assertSyntheticId(value, path, prefix, errors) {
  if (typeof value !== 'string') {
    fail(errors, path, 'must be a string');
    return;
  }
  if (!value.startsWith(prefix)) {
    fail(errors, path, `must start with ${prefix}`);
  }
  if (!/synth/.test(value) || !/internal/.test(value) || !/smoke/.test(value)) {
    fail(errors, path, 'must include synth, internal, and smoke markers');
  }
  if (/\b(prod|production|live|real|public)\b/i.test(value.replace(/_/g, ' '))) {
    fail(errors, path, 'must not contain production/live/real/public markers');
  }
}

function assertSyntheticName(value, path, errors) {
  if (typeof value !== 'string') {
    fail(errors, path, 'must be a string');
    return;
  }
  const lowered = value.toLowerCase();
  if (!lowered.includes('synthetic') || (!lowered.includes('internal') && !lowered.includes('smoke'))) {
    fail(errors, path, 'must be visibly synthetic/internal/smoke');
  }
  for (const pattern of realisticMerchantNamePatterns) {
    if (pattern.test(value)) {
      fail(errors, path, 'must not use a real or realistic merchant/brand name');
    }
  }
}

function inspectValue(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectValue(item, `${path}[${index}]`, errors));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nestedPath = `${path}.${key}`;
      const lowered = key.toLowerCase();
      if (safeFalseCredentialKeys.has(lowered)) {
        if (nested !== false) fail(errors, nestedPath, 'credential inclusion flags must be false');
      } else if (secretKeyFragments.some((fragment) => lowered.includes(fragment))) {
        fail(errors, nestedPath, 'secret or provider credential keys are not allowed');
      }
      if (falseOnlyKeys.has(lowered) && nested !== false) {
        fail(errors, nestedPath, 'must be false');
      }
      inspectValue(nested, nestedPath, errors);
    }
    return;
  }

  if (typeof value !== 'string') return;
  for (const pattern of secretValuePatterns) {
    if (pattern.test(value)) fail(errors, path, 'contains secret-like material');
  }
  for (const pattern of overclaimPatterns) {
    if (pattern.test(value)) fail(errors, path, 'contains a production/live/readiness overclaim');
  }
}

function validateDataset(dataset) {
  const errors = [];

  assert.equal(dataset.dataset_version, 'c5i-synth-v1');
  assert.equal(dataset.synthetic_only, true);
  assert.equal(dataset.internal_only, true);
  assert.equal(dataset.provider?.provider_key, 'mock');
  assert.equal(dataset.merchant?.certification_claim, 'none');
  assert.equal(dataset.merchant?.readiness_claim, 'none');
  assert.equal(dataset.public_discovery?.certification_claim, 'none');
  assert.equal(dataset.public_discovery?.readiness_claim, 'none');

  assertSyntheticId(dataset.tenant?.id, 'tenant.id', 'cten_synth_internal_smoke_', errors);
  assertSyntheticId(dataset.merchant?.id, 'merchant.id', 'mch_synth_internal_smoke_', errors);
  assertSyntheticId(dataset.merchant?.tenant_id, 'merchant.tenant_id', 'cten_synth_internal_smoke_', errors);
  assertSyntheticId(dataset.agent?.id, 'agent.id', 'cag_synth_internal_smoke_', errors);
  assertSyntheticName(dataset.tenant?.display_name, 'tenant.display_name', errors);
  assertSyntheticName(dataset.merchant?.display_name, 'merchant.display_name', errors);
  assertSyntheticName(dataset.merchant?.public_name, 'merchant.public_name', errors);
  assertSyntheticName(dataset.agent?.display_name, 'agent.display_name', errors);

  const products = dataset.catalog?.products;
  if (!Array.isArray(products) || products.length < 2) {
    fail(errors, 'catalog.products', 'must include at least two synthetic products');
  } else {
    products.forEach((product, productIndex) => {
      assertSyntheticId(product.id, `catalog.products[${productIndex}].id`, 'cprd_synth_internal_smoke_', errors);
      assertSyntheticName(product.title, `catalog.products[${productIndex}].title`, errors);
      assertSyntheticName(product.brand, `catalog.products[${productIndex}].brand`, errors);
      for (const [variantIndex, variant] of (product.variants ?? []).entries()) {
        assertSyntheticId(
          variant.id,
          `catalog.products[${productIndex}].variants[${variantIndex}].id`,
          'cvar_synth_internal_smoke_',
          errors,
        );
        assertSyntheticName(variant.title, `catalog.products[${productIndex}].variants[${variantIndex}].title`, errors);
      }
    });
  }

  inspectValue(dataset, 'dataset', errors);

  if (errors.length > 0) {
    throw new Error(`C5I synthetic dataset validation failed:\n${errors.join('\n')}`);
  }
}

function assertGuideAndGateText() {
  const guide = readFileSync(guidePath, 'utf8');
  const publicDiscovery = readFileSync(publicDiscoveryPath, 'utf8');
  const wellKnown = readFileSync(wellKnownPath, 'utf8');

  for (const required of [
    'does not deploy',
    'does not approve or authorize',
    'Production discovery',
    'COMMERCE_PUBLIC_DISCOVERY_ENABLED',
    'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST',
    'Any production config value',
    'Checkout creation',
    'Payment intent creation',
    'Live payments',
    'Live Plural',
    'AgenticOrg commerce public discovery',
    'Certification and readiness claims remain `none`',
  ]) {
    assert.ok(guide.includes(required), `guide documents ${required}`);
  }

  for (const forbidden of [
    joinText('COMMERCE_PUBLIC_DISCOVERY_ENABLED', '=true'),
    joinText('COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST', '=mch_'),
    joinText('COMMERCE_LIVE_MODE_ENABLED', '=true'),
    joinText('PLURAL_LIVE_ENABLED', '=true'),
    joinText('Bearer', ' '),
    joinText('sk', '_live_'),
    joinText('pk', '_live_'),
    joinText('-----', 'BEGIN'),
  ]) {
    assert.equal(guide.includes(forbidden), false, `guide does not include ${forbidden}`);
  }

  assert.ok(publicDiscovery.includes('return isExplicitSafeTrue'), 'public discovery remains explicit safe true only');
  assert.ok(wellKnown.includes('commerce_public_discovery_allowlist_required'), 'well-known requires allowlist');
  assert.ok(
    wellKnown.includes('checkout_payment_creation_enabled_by_discovery_gate: false'),
    'well-known discovery gate does not enable checkout or payment creation',
  );
  assert.ok(
    wellKnown.includes('commerce_public_discovery_live_flags_forbidden'),
    'well-known discovery gate refuses live flags',
  );
}

function assertRejects(baseDataset, label, mutate) {
  const candidate = clone(baseDataset);
  mutate(candidate);
  assert.throws(
    () => validateDataset(candidate),
    /C5I synthetic dataset validation failed|AssertionError/,
    `rejects ${label}`,
  );
}

const datasetText = readFileSync(datasetPath, 'utf8');
assert.equal(/[^\u0000-\u007F]/.test(datasetText), false, 'dataset stays ASCII-only');
const dataset = JSON.parse(datasetText);

validateDataset(dataset);
assertGuideAndGateText();

assertRejects(dataset, 'production-looking merchant ID', (candidate) => {
  candidate.merchant.id = joinText('mch_pr', 'od', '_ready_merchant_001');
});
assertRejects(dataset, 'realistic merchant name', (candidate) => {
  candidate.merchant.display_name = 'Acme Retail Private Limited';
});
assertRejects(dataset, 'secret-like value', (candidate) => {
  candidate.provider.note = joinText('Bearer', ' fixture-token-value');
});
assertRejects(dataset, 'provider credential key', (candidate) => {
  candidate.provider.credential_payload = { value: 'synthetic' };
});
assertRejects(dataset, 'live payment flag', (candidate) => {
  candidate.provider.live_payments_enabled = true;
});
assertRejects(dataset, 'live payment claim', (candidate) => {
  candidate.purpose = joinText('Synthetic dataset with live payments', ' enabled');
});
assertRejects(dataset, 'certification overclaim', (candidate) => {
  candidate.merchant.certification_claim = joinText('certified', ' merchant');
});
assertRejects(dataset, 'readiness overclaim', (candidate) => {
  candidate.merchant.readiness_claim = joinText('production', ' ready');
});

console.log('commerce C5I synthetic dataset validation passed');

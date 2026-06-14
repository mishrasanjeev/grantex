#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

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

const DEFAULT_API_BASE = 'https://api-staging.grantex.dev';
const DEFAULT_PORTAL_BASE = 'https://staging.grantex.dev';
const DEFAULT_AGENTICORG_BASE = 'https://staging.agenticorg.ai';
const DEFAULT_MANIFEST = 'docs/examples/commerce-staging-seed.manifest.json';
const DEFAULT_REPORT = 'docs/internal/commerce-v1/commerce-v1-hosted-staging-e2e.md';

const POSITIVE_CHECKS = [
  'Grantex health',
  'Grantex JWKS',
  'Grantex commerce well-known',
  'MCP initialize',
  'MCP tools/list',
  'MCP catalog search/get item',
  'MCP inventory check',
  'REST cart create',
  'REST consent request',
  'passport exchange',
  'payment intent create',
  'checkout create',
  'mock webhook paid/failed/expired',
  'duplicate webhook check',
  'manual reconciliation',
  'audit timeline check',
  'portal route smoke',
  'AgenticOrg real-staging demo/eval handoff',
];

const NEGATIVE_CHECKS = [
  'missing consent',
  'denied consent',
  'revoked passport',
  'expired passport',
  'amount cap breach',
  'disabled merchant',
  'untrusted agent',
  'stale inventory',
  'unsupported EMI/discount/warranty claim',
  'invalid webhook signature',
];

const REQUIRED_ENV_VAR_NAMES = [
  'ADMIN_API_KEY',
  'MOCK_PAYMENT_WEBHOOK_SECRET',
  'METRICS_API_KEY',
  'GRANTEX_COMMERCE_BASE_URL',
  'GRANTEX_BASE_URL',
  'AGENTICORG_BASE_URL',
];

const REQUIRED_ONE_OF_ENV_VAR_NAMES = [
  ['GRANTEX_COMMERCE_BEARER_TOKEN', 'GRANTEX_AGENT_ASSERTION', 'GRANTEX_API_KEY'],
];

function argValue(name, fallback) {
  const prefix = `${name}=`;
  for (let index = 0; index < process.argv.length; index += 1) {
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

function boolArg(name) {
  return process.argv.includes(name);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isTrue(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function isLocalhost(url) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

function parseUrl(input, label) {
  let url;
  try {
    url = new URL(input);
  } catch {
    fail(`Refusing invalid ${label}: ${input}`);
  }
  return url;
}

function validateUrl(input, label, dryRun, allowLocalhost, allowedSmokeOrigin) {
  const url = parseUrl(input, label);
  if (url.username || url.password) {
    fail(`Refusing credentialed URL for ${label}`);
  }

  for (const key of url.searchParams.keys()) {
    const lowered = key.toLowerCase();
    if (['token', 'secret', 'key', 'passport', 'bearer', 'credential'].some((fragment) => lowered.includes(fragment))) {
      fail(`Refusing credential material in ${label} query string`);
    }
  }

  if (REFUSED_PRODUCTION_ORIGINS.includes(url.origin)) {
    fail(`Refusing production domain for ${label}: ${url.origin}`);
  }

  if (isLocalhost(url)) {
    if (!dryRun || !allowLocalhost) {
      fail(`Refusing localhost ${label} unless --allow-localhost is used for local dry-run comparison`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      fail(`Refusing unsupported localhost protocol for ${label}`);
    }
    return url.origin;
  }

  if (url.protocol !== 'https:') {
    fail(`Refusing non-HTTPS staging URL for ${label}`);
  }

  if (allowedSmokeOrigin && url.origin === allowedSmokeOrigin) {
    return url.origin;
  }

  if (!ALLOWED_STAGING_ORIGINS.includes(url.origin)) {
    fail(`Refusing non-staging ${label}: ${url.origin}`);
  }

  return url.origin;
}

function validateSmokeCloudRunUrl(input) {
  if (!input) return null;
  const url = parseUrl(input, 'smoke Cloud Run URL');
  if (url.username || url.password) {
    fail('Refusing credentialed URL for smoke Cloud Run allowlist');
  }
  if (url.search) {
    fail('Refusing query string in smoke Cloud Run allowlist URL');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    fail('Refusing path in smoke Cloud Run allowlist URL; provide the service origin only');
  }
  if (REFUSED_PRODUCTION_ORIGINS.includes(url.origin)) {
    fail(`Refusing production domain for smoke Cloud Run allowlist: ${url.origin}`);
  }
  if (url.protocol !== 'https:') {
    fail('Refusing non-HTTPS smoke Cloud Run allowlist URL');
  }
  if (!url.hostname.endsWith('.run.app')) {
    fail('Refusing smoke Cloud Run allowlist URL that is not a run.app service origin');
  }
  return url.origin;
}

function loadManifest(pathInput) {
  const manifestPath = resolve(repoRoot, pathInput);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Unable to read staging manifest at ${pathInput}: ${error.message}`);
  }

  assertNoForbiddenManifestSecrets(parsed);

  if (parsed.provider?.provider_key !== 'mock') {
    fail('Refusing non-mock provider in default staging manifest; run Plural sandbox through a dedicated credentialed validation harness');
  }
  if (parsed.provider?.live_payments_enabled !== false || parsed.provider?.plural_live_enabled !== false) {
    fail('Refusing staging manifest with live provider flags');
  }
  if (
    parsed.live_flags?.commerce_live_mode_enabled !== false
    || parsed.live_flags?.plural_live_enabled !== false
  ) {
    fail('Refusing staging manifest with live commerce or live Plural flags');
  }

  const products = parsed.catalog?.products;
  if (!Array.isArray(products) || products.length < 10 || products.length > 25) {
    fail('Refusing staging manifest without 10-25 synthetic products');
  }
  if (products.filter((product) => Array.isArray(product.variants) && product.variants.length > 0).length < 3) {
    fail('Refusing staging manifest without at least 3 products with variants');
  }

  return {
    tenant_id: parsed.tenant?.id,
    merchant_id: parsed.merchant?.id,
    agent_id: parsed.agent?.id,
    category_id: parsed.category?.id,
    provider: parsed.provider?.provider_key,
    product_count: products.length,
    products_with_variants: products.filter((product) => Array.isArray(product.variants) && product.variants.length > 0).length,
  };
}

function assertNoForbiddenManifestSecrets(value, path = 'manifest') {
  const forbiddenKeyFragments = [
    'api_key',
    'bearer',
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
  ];

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenManifestSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      if (forbiddenKeyFragments.some((fragment) => lowered.includes(fragment))) {
        fail(`Refusing forbidden secret-like key in staging manifest at ${path}.${key}`);
      }
      assertNoForbiddenManifestSecrets(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const forbidden of forbiddenValueFragments) {
      if (value.includes(forbidden)) {
        fail(`Refusing forbidden secret-like value in staging manifest at ${path}`);
      }
    }
  }
}

const run = boolArg('--run');
const dryRun = boolArg('--dry-run') || !run;
const allowLocalhost = boolArg('--allow-localhost');
const provider = argValue('--provider', 'mock');
const apiBase = argValue('--api-base', DEFAULT_API_BASE);
const portalBase = argValue('--portal-base', DEFAULT_PORTAL_BASE);
const agenticorgBase = argValue('--agenticorg-base', DEFAULT_AGENTICORG_BASE);
const manifestPath = argValue('--manifest', DEFAULT_MANIFEST);
const reportPath = argValue('--report', DEFAULT_REPORT);
const allowedSmokeOrigin = validateSmokeCloudRunUrl(
  argValue('--allow-smoke-cloud-run-url', process.env.COMMERCE_STAGING_ALLOWED_SMOKE_URL ?? ''),
);

if (provider !== 'mock') {
  fail('Refusing non-mock provider in default staging harness; run Plural sandbox through a dedicated credentialed validation harness');
}
if (isTrue(process.env.COMMERCE_LIVE_MODE_ENABLED)) {
  fail('Refusing COMMERCE_LIVE_MODE_ENABLED=true for hosted staging E2E harness');
}
if (isTrue(process.env.PLURAL_LIVE_ENABLED)) {
  fail('Refusing PLURAL_LIVE_ENABLED=true for hosted staging E2E harness');
}
if (reportPath.includes('.tmp') || !reportPath.includes('hosted-staging-e2e')) {
  fail('Refusing non-staging or local-only report path');
}

const normalizedApiBase = validateUrl(apiBase, 'Grantex API base', dryRun, allowLocalhost, allowedSmokeOrigin);
const normalizedPortalBase = validateUrl(portalBase, 'Grantex portal base', dryRun, allowLocalhost, allowedSmokeOrigin);
const normalizedAgenticOrgBase = validateUrl(agenticorgBase, 'AgenticOrg base', dryRun, allowLocalhost, allowedSmokeOrigin);
const manifestSummary = loadManifest(manifestPath);

const output = {
  mode: dryRun ? 'dry-run' : 'run',
  status: 'not_executed',
  safety: {
    no_requests_made: true,
    production_domains_refused: REFUSED_PRODUCTION_ORIGINS,
    staging_domains_allowed: ALLOWED_STAGING_ORIGINS,
    smoke_cloud_run_origin_allowed: allowedSmokeOrigin,
    non_mock_provider_refused: true,
    live_payment_flags_refused: true,
    secret_values_printed: false,
  },
  targets: {
    api_base: normalizedApiBase,
    portal_base: normalizedPortalBase,
    agenticorg_base: normalizedAgenticOrgBase,
  },
  manifest: manifestSummary,
  report_path: reportPath,
  required_env_var_names: REQUIRED_ENV_VAR_NAMES,
  required_one_of_env_var_names: REQUIRED_ONE_OF_ENV_VAR_NAMES,
  positive_checks: POSITIVE_CHECKS,
  negative_checks: NEGATIVE_CHECKS,
  evidence_schema: {
    report_type: 'commerce-v1-hosted-staging-e2e',
    generated_at: 'ISO-8601 timestamp',
    checks: 'array of redacted check results',
    negative_checks: 'array of redacted refusal results',
    redaction: {
      secret_values_recorded: false,
      bearer_tokens_recorded: false,
      passports_recorded: false,
      provider_credentials_recorded: false,
    },
  },
};

if (run) {
  const missingNames = REQUIRED_ENV_VAR_NAMES.filter((name) => !process.env[name]);
  const missingOneOf = REQUIRED_ONE_OF_ENV_VAR_NAMES.filter((group) => !group.some((name) => process.env[name]));
  const missingText = [
    ...missingNames,
    ...missingOneOf.map((group) => `one of ${group.join(', ')}`),
  ];
  if (missingText.length > 0) {
    fail(`Run mode is disabled for M11 dry-run-only harness and missing staging env names: ${missingText.join('; ')}. No requests were made.`);
  }
  fail('Run mode is intentionally disabled for M11 dry-run-only harness. No requests were made.');
}

console.log(JSON.stringify(output, null, 2));

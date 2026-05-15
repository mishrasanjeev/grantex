#!/usr/bin/env node

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

const DEFAULT_REPORT = 'docs/reports/commerce-v1-option-a-smoke-evidence.md';

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
  return url;
}

function validateSmokeAllowlist(value) {
  if (!value) return null;
  const url = parseUrl(value, 'smoke Cloud Run allowlist');
  if (url.search || (url.pathname !== '/' && url.pathname !== '')) {
    fail('Refusing path or query in smoke Cloud Run allowlist; provide the origin only');
  }
  if (!url.hostname.endsWith('.run.app')) {
    fail('Refusing smoke allowlist URL that is not a run.app origin');
  }
  return url.origin;
}

function validateApiBase(value, allowedSmokeOrigin) {
  const url = parseUrl(value, 'Option A smoke API base');
  if (allowedSmokeOrigin && url.origin === allowedSmokeOrigin) {
    return url.origin;
  }
  if (url.hostname.endsWith('.run.app')) {
    fail('Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url');
  }
  if (!ALLOWED_STAGING_ORIGINS.includes(url.origin)) {
    fail(`Refusing non-staging API base: ${url.origin}`);
  }
  return url.origin;
}

const run = hasFlag('--run');
const provider = argValue('--provider', 'mock');
if (provider !== 'mock') {
  fail('Refusing non-mock provider for Option A smoke evidence tooling');
}
if (isTrue(process.env.COMMERCE_LIVE_MODE_ENABLED)) {
  fail('Refusing COMMERCE_LIVE_MODE_ENABLED=true for Option A smoke evidence tooling');
}
if (isTrue(process.env.PLURAL_LIVE_ENABLED)) {
  fail('Refusing PLURAL_LIVE_ENABLED=true for Option A smoke evidence tooling');
}
if (run) {
  fail('Run mode is blocked for C2A. Implement C2B request execution before collecting new evidence.');
}

const allowedSmokeOrigin = validateSmokeAllowlist(argValue('--allow-smoke-cloud-run-url', process.env.COMMERCE_STAGING_ALLOWED_SMOKE_URL ?? ''));
const apiBase = validateApiBase(argValue('--api-base', 'https://api-staging.grantex.dev'), allowedSmokeOrigin);
const reportPath = argValue('--report', DEFAULT_REPORT);
if (!reportPath.includes('commerce-v1-option-a-smoke-evidence.md')) {
  fail('Refusing non-Option-A smoke evidence report path');
}

console.log(JSON.stringify({
  mode: 'dry-run',
  status: 'not_executed',
  requests_made: false,
  api_base: apiBase,
  provider,
  report_path: reportPath,
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
    cloud_run_revision: 'revision id if available',
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


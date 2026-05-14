import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(docsDir, '..');
const guide = readFileSync(join(docsDir, 'guides', 'commerce-v1-operations.mdx'), 'utf8');
const openapi = readFileSync(join(docsDir, 'api', 'grantex-commerce-v1.openapi.yaml'), 'utf8');
const template = readFileSync(join(docsDir, 'examples', 'commerce-pilot-merchant.sandbox.json'), 'utf8');
const loadReport = readFileSync(join(docsDir, 'reports', 'commerce-v1-local-pilot-load.md'), 'utf8');
const hostedStagingPlan = readFileSync(join(docsDir, 'guides', 'commerce-v1-hosted-staging-plan.md'), 'utf8');
const harness = readFileSync(join(repoRoot, 'scripts', 'commerce-pilot-load-harness.mjs'), 'utf8');
const seed = readFileSync(join(repoRoot, 'scripts', 'commerce-pilot-seed-local.mjs'), 'utf8');

for (const required of [
  'Pilot SLA And Readiness Dashboard',
  'Payment intent create',
  'Catalog search',
  'Provider webhooks',
  'Pilot Merchant Configuration Path',
  'Support Ownership Placeholder',
  'On-Call Escalation Template',
  'Backup Restore And RPO Notes',
  'Final V1 Sign-Off Checklist',
  'Not-Ready-If Checklist',
  'M7C internal-sandbox signoff status',
  'COMMERCE_LOAD_CART_IDS',
  'COMMERCE_LOAD_PROVIDER_PAYMENT_IDS',
  'Local sandbox seed command',
  'commerce-pilot-seed-local.mjs',
  'docker compose up --build',
]) {
  assert.ok(guide.includes(required), `operations guide includes ${required}`);
}

assert.ok(openapi.includes('/v1/commerce/ops/provider-webhook-events:'), 'OpenAPI documents provider webhook event listing');
assert.ok(openapi.includes('x-milestone: M7A'), 'OpenAPI marks M7A implemented endpoint');
assert.ok(openapi.includes('Replay remains blocked'), 'OpenAPI keeps replay blocked');

for (const required of [
  'grantex-auth-staging',
  'grantex-portal-staging',
  'api-staging.grantex.dev',
  'staging.grantex.dev',
  'Dedicated staging Cloud SQL Postgres',
  'Dedicated staging Redis',
  'No production DB or Redis',
  'COMMERCE_V1_ENABLED=true',
  'COMMERCE_SANDBOX_ENABLED=true',
  'COMMERCE_LIVE_MODE_ENABLED=false',
  'PLURAL_SANDBOX_ENABLED=false',
  'PLURAL_LIVE_ENABLED=false',
  'METRICS_REQUIRE_AUTH=true',
  'DATABASE_URL',
  'REDIS_URL',
  'MOCK_PAYMENT_WEBHOOK_SECRET',
  'Commerce Passport signing key material',
  'workflow_dispatch',
  'authorized -> checkout_created -> payment_pending',
  'invalid webhook signature',
  'No deploy was performed',
]) {
  assert.ok(hostedStagingPlan.includes(required), `hosted staging plan includes ${required}`);
}

for (const forbidden of [
  'COMMERCE_LIVE_MODE_ENABLED=true',
  'PLURAL_LIVE_ENABLED=true',
  'sk_live_',
  'pk_live_',
  'Bearer ',
]) {
  assert.equal(hostedStagingPlan.includes(forbidden), false, `hosted staging plan does not include ${forbidden}`);
}

const parsedTemplate = JSON.parse(template);
assert.equal(parsedTemplate.environment, 'sandbox', 'pilot template is sandbox only');
assert.equal(parsedTemplate.provider.plural_live_enabled, false, 'pilot template does not enable live Plural');
assert.equal(parsedTemplate.provider.provider_key, 'mock', 'pilot template uses mock provider');

assert.ok(harness.includes('Refusing to run commerce pilot load harness against a non-local API base URL'));
assert.ok(harness.includes('/v1/commerce/payments/intents'));
assert.ok(harness.includes('/v1/commerce/catalog/search'));
assert.ok(harness.includes('/v1/webhooks/providers/mock'));
assert.ok(harness.includes('duplicate_payment_transition_count'));
assert.ok(harness.includes('COMMERCE_LOAD_CART_IDS'));
assert.ok(harness.includes('COMMERCE_LOAD_PROVIDER_PAYMENT_IDS'));
assert.ok(harness.includes('--env-file'));
assert.ok(seed.includes('Refusing to seed commerce pilot data against a non-local or production-like DATABASE_URL'));
assert.ok(seed.includes('COMMERCE_LIVE_MODE_ENABLED'));
assert.ok(seed.includes('PLURAL_LIVE_ENABLED'));
assert.ok(seed.includes('pending_provider_payment_count'));
assert.ok(seed.includes('commerce-pilot-load.env'));

const dryRun = execFileSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'commerce-pilot-load-harness.mjs'), '--dry-run'],
  { encoding: 'utf8' },
);
const report = JSON.parse(dryRun);
assert.equal(report.mode, 'dry-run');
assert.equal(report.local_only, true);
assert.equal(report.status, 'not_executed');
assert.equal(report.targets.length, 3);
assert.equal(report.result_schema.request_count, 'number');
assert.equal(report.result_schema.p50_ms, 'number|null');
assert.equal(report.result_schema.p95_ms, 'number|null');

const seedDryRun = execFileSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'commerce-pilot-seed-local.mjs'), '--dry-run'],
  { encoding: 'utf8' },
);
const seedReport = JSON.parse(seedDryRun);
assert.equal(seedReport.mode, 'dry-run');
assert.equal(seedReport.local_only, true);
assert.equal(seedReport.database_url_allowed, true);
assert.equal(seedReport.would_seed.cart_count, 100);
assert.equal(seedReport.would_seed.pending_provider_payment_count, 51);

const nonLocalSeed = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-pilot-seed-local.mjs'),
    '--run',
    '--database-url=postgres://grantex:grantex@prod-db.grantex.dev:5432/grantex',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(nonLocalSeed.status, 0, 'non-local seed run is refused');
assert.ok(
  `${nonLocalSeed.stdout}${nonLocalSeed.stderr}`.includes('Refusing to seed commerce pilot data against a non-local or production-like DATABASE_URL'),
  'non-local seed refusal explains the database safety guard',
);

const nonLocalRun = spawnSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'commerce-pilot-load-harness.mjs'), '--run', '--api-base=https://grantex.dev'],
  { encoding: 'utf8' },
);
assert.notEqual(nonLocalRun.status, 0, 'non-local measured run is refused');
assert.ok(
  `${nonLocalRun.stdout}${nonLocalRun.stderr}`.includes('Refusing to run commerce pilot load harness against a non-local API base URL'),
  'non-local refusal explains the safety guard',
);

const missingInputRun = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-pilot-load-harness.mjs'),
    '--run',
    '--api-base=http://localhost:3001',
    '--targets=catalog_search',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(missingInputRun.status, 0, 'local measured run without seeded inputs is refused');
assert.ok(
  `${missingInputRun.stdout}${missingInputRun.stderr}`.includes('Missing local load harness inputs'),
  'missing input refusal explains local setup requirements',
);

assert.ok(
  loadReport.includes('Status: not measured in this environment.')
    || loadReport.includes('Overall status:'),
  'load report includes placeholder or measured status',
);

for (const required of [
  'Required Local Setup',
  'commerce-pilot-seed-local.mjs',
  'Payment intent create',
  'Catalog search',
  'Mock provider webhooks',
  'Duplicate webhook transition count',
  'Human review of the generated report',
]) {
  assert.ok(loadReport.includes(required), `load report includes ${required}`);
}

assert.equal(/[^\u0000-\u007F]/.test(guide), false, 'operations guide stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(template), false, 'pilot template stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(loadReport), false, 'pilot load report stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(hostedStagingPlan), false, 'hosted staging plan stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(harness), false, 'load harness stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(seed), false, 'local seed script stays ASCII-only');

console.log('commerce-v1 pilot readiness validation passed');

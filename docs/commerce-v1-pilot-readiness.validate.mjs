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
const stagingSeedManifestText = readFileSync(join(docsDir, 'examples', 'commerce-staging-seed.manifest.json'), 'utf8');
const loadReport = readFileSync(join(docsDir, 'reports', 'commerce-v1-local-pilot-load.md'), 'utf8');
const hostedStagingPlan = readFileSync(join(docsDir, 'guides', 'commerce-v1-hosted-staging-plan.md'), 'utf8');
const stagingDataSetup = readFileSync(join(docsDir, 'guides', 'commerce-v1-staging-data-setup.md'), 'utf8');
const hostedStagingE2E = readFileSync(join(docsDir, 'guides', 'commerce-v1-hosted-staging-e2e.md'), 'utf8');
const optionASmokeSetup = readFileSync(join(docsDir, 'guides', 'commerce-v1-option-a-smoke-setup.md'), 'utf8');
const repeatableOptionASmokeWorkflow = readFileSync(
  join(docsDir, 'guides', 'commerce-v1-repeatable-option-a-smoke-workflow.md'),
  'utf8',
);
const hostedStagingE2ETemplate = readFileSync(join(docsDir, 'reports', 'commerce-v1-hosted-staging-e2e.template.md'), 'utf8');
const optionASmokeEvidence = readFileSync(join(docsDir, 'reports', 'commerce-v1-option-a-smoke-evidence.md'), 'utf8');
const contractGapReport = readFileSync(join(docsDir, 'reports', 'commerce-v1-contract-completeness-gap-report.md'), 'utf8');
const readOnlyDiscoveryProposal = readFileSync(
  join(docsDir, 'reports', 'commerce-v1-read-only-production-discovery-proposal.md'),
  'utf8',
);
const optionASmokeRunbookText = readFileSync(join(docsDir, 'examples', 'commerce-option-a-smoke.runbook.json'), 'utf8');
const harness = readFileSync(join(repoRoot, 'scripts', 'commerce-pilot-load-harness.mjs'), 'utf8');
const stagingE2EHarness = readFileSync(join(repoRoot, 'scripts', 'commerce-staging-e2e-harness.mjs'), 'utf8');
const optionASmokePlan = readFileSync(join(repoRoot, 'scripts', 'commerce-option-a-smoke-plan.mjs'), 'utf8');
const optionASmokeSeed = readFileSync(join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'), 'utf8');
const optionASmokeEvidenceTool = readFileSync(join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'), 'utf8');
const seed = readFileSync(join(repoRoot, 'scripts', 'commerce-pilot-seed-local.mjs'), 'utf8');

const joinText = (...parts) => parts.join('');
const commonSecretMarkers = [
  joinText('sk', '_live_'),
  joinText('pk', '_live_'),
  joinText('Bearer', ' '),
  joinText('passport', '.jwt'),
  joinText('idempotency', '-key:'),
  joinText('mock', '-webhook', '-secret'),
];
const evidenceSecretMarkers = [
  ...commonSecretMarkers,
  joinText('postgres', '://'),
  joinText('redis', '://'),
  joinText('idempotency', '_key'),
  joinText('webhook', '_secret'),
  joinText('encrypted', '_payload'),
  joinText('raw', '_payload'),
  joinText('safe', '_headers_json'),
  joinText('provider', '_credentials'),
  joinText('-----', 'BEGIN'),
];
const fixtureEnvSecretMarkers = [
  ...commonSecretMarkers,
  joinText('postgres', '://'),
  joinText('redis', '://'),
  joinText('-----', 'BEGIN'),
];

function extractFalseImplementedRoutes(openapiText) {
  const routes = [];
  let currentPath = null;
  let currentMethod = null;
  for (const line of openapiText.split(/\r?\n/)) {
    const pathMatch = line.match(/^ {2}(\/[^:]+):/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentMethod = null;
      continue;
    }
    const methodMatch = line.match(/^ {4}(get|post|patch|delete):/);
    if (methodMatch) {
      currentMethod = methodMatch[1].toUpperCase();
    }
    if (currentPath && currentMethod && line.includes('x-implemented: false')) {
      routes.push(`${currentMethod} ${currentPath}`);
    }
  }
  return routes.sort();
}

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

for (const required of [
  'COMMERCE_PUBLIC_DISCOVERY_ENABLED',
  'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST',
  'controls only',
  'GET /.well-known/grantex-commerce',
  'does not enable `/mcp`',
  'does not enable `/mcp`, MCP',
  'No allowlist must fail closed',
  'A requested merchant outside the allowlist must fail closed',
  'read-only metadata only',
  'checkout/payment creation is not enabled by the gate',
  'live payments are',
  'disabled, live Plural is disabled',
  'live Plural is disabled',
  'no readiness or certification claim',
  'AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED',
]) {
  assert.ok(readOnlyDiscoveryProposal.includes(required), `read-only discovery proposal includes ${required}`);
}
for (const forbidden of [
  'COMMERCE_PUBLIC_DISCOVERY_ENABLED=true',
  'COMMERCE_V1_ENABLED=true',
  'COMMERCE_LIVE_MODE_ENABLED=true',
  'PLURAL_LIVE_ENABLED=true',
  joinText('sk', '_live_'),
  joinText('pk', '_live_'),
  joinText('Bearer', ' '),
]) {
  assert.equal(
    readOnlyDiscoveryProposal.includes(forbidden),
    false,
    `read-only discovery proposal does not include ${forbidden}`,
  );
}

assert.ok(openapi.includes('/v1/commerce/ops/provider-webhook-events:'), 'OpenAPI documents provider webhook event listing');
assert.ok(openapi.includes('x-milestone: M7A'), 'OpenAPI marks M7A implemented endpoint');
assert.ok(openapi.includes('/v1/commerce/ops/provider-webhook-events/{event_id}/replay'), 'OpenAPI documents provider webhook replay');
assert.ok(openapi.includes('/v1/commerce/merchants/{merchant_id}/enable-agentic-commerce'), 'OpenAPI documents emergency re-enable');

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
  joinText('sk', '_live_'),
  joinText('pk', '_live_'),
  joinText('Bearer', ' '),
]) {
  assert.equal(hostedStagingPlan.includes(forbidden), false, `hosted staging plan does not include ${forbidden}`);
}

const parsedTemplate = JSON.parse(template);
assert.equal(parsedTemplate.environment, 'sandbox', 'pilot template is sandbox only');
assert.equal(parsedTemplate.provider.plural_live_enabled, false, 'pilot template does not enable live Plural');
assert.equal(parsedTemplate.provider.provider_key, 'mock', 'pilot template uses mock provider');

const stagingManifest = JSON.parse(stagingSeedManifestText);
assert.equal(stagingManifest.tenant.id, 'cten_staging_commerce', 'staging seed tenant id is pinned');
assert.equal(stagingManifest.merchant.id, 'mch_staging_electronics_pilot', 'staging seed merchant id is pinned');
assert.equal(stagingManifest.agent.id, 'cag_staging_agenticorg_sales', 'staging seed agent id is pinned');
assert.equal(stagingManifest.category.id, 'electronics_appliances', 'staging seed category is pinned');
assert.equal(stagingManifest.provider.provider_key, 'mock', 'staging seed uses mock provider');
assert.equal(stagingManifest.provider.live_payments_enabled, false, 'staging seed does not enable live payments');
assert.equal(stagingManifest.provider.plural_live_enabled, false, 'staging seed does not enable live Plural');
assert.equal(stagingManifest.live_flags.commerce_live_mode_enabled, false, 'staging seed live commerce flag is false');
assert.equal(stagingManifest.live_flags.plural_live_enabled, false, 'staging seed live Plural flag is false');
assert.equal(stagingManifest.policy.status, 'active', 'staging seed has an active policy');
assert.equal(stagingManifest.catalog.currency, 'INR', 'staging seed catalog uses INR');
assert.equal(stagingManifest.catalog.tax_inclusive_pricing, true, 'staging seed catalog is tax-inclusive');
assert.ok(stagingManifest.catalog.default_gst_rate > 0, 'staging seed catalog has GST rate');

const products = stagingManifest.catalog.products;
assert.ok(Array.isArray(products), 'staging seed products are present');
assert.ok(products.length >= 10 && products.length <= 25, 'staging seed product count is 10-25');
assert.ok(
  products.filter((product) => Array.isArray(product.variants) && product.variants.length > 0).length >= 3,
  'staging seed includes at least 3 products with variants',
);
for (const product of products) {
  assert.equal(product.category, 'electronics_appliances', `product ${product.id} uses electronics category`);
  assert.equal(product.currency, 'INR', `product ${product.id} uses INR`);
  assert.equal(product.tax_inclusive, true, `product ${product.id} is tax-inclusive`);
  assert.ok(Number.isInteger(product.price_minor_units), `product ${product.id} has minor-unit price`);
  assert.ok(product.gst_rate > 0, `product ${product.id} has GST rate`);
  assert.ok(product.hsn_code, `product ${product.id} has HSN code`);
  assert.ok(product.warranty_summary, `product ${product.id} has warranty summary`);
  assert.ok(product.return_policy_summary, `product ${product.id} has return policy summary`);
  assert.ok(product.availability_status, `product ${product.id} has availability status`);
  assert.equal(product.source_system, 'synthetic_staging_manifest', `product ${product.id} has synthetic source system`);
  assert.ok(product.last_synced_at, `product ${product.id} has last synced timestamp`);
}
assert.ok(
  stagingManifest.webhook_test_reference_requirements.required_cases.includes('invalid_signature'),
  'staging seed includes webhook invalid-signature requirement',
);
assert.ok(
  stagingManifest.consent_passport_test_user_requirements.required_cases.includes('revoked_passport'),
  'staging seed includes revoked-passport requirement',
);

function assertNoForbiddenSeedSecrets(value, path = 'manifest') {
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
    joinText('Bearer', ' '),
    joinText('sk', '_live_'),
    joinText('pk', '_live_'),
    joinText('-----', 'BEGIN'),
    joinText('passport', '.jwt'),
    joinText('idempotency', '-key:'),
    joinText('mock', '-webhook', '-secret'),
  ];
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenSeedSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const lowered = key.toLowerCase();
      assert.equal(
        forbiddenKeyFragments.some((fragment) => lowered.includes(fragment)),
        false,
        `staging seed manifest does not include forbidden key ${path}.${key}`,
      );
      assertNoForbiddenSeedSecrets(nested, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const forbidden of forbiddenValueFragments) {
      assert.equal(value.includes(forbidden), false, `staging seed manifest does not include ${forbidden} at ${path}`);
    }
  }
}
assertNoForbiddenSeedSecrets(stagingManifest);

for (const required of [
  'Seed Purpose',
  'Seed Safety Rules',
  'Production Refusal Rules',
  'Staging DNS Prerequisites',
  'Staging DB And Redis Prerequisites',
  'Staging Secret Inventory By Name Only',
  'Staging Seed Data Model',
  'Staging Seed Command Plan For Later',
  'Staging Smoke-Test Command Plan For Later',
  'Cleanup And Reset Plan',
  'does not create resources',
  'no live Plural',
  'No production database',
  'No production Redis',
  'Do not copy production secret versions',
]) {
  assert.ok(stagingDataSetup.includes(required), `staging data setup guide includes ${required}`);
}
for (const forbidden of [
  'COMMERCE_LIVE_MODE_ENABLED=true',
  'PLURAL_LIVE_ENABLED=true',
  joinText('sk', '_live_'),
  joinText('pk', '_live_'),
  joinText('Bearer', ' '),
]) {
  assert.equal(stagingDataSetup.includes(forbidden), false, `staging data setup guide does not include ${forbidden}`);
}

for (const required of [
  'Commerce V1 Hosted Staging E2E Harness',
  'does not create resources',
  'No production URL may be used as an E2E target',
  'https://api-staging.grantex.dev',
  'https://staging.grantex.dev',
  'https://staging.agenticorg.ai',
  'https://grantex.dev',
  'https://api.grantex.dev',
  'https://app.agenticorg.ai',
  'cten_staging_commerce',
  'mch_staging_electronics_pilot',
  'cag_staging_agenticorg_sales',
  'ADMIN_API_KEY',
  'MOCK_PAYMENT_WEBHOOK_SECRET',
  'Commerce Passport signing key material',
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
  'docs/reports/commerce-v1-hosted-staging-e2e.md',
]) {
  assert.ok(hostedStagingE2E.includes(required), `hosted staging E2E guide includes ${required}`);
}

for (const required of [
  'Commerce V1 Option A Smoke Setup',
  'temporary hosted smoke path',
  'Option A hosted smoke was executed after explicit approval and is now complete',
  '22 passed checks, 0 failed checks, and 9 skipped negative checks',
  'Temporary smoke resources were deleted after evidence capture',
  'Full hosted staging is still not provisioned',
  'Live payments and live Plural remain blocked',
  'AgenticOrg local-to-smoke was not run as valid hosted evidence',
  'Direct Cloud Run URLs are allowed only for Option A smoke',
  'No custom DNS',
  'No hosted AgenticOrg',
  'No Firebase deploy',
  'min-instances=0',
  'max-instances=1',
  'Mock provider only',
  'No production database',
  'No production Redis',
  'No production secrets',
  'Delete temporary Redis',
  'Delete temporary Cloud SQL',
  'Commands Proposed But Not Run',
  'Cleanup Commands Proposed But Not Run',
  'COMMERCE_LIVE_MODE_ENABLED=false',
  'PLURAL_LIVE_ENABLED=false',
  'grantex-auth-smoke',
  'grantex-commerce-smoke-pg',
  'grantex-commerce-smoke-redis',
  '--allow-smoke-cloud-run-url',
  'COMMERCE_STAGING_ALLOWED_SMOKE_URL',
]) {
  assert.ok(optionASmokeSetup.includes(required), `Option A smoke setup guide includes ${required}`);
}
for (const forbidden of commonSecretMarkers) {
  assert.equal(optionASmokeSetup.includes(forbidden), false, `Option A smoke setup guide does not include ${forbidden}`);
}

for (const required of [
  'Commerce V1 Repeatable Option A Smoke Workflow',
  'C2D-prep executable runner tooling only',
  'manual approval gates',
  'min-instances=0',
  'max-instances=1',
  'grantex-auth-smoke',
  'grantex-commerce-smoke-pg',
  'grantex-commerce-smoke-redis',
  'Mock provider only',
  'COMMERCE_LIVE_MODE_ENABLED=true',
  'PLURAL_LIVE_ENABLED=true',
  'Cleanup Guarantees',
  'more than 24 hours',
  '--allow-long-cleanup-window',
  'AgenticOrg Local Real-Staging Eval Fit',
  'AGENTICORG_COMMERCE_REAL_STAGING',
  'GRANTEX_COMMERCE_BASE_URL',
  'GRANTEX_BASE_URL',
  'AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL',
  '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  '--fixture-env=.tmp/commerce-agent-real-staging.env',
  'node scripts/commerce-option-a-smoke-seed.mjs --run',
  'node scripts/commerce-option-a-smoke-evidence.mjs --run',
  'approved smoke API requests',
  'Guarded seed runner execution path',
  'Guarded evidence runner execution path',
  'The fixture export is disabled by default',
  'must stay under `.tmp/`',
  'cleanup/evidence warning language',
  'No hosted AgenticOrg deploy',
]) {
  assert.ok(repeatableOptionASmokeWorkflow.includes(required), `repeatable Option A workflow includes ${required}`);
}
for (const forbidden of commonSecretMarkers) {
  assert.equal(
    repeatableOptionASmokeWorkflow.includes(forbidden),
    false,
    `repeatable Option A workflow does not include ${forbidden}`,
  );
}

const optionASmokeRunbook = JSON.parse(optionASmokeRunbookText);
assert.equal(
  optionASmokeRunbook.status,
  'guarded_runner_available_for_later_approved_c2d',
  'Option A runbook records guarded C2D-prep runner status',
);
assert.equal(optionASmokeRunbook.runner.dry_run_default, true, 'Option A runbook keeps dry-run as default');
assert.equal(
  optionASmokeRunbook.runner.run_requires_separate_c2d_approval,
  true,
  'Option A runbook requires separate C2D approval for run mode',
);
assert.ok(
  optionASmokeRunbook.runner.seed_run_command.includes('--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env'),
  'Option A runbook documents fixture env seed run command',
);
assert.ok(
  optionASmokeRunbook.runner.evidence_run_command.includes('--fixture-env=.tmp/commerce-agent-real-staging.env'),
  'Option A runbook documents fixture env evidence run command',
);
assert.ok(
  optionASmokeRunbook.runner.approved_seed_requests.includes('POST /v1/commerce/catalog/products/bulk dry_run=false'),
  'Option A runbook documents approved catalog upsert request',
);
assert.ok(
  optionASmokeRunbook.runner.approved_evidence_cases.includes('payment_intent_create'),
  'Option A runbook documents approved payment intent evidence case',
);
assert.equal(optionASmokeRunbook.resources.cloud_run_service, 'grantex-auth-smoke', 'Option A runbook pins smoke service');
assert.equal(optionASmokeRunbook.resources.cloud_sql_instance, 'grantex-commerce-smoke-pg', 'Option A runbook pins smoke SQL');
assert.equal(optionASmokeRunbook.resources.redis_instance, 'grantex-commerce-smoke-redis', 'Option A runbook pins smoke Redis');
assert.equal(optionASmokeRunbook.resources.min_instances, 0, 'Option A runbook documents min instances 0');
assert.equal(optionASmokeRunbook.resources.max_instances, 1, 'Option A runbook documents max instances 1');
assert.equal(optionASmokeRunbook.provider.required, 'mock', 'Option A runbook requires mock provider');
assert.equal(optionASmokeRunbook.provider.live_payments_enabled, false, 'Option A runbook blocks live payments');
assert.equal(optionASmokeRunbook.provider.plural_live_enabled, false, 'Option A runbook blocks live Plural');
assert.equal(
  optionASmokeRunbook.agenticorg_fixture_bridge.enabled_by_default,
  false,
  'Option A runbook keeps AgenticOrg fixture bridge disabled by default',
);
assert.equal(
  optionASmokeRunbook.agenticorg_fixture_bridge.path_rule,
  '.tmp/ only',
  'Option A runbook requires fixture env under .tmp only',
);
assert.equal(
  optionASmokeRunbook.agenticorg_fixture_bridge.requires_exact_smoke_url_allowlist,
  true,
  'Option A runbook requires exact smoke URL allowlist for fixture env',
);
assert.equal(
  optionASmokeRunbook.agenticorg_fixture_bridge.stdout_values_allowed,
  false,
  'Option A runbook forbids fixture values in stdout',
);
assert.ok(
  optionASmokeRunbook.agenticorg_fixture_bridge.env_names.includes('AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT'),
  'Option A runbook names checkout passport fixture env without values',
);
assert.ok(
  optionASmokeRunbook.refused_resource_names.includes('grantex-auth')
    && optionASmokeRunbook.refused_resource_names.includes('grantex-pg16')
    && optionASmokeRunbook.refused_resource_names.includes('grantex-redis'),
  'Option A runbook documents production resource name refusals',
);
assert.ok(
  optionASmokeRunbook.secret_names_only.every((name) => name.startsWith('grantex-smoke-')),
  'Option A runbook lists smoke secret names only',
);
assert.equal(optionASmokeRunbook.redaction.secret_values_included, false, 'Option A runbook excludes secret values');
for (const forbidden of commonSecretMarkers) {
  assert.equal(optionASmokeRunbookText.includes(forbidden), false, `Option A runbook does not include ${forbidden}`);
}

const committedDocAndExampleTexts = {
  'commerce-v1-repeatable-option-a-smoke-workflow.md': repeatableOptionASmokeWorkflow,
  'commerce-option-a-smoke.runbook.json': optionASmokeRunbookText,
  'commerce-v1-option-a-smoke-evidence.md': optionASmokeEvidence,
};
const committedSecretValuePatterns = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/, 'bearer token value'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT-like value'],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/, 'provider key value'],
  [/\b(?:postgres|postgresql):\/\/[^\s<>"']+/, 'DB URL value'],
  [/\bredis:\/\/[^\s<>"']+/, 'Redis URL value'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bwhsec_[A-Za-z0-9]{12,}/, 'webhook secret value'],
];
for (const [path, text] of Object.entries(committedDocAndExampleTexts)) {
  for (const [pattern, label] of committedSecretValuePatterns) {
    assert.equal(pattern.test(text), false, `${path} does not include ${label}`);
  }
}

for (const required of [
  'dry-run command generation only',
  'Refusing production resource name',
  'Refusing production URL',
  'Refusing non-mock provider',
  'min-instances=0',
  'max-instances=1',
  'Refusing cleanup window more than 24 hours',
  'create_cloud_sql',
  'create_redis',
  'create_smoke_secret_names',
  'deploy_smoke_service',
  'agenticorg_local_real_staging_eval',
  '# NOT RUN',
]) {
  assert.ok(optionASmokePlan.includes(required), `Option A smoke plan script includes ${required}`);
}
for (const required of [
  'guarded_and_executable_after_approved_smoke_deploy',
  'executeSeedRun',
  'Smoke seed run requires exactly one Grantex auth env value present',
  'Smoke seed provider must be mock',
  'Smoke seed live payments flag must be false',
  'Smoke seed tenant id is pinned',
  'Smoke seed manifest must include 10-25 products',
  '--write-agenticorg-fixture-env',
  'Refusing AgenticOrg fixture env output outside .tmp/',
  'Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url',
  'Refusing COMMERCE_LIVE_MODE_ENABLED=true for Option A smoke seed tooling',
  'Refusing non-HTTPS URL',
  'sensitive_values_printed',
  'AgenticOrg fixture env under .tmp only',
]) {
  assert.ok(optionASmokeSeed.includes(required), `Option A smoke seed script includes ${required}`);
}
for (const required of [
  'Refusing production domain',
  'Refusing arbitrary run.app URL without exact --allow-smoke-cloud-run-url',
  'Refusing non-mock provider',
  'Refusing COMMERCE_LIVE_MODE_ENABLED=true',
  'Refusing PLURAL_LIVE_ENABLED=true',
  'executeEvidenceRun',
  'Failing closed because AgenticOrg fixture env is missing',
  'Refusing AgenticOrg fixture env input outside .tmp/',
  'writeEvidenceReport',
  'idempotency_keys_recorded: false',
  'commerce-v1-option-a-smoke-evidence.md',
]) {
  assert.ok(optionASmokeEvidenceTool.includes(required), `Option A smoke evidence tool includes ${required}`);
}

for (const required of [
  'Commerce V1 Option A Smoke Evidence',
  '- Passed: 14',
  '- Failed: 0',
  '- Failed-safe: 6',
  '- Skipped: 0',
  'payment_status | passed | 200',
  'Live flags: Commerce live mode false; live payments false; live Plural false.',
  'Cleanup completed after evidence capture.',
  'Deleted temporary Cloud Run service: grantex-auth-smoke',
  'Deleted temporary Cloud SQL instance: grantex-commerce-smoke-pg',
  'Deleted temporary Redis instance: grantex-commerce-smoke-redis',
  'Verified temporary smoke Cloud Run, Cloud SQL, Redis, and smoke secrets absent after cleanup',
  'Verified production resources still present: grantex-auth, grantex-pg16, grantex-redis',
  'Production Commerce V1, live payment, and live Plural flags were not changed by this run',
]) {
  assert.ok(optionASmokeEvidence.includes(required), `Option A smoke evidence includes ${required}`);
}

for (const forbidden of evidenceSecretMarkers) {
  assert.equal(optionASmokeEvidence.includes(forbidden), false, `Option A smoke evidence does not include ${forbidden}`);
}
assert.equal(
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(optionASmokeEvidence),
  false,
  'Option A smoke evidence does not include JWT-like passport or bearer material',
);

for (const required of [
  'https://api-staging.grantex.dev',
  'https://staging.grantex.dev',
  'https://staging.agenticorg.ai',
  'https://grantex.dev',
  'https://api.grantex.dev',
  'https://app.agenticorg.ai',
  "const dryRun = boolArg('--dry-run') || !run;",
  'docs/reports/commerce-v1-hosted-staging-e2e.md',
  'Refusing production domain',
  'Refusing credentialed URL',
  'Refusing COMMERCE_LIVE_MODE_ENABLED=true',
  'Refusing PLURAL_LIVE_ENABLED=true',
  'Refusing non-mock provider',
  'Run mode is intentionally disabled for M11 dry-run-only harness',
  '--allow-smoke-cloud-run-url',
  'COMMERCE_STAGING_ALLOWED_SMOKE_URL',
  'smoke_cloud_run_origin_allowed',
  'Refusing smoke Cloud Run allowlist URL that is not a run.app service origin',
]) {
  assert.ok(stagingE2EHarness.includes(required), `hosted staging E2E harness includes ${required}`);
}

for (const forbiddenDefault of [
  "DEFAULT_API_BASE = 'https://api.grantex.dev'",
  "DEFAULT_PORTAL_BASE = 'https://grantex.dev'",
  "DEFAULT_AGENTICORG_BASE = 'https://app.agenticorg.ai'",
]) {
  assert.equal(stagingE2EHarness.includes(forbiddenDefault), false, `hosted staging E2E harness does not default to ${forbiddenDefault}`);
}

for (const required of [
  'Commerce V1 Hosted Staging E2E Evidence Template',
  'https://api-staging.grantex.dev',
  'https://staging.grantex.dev',
  'https://staging.agenticorg.ai',
  'cten_staging_commerce',
  'mch_staging_electronics_pilot',
  'cag_staging_agenticorg_sales',
  'Provider: mock',
  'Live payments enabled: false',
  'Live Plural enabled: false',
  'secret values recorded: false',
]) {
  assert.ok(hostedStagingE2ETemplate.includes(required), `hosted staging E2E template includes ${required}`);
}

const expectedFalseImplementedRoutes = [].sort();
assert.deepEqual(
  extractFalseImplementedRoutes(openapi),
  expectedFalseImplementedRoutes,
  'OpenAPI x-implemented:false route inventory is pinned by M12 gap report',
);

for (const required of [
  'Commerce V1 Contract Completeness Gap Report',
  '`done`',
  '`partial`',
  '`blocked`',
  '`deferred`',
  '`not-started`',
  'Merchant/agent mutable control-plane APIs',
  'Product list/update/bulk/CSV',
  'Inbound merchant webhook source APIs',
  'Failed provider webhook replay',
  'Emergency re-enable',
  'Plural sandbox',
  'Hosted staging E2E evidence',
  'merchant.get_profile',
  'catalog.search',
  'catalog.get_item',
  'inventory.check',
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
  'JSON-RPC over HTTP caveat',
  'No UCP/ACP/AP2/MPP certification claims',
  'M12A Merchant/Agent Mutable/List API Completion',
  'M12B Product List/Patch/Bulk/CSV Completion',
  'M12C Inbound Merchant Webhook Source APIs And `catalog.product.updated`',
  'Inbound merchant webhook source APIs',
  'one-time signing secret',
  'complete-state `catalog.product.updated`',
  'M12D Portal Onboarding/Catalog/Webhook-Source/Policy/Publish Controls',
  'M14 Failed Webhook Replay And Emergency Re-enable',
  'M13 Plural Sandbox Integration After External Contract',
]) {
  assert.ok(contractGapReport.includes(required), `contract gap report includes ${required}`);
}
for (const route of expectedFalseImplementedRoutes) {
  assert.ok(contractGapReport.includes(route), `contract gap report names incomplete route ${route}`);
}
for (const forbidden of commonSecretMarkers) {
  assert.equal(contractGapReport.includes(forbidden), false, `contract gap report does not include ${forbidden}`);
}

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

const stagingE2EDryRun = execFileSync(
  process.execPath,
  [join(repoRoot, 'scripts', 'commerce-staging-e2e-harness.mjs'), '--dry-run'],
  { encoding: 'utf8' },
);
const stagingE2EReport = JSON.parse(stagingE2EDryRun);
assert.equal(stagingE2EReport.mode, 'dry-run');
assert.equal(stagingE2EReport.status, 'not_executed');
assert.equal(stagingE2EReport.safety.no_requests_made, true);
assert.equal(stagingE2EReport.targets.api_base, 'https://api-staging.grantex.dev');
assert.equal(stagingE2EReport.targets.agenticorg_base, 'https://staging.agenticorg.ai');
assert.equal(stagingE2EReport.report_path, 'docs/reports/commerce-v1-hosted-staging-e2e.md');
assert.equal(stagingE2EReport.manifest.provider, 'mock');
assert.ok(stagingE2EReport.positive_checks.includes('checkout create'));
assert.ok(stagingE2EReport.negative_checks.includes('invalid webhook signature'));

const stagingE2EProdRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-staging-e2e-harness.mjs'),
    '--dry-run',
    '--api-base=https://api.grantex.dev',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(stagingE2EProdRefusal.status, 0, 'hosted staging E2E harness refuses production API base');
assert.ok(
  `${stagingE2EProdRefusal.stdout}${stagingE2EProdRefusal.stderr}`.includes('Refusing production domain'),
  'hosted staging E2E production refusal explains the safety guard',
);

const smokeUrl = 'https://grantex-auth-smoke-abc123-uc.a.run.app';
const stagingE2ESmokeDryRun = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-staging-e2e-harness.mjs'),
    '--dry-run',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
  ],
  { encoding: 'utf8' },
);
const stagingE2ESmokeReport = JSON.parse(stagingE2ESmokeDryRun);
assert.equal(stagingE2ESmokeReport.mode, 'dry-run');
assert.equal(stagingE2ESmokeReport.status, 'not_executed');
assert.equal(stagingE2ESmokeReport.targets.api_base, smokeUrl);
assert.equal(stagingE2ESmokeReport.safety.smoke_cloud_run_origin_allowed, smokeUrl);
assert.equal(stagingE2ESmokeReport.safety.no_requests_made, true);

const stagingE2ESmokeNoAllowlist = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-staging-e2e-harness.mjs'),
    '--dry-run',
    `--api-base=${smokeUrl}`,
  ],
  { encoding: 'utf8' },
);
assert.notEqual(stagingE2ESmokeNoAllowlist.status, 0, 'hosted staging E2E harness refuses arbitrary run.app without allowlist');
assert.ok(
  `${stagingE2ESmokeNoAllowlist.stdout}${stagingE2ESmokeNoAllowlist.stderr}`.includes('Refusing non-staging Grantex API base'),
  'hosted staging E2E run.app refusal explains the smoke allowlist guard',
);

const nearCleanup = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const optionASmokePlanDryRun = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-plan.mjs'),
    '--dry-run',
    '--project=grantex-prod',
    '--region=us-central1',
    '--sql-tier=db-f1-micro',
    `--cleanup-by=${nearCleanup}`,
  ],
  { encoding: 'utf8' },
);
const optionASmokePlanReport = JSON.parse(optionASmokePlanDryRun);
assert.equal(optionASmokePlanReport.mode, 'dry-run');
assert.equal(optionASmokePlanReport.status, 'not_executed');
assert.equal(optionASmokePlanReport.creates_resources, false);
assert.equal(optionASmokePlanReport.deploys, false);
assert.equal(optionASmokePlanReport.service_name, 'grantex-auth-smoke');
assert.equal(optionASmokePlanReport.cloud_sql_instance, 'grantex-commerce-smoke-pg');
assert.equal(optionASmokePlanReport.redis_instance, 'grantex-commerce-smoke-redis');
assert.equal(optionASmokePlanReport.provider, 'mock');
assert.equal(optionASmokePlanReport.min_instances, 0);
assert.equal(optionASmokePlanReport.max_instances, 1);
assert.ok(
  optionASmokePlanReport.commands.every((entry) => entry.command.startsWith('# NOT RUN')),
  'Option A smoke planner prints commands as NOT RUN',
);

const optionASmokeLongCleanupRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-plan.mjs'),
    '--dry-run',
    '--project=grantex-prod',
    '--region=us-central1',
    '--sql-tier=db-f1-micro',
    '--cleanup-by=2099-01-01T00:00:00+05:30',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeLongCleanupRefusal.status, 0, 'Option A smoke planner refuses long cleanup windows');
assert.ok(
  `${optionASmokeLongCleanupRefusal.stdout}${optionASmokeLongCleanupRefusal.stderr}`.includes('Refusing cleanup window more than 24 hours'),
  'Option A smoke planner explains long cleanup window refusal',
);

const optionASmokeProdNameRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-plan.mjs'),
    '--dry-run',
    '--project=grantex-prod',
    '--region=us-central1',
    '--sql-tier=db-f1-micro',
    `--cleanup-by=${nearCleanup}`,
    '--service-name=grantex-auth',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeProdNameRefusal.status, 0, 'Option A smoke planner refuses production service name');
assert.ok(
  `${optionASmokeProdNameRefusal.stdout}${optionASmokeProdNameRefusal.stderr}`.includes('Refusing production resource name'),
  'Option A smoke planner explains production resource name refusal',
);

const optionASmokeSeedDryRun = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
  ],
  { encoding: 'utf8' },
);
const optionASmokeSeedReport = JSON.parse(optionASmokeSeedDryRun);
assert.equal(optionASmokeSeedReport.mode, 'dry-run');
assert.equal(optionASmokeSeedReport.status, 'not_executed');
assert.equal(optionASmokeSeedReport.would_write_catalog, false);
assert.equal(optionASmokeSeedReport.requests_made, false);
assert.equal(optionASmokeSeedReport.provider, 'mock');
assert.equal(optionASmokeSeedReport.live_flags.commerce_live_mode_enabled, false);
assert.equal(optionASmokeSeedReport.staging_ids.tenant_id, 'cten_staging_commerce');
assert.ok(optionASmokeSeedReport.catalog.product_count >= 10);
assert.ok(optionASmokeSeedReport.catalog.products_with_variants >= 3);

const fixtureExportEnv = {
  ...process.env,
  GRANTEX_COMMERCE_BEARER_TOKEN: '',
  GRANTEX_AGENT_ASSERTION: '',
  GRANTEX_API_KEY: '',
  AGENTICORG_COMMERCE_BROWSE_PASSPORT_JWT: '',
  AGENTICORG_COMMERCE_CHECKOUT_PASSPORT_JWT: '',
  AGENTICORG_COMMERCE_REVOKED_PASSPORT_JWT: '',
  AGENTICORG_COMMERCE_EXPIRED_PASSPORT_JWT: '',
  AGENTICORG_COMMERCE_DENIED_CONSENT_REF: '',
  COMMERCE_LIVE_MODE_ENABLED: '',
  PLURAL_LIVE_ENABLED: '',
};
const fixtureEnvPath = join(repoRoot, '.tmp', 'commerce-agent-real-staging.env');
const optionASmokeFixtureExportDryRun = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
const optionASmokeFixtureExportReport = JSON.parse(optionASmokeFixtureExportDryRun);
assert.equal(optionASmokeFixtureExportReport.mode, 'dry-run');
assert.equal(optionASmokeFixtureExportReport.agenticorg_fixture_env_export.written, true);
assert.equal(
  optionASmokeFixtureExportReport.agenticorg_fixture_env_export.path,
  '.tmp/commerce-agent-real-staging.env',
);
assert.equal(optionASmokeFixtureExportReport.agenticorg_fixture_env_export.sensitive_values_printed, false);
assert.ok(
  optionASmokeFixtureExportReport.agenticorg_fixture_env_export.variable_names_written.includes(
    'AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID',
  ),
  'Option A fixture export reports variable names only',
);
const fixtureEnvText = readFileSync(fixtureEnvPath, 'utf8');
for (const forbidden of fixtureEnvSecretMarkers) {
  assert.equal(fixtureEnvText.includes(forbidden), false, `fixture env dry-run does not include ${forbidden}`);
}

const optionASmokeFixtureOutsideTmpRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
    '--write-agenticorg-fixture-env=docs/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
assert.notEqual(optionASmokeFixtureOutsideTmpRefusal.status, 0, 'Option A fixture export refuses paths outside .tmp');
assert.ok(
  `${optionASmokeFixtureOutsideTmpRefusal.stdout}${optionASmokeFixtureOutsideTmpRefusal.stderr}`.includes(
    'Refusing AgenticOrg fixture env output outside .tmp/',
  ),
  'Option A fixture export explains .tmp path refusal',
);

const optionASmokeFixtureProdRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    '--api-base=https://api.grantex.dev',
    '--allow-smoke-cloud-run-url=https://api.grantex.dev',
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
assert.notEqual(optionASmokeFixtureProdRefusal.status, 0, 'Option A fixture export refuses production URL');
assert.ok(
  `${optionASmokeFixtureProdRefusal.stdout}${optionASmokeFixtureProdRefusal.stderr}`.includes(
    'Refusing production domain',
  ),
  'Option A fixture export explains production URL refusal',
);

const optionASmokeFixtureRunAppRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    '--api-base=https://example.run.app',
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
assert.notEqual(optionASmokeFixtureRunAppRefusal.status, 0, 'Option A fixture export refuses arbitrary run.app URL');
assert.ok(
  `${optionASmokeFixtureRunAppRefusal.stdout}${optionASmokeFixtureRunAppRefusal.stderr}`.includes(
    'Refusing arbitrary run.app URL',
  ),
  'Option A fixture export explains arbitrary run.app refusal',
);

const optionASmokeFixtureHttpLocalhostRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    '--api-base=http://localhost:3001',
    '--allow-smoke-cloud-run-url=http://localhost:3001',
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
assert.notEqual(optionASmokeFixtureHttpLocalhostRefusal.status, 0, 'Option A fixture export refuses HTTP localhost');
assert.ok(
  `${optionASmokeFixtureHttpLocalhostRefusal.stdout}${optionASmokeFixtureHttpLocalhostRefusal.stderr}`.includes(
    'Refusing non-HTTPS URL',
  ),
  'Option A fixture export explains HTTP localhost refusal',
);

const optionASmokeFixtureLiveFlagRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: { ...fixtureExportEnv, COMMERCE_LIVE_MODE_ENABLED: 'true' } },
);
assert.notEqual(optionASmokeFixtureLiveFlagRefusal.status, 0, 'Option A fixture export refuses live commerce flag');
assert.ok(
  `${optionASmokeFixtureLiveFlagRefusal.stdout}${optionASmokeFixtureLiveFlagRefusal.stderr}`.includes(
    'Refusing COMMERCE_LIVE_MODE_ENABLED=true',
  ),
  'Option A fixture export explains live commerce flag refusal',
);

const optionASmokeFixtureNonMockProviderRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-seed.mjs'),
    '--dry-run',
    '--manifest=docs/examples/commerce-staging-seed.manifest.json',
    '--provider=stripe',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
    '--write-agenticorg-fixture-env=.tmp/commerce-agent-real-staging.env',
  ],
  { encoding: 'utf8', env: fixtureExportEnv },
);
assert.notEqual(optionASmokeFixtureNonMockProviderRefusal.status, 0, 'Option A fixture export refuses non-mock provider');
assert.ok(
  `${optionASmokeFixtureNonMockProviderRefusal.stdout}${optionASmokeFixtureNonMockProviderRefusal.stderr}`.includes(
    'Smoke seed provider must be mock',
  ),
  'Option A fixture export explains non-mock provider refusal',
);

const optionASmokeEvidenceDryRun = execFileSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
  ],
  { encoding: 'utf8' },
);
const optionASmokeEvidenceDryRunReport = JSON.parse(optionASmokeEvidenceDryRun);
assert.equal(optionASmokeEvidenceDryRunReport.mode, 'dry-run');
assert.equal(optionASmokeEvidenceDryRunReport.status, 'not_executed');
assert.equal(optionASmokeEvidenceDryRunReport.requests_made, false);
assert.equal(optionASmokeEvidenceDryRunReport.api_base, smokeUrl);
assert.equal(optionASmokeEvidenceDryRunReport.provider, 'mock');
assert.equal(optionASmokeEvidenceDryRunReport.safety.exact_smoke_run_app_allowed, smokeUrl);

const optionASmokeEvidenceRunAppRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    `--api-base=${smokeUrl}`,
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeEvidenceRunAppRefusal.status, 0, 'Option A smoke evidence tool refuses arbitrary run.app');
assert.ok(
  `${optionASmokeEvidenceRunAppRefusal.stdout}${optionASmokeEvidenceRunAppRefusal.stderr}`.includes('Refusing arbitrary run.app URL'),
  'Option A smoke evidence run.app refusal explains exact allowlist guard',
);

const optionASmokeEvidenceProdRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    '--api-base=https://api.grantex.dev',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeEvidenceProdRefusal.status, 0, 'Option A smoke evidence tool refuses production API base');
assert.ok(
  `${optionASmokeEvidenceProdRefusal.stdout}${optionASmokeEvidenceProdRefusal.stderr}`.includes('Refusing production domain'),
  'Option A smoke evidence production refusal explains production guard',
);

const optionASmokeEvidenceHttpLocalhostRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    '--api-base=http://localhost:3001',
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeEvidenceHttpLocalhostRefusal.status, 0, 'Option A smoke evidence tool refuses HTTP localhost');
assert.ok(
  `${optionASmokeEvidenceHttpLocalhostRefusal.stdout}${optionASmokeEvidenceHttpLocalhostRefusal.stderr}`.includes(
    'Refusing non-HTTPS URL',
  ),
  'Option A smoke evidence HTTP localhost refusal explains HTTPS guard',
);

const optionASmokeEvidenceLiveFlagRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
  ],
  { encoding: 'utf8', env: { ...process.env, COMMERCE_LIVE_MODE_ENABLED: 'true' } },
);
assert.notEqual(optionASmokeEvidenceLiveFlagRefusal.status, 0, 'Option A smoke evidence tool refuses live commerce flag');
assert.ok(
  `${optionASmokeEvidenceLiveFlagRefusal.stdout}${optionASmokeEvidenceLiveFlagRefusal.stderr}`.includes(
    'Refusing COMMERCE_LIVE_MODE_ENABLED=true',
  ),
  'Option A smoke evidence live flag refusal explains live commerce guard',
);

const optionASmokeEvidenceNonMockProviderRefusal = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-option-a-smoke-evidence.mjs'),
    '--dry-run',
    '--provider=stripe',
    `--api-base=${smokeUrl}`,
    `--allow-smoke-cloud-run-url=${smokeUrl}`,
  ],
  { encoding: 'utf8' },
);
assert.notEqual(optionASmokeEvidenceNonMockProviderRefusal.status, 0, 'Option A smoke evidence tool refuses non-mock provider');
assert.ok(
  `${optionASmokeEvidenceNonMockProviderRefusal.stdout}${optionASmokeEvidenceNonMockProviderRefusal.stderr}`.includes(
    'Refusing non-mock provider',
  ),
  'Option A smoke evidence non-mock refusal explains provider guard',
);

const nonLocalSeed = spawnSync(
  process.execPath,
  [
    join(repoRoot, 'scripts', 'commerce-pilot-seed-local.mjs'),
    '--run',
    `--database-url=${joinText('post', 'gres', '://blocked-user:blocked-pass@prod-db.example.invalid:5432/blocked')}`,
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
assert.equal(/[^\u0000-\u007F]/.test(stagingSeedManifestText), false, 'staging seed manifest stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(loadReport), false, 'pilot load report stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(hostedStagingPlan), false, 'hosted staging plan stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(stagingDataSetup), false, 'staging data setup guide stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(hostedStagingE2E), false, 'hosted staging E2E guide stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokeSetup), false, 'Option A smoke setup guide stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(repeatableOptionASmokeWorkflow), false, 'repeatable Option A smoke workflow stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(hostedStagingE2ETemplate), false, 'hosted staging E2E template stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokeEvidence), false, 'Option A smoke evidence stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(contractGapReport), false, 'contract gap report stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(readOnlyDiscoveryProposal), false, 'read-only discovery proposal stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokeRunbookText), false, 'Option A smoke runbook stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(harness), false, 'load harness stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(stagingE2EHarness), false, 'hosted staging E2E harness stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokePlan), false, 'Option A smoke plan script stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokeSeed), false, 'Option A smoke seed script stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(optionASmokeEvidenceTool), false, 'Option A smoke evidence tool stays ASCII-only');
assert.equal(/[^\u0000-\u007F]/.test(seed), false, 'local seed script stays ASCII-only');

console.log('commerce-v1 pilot readiness validation passed');

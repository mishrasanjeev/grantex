import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, '..');
const guide = readFileSync(join(currentDir, 'guides', 'commerce-v1-operations.mdx'), 'utf8');
const openapi = readFileSync(join(currentDir, 'api', 'grantex-commerce-v1.openapi.yaml'), 'utf8');

const requiredSections = [
  '## Sandbox Playground Usage',
  '## CSV Product And Variant Import Columns',
  '## Provider Outage Runbook',
  '## Webhook Backlog And Failure Runbook',
  '## Reconciliation Failure Runbook',
  '## Audit Write Failure Runbook',
  '## Emergency Disable Runbook',
  '## Legal And Live Mode Controls',
  '## Human Review Gates',
];

for (const section of requiredSections) {
  assert.ok(guide.includes(section), `${section} is documented`);
}

assert.ok(guide.includes('Production live-pilot mode is available for the approved Shopify merchant'), 'live pilot availability is explicit');
assert.ok(guide.includes('production Plural settlement remains'), 'Plural production-settlement caveat is explicit');
assert.ok(guide.includes('must not store bearer tokens'), 'playground secret storage rule is explicit');
assert.ok(guide.includes('grantex_commerce_audit_write_failures_total'), 'audit write failure metric is documented');
assert.ok(guide.includes('webhook_failed_event_list_and_replay_api_contract_deferred'), 'webhook replay blocker is documented');
assert.ok(openapi.includes('/v1/commerce/ops/health:'), 'OpenAPI declares commerce ops health');
assert.ok(openapi.includes('operationId: getCommerceOpsHealth'), 'OpenAPI operationId is present');
assert.ok(openapi.includes('x-milestone: M6A'), 'OpenAPI marks M6A route');

assert.equal(
  /(sk_live|pk_live|grtx_live|BEGIN PRIVATE KEY|provider_secret|plural_secret|bearer [A-Za-z0-9._-]{20,})/i.test(guide),
  false,
  'commerce operations guide has no hardcoded production credentials or bearer tokens',
);

assert.equal(/[^\u0000-\u007F]/.test(guide), false, 'commerce operations guide stays ASCII-only');
assert.ok(repoRoot.endsWith('grantex'), 'validator is running from the grantex repo layout');

console.log('commerce-v1 hardening docs validation passed');

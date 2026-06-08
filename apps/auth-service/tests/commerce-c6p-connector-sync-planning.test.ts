import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const planningPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6p-first-connector-sync-adapter-planning.md',
);
const reportsDir = join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports');

const requiredSections = [
  '## First Adapter Target',
  '## Traceability',
  '## Metadata Contract',
  '## Dry-Run Request Shape',
  '## Dry-Run Result Shape',
  '## Source Precedence Model',
  '## Stale And Conflict Blockers',
  '## Tenant Boundary',
  '## Credential Redaction',
  '## Audit Evidence',
  '## Real Merchant Launch Blockers',
  '## Stop Conditions',
  '## Rollback',
  '## Validation',
];

const notCalledSystems = [
  'Shopify remains non-live and not called',
  'WooCommerce remains non-live and not called',
  'Magento remains non-live and not called',
  'Custom API remains declaration-only and not called',
  'ERP, billing, OMS, WMS, logistics, and CRM/support remain metadata-only',
  'Payment provider connectors remain metadata-only and not called',
  'Plural, Stripe, Pine, payment providers, and merchant private APIs remain',
];

const sourceDomains = [
  'catalog',
  'price',
  'inventory',
  'order',
  'fulfillment',
  'refund',
  'settlement',
  'support',
];

const blockerCodes = [
  'source_of_truth_not_declared',
  'connector_disabled',
  'connector_health_stale',
  'last_sync_stale',
  'source_conflict_blocker',
  'sync_failed_blocker',
  'sync_status_blocked',
  'execution_domain_metadata_only',
  'custom_api_runtime_not_implemented',
  'external_connector_runtime_not_implemented',
  'payment_provider_execution_not_enabled',
  'agenticorg_direct_execution_not_allowed',
  'provider_call_not_enabled_by_registry',
  'credentials_not_stored_by_registry',
];

function readPlanning() {
  return readFileSync(planningPath, 'utf8');
}

describe('C6P first connector sync adapter planning packet', () => {
  it('documents planning-only status and required sections', () => {
    const planning = readPlanning();

    expect(planning).toContain('Status: planned as an internal safe-foundation packet.');
    expect(planning).toContain('internal preview planning only');
    expect(planning).toContain('sandbox-only');
    expect(planning).toContain('non-live');
    expect(planning).toContain('non-publication');
    expect(planning).toContain('non-certifying');
    expect(planning).toContain('non-enabling');
    for (const section of requiredSections) {
      expect(planning).toContain(section);
    }
  });

  it('selects CSV/manual catalog dry-run with test doubles as the first adapter target', () => {
    const planning = readPlanning();

    expect(planning).toMatch(
      /The first adapter target is a CSV\/manual catalog dry-run adapter backed by test\s+doubles only\./,
    );
    expect(planning).toContain('csv_catalog_dry_run');
    expect(planning).toContain('csv_manual_catalog_test_double');
    expect(planning).toContain('fixture_ref');
    expect(planning).toContain('test_double');
    expect(planning).toContain('dry_run_only');
    expect(planning).toContain('test_double_only');
  });

  it('keeps external systems, providers, and merchant private APIs non-live and not called', () => {
    const planning = readPlanning();

    for (const system of notCalledSystems) {
      expect(planning).toContain(system);
    }
    expect(planning).toContain('outbound_sync_enabled');
    expect(planning).toContain('"outbound_sync_enabled": false');
    expect(planning).toContain('"provider_call_enabled": false');
    expect(planning).toContain('"merchant_private_api_call_enabled": false');
    expect(planning).toContain('"agenticorg_direct_execution_enabled": false');
  });

  it('states AgenticOrg never directly executes merchant private API calls', () => {
    const planning = readPlanning();

    expect(planning).toContain('AgenticOrg never directly executes merchant private API calls.');
    expect(planning).toContain('CommerceAgent callers are denied connector planning and management');
    expect(planning).toContain('AgenticOrg callers are never allowed to execute merchant private API calls');
  });

  it('defines metadata, source precedence, stale/conflict blockers, tenant boundaries, redaction, and audit evidence', () => {
    const planning = readPlanning();

    for (const domain of sourceDomains) {
      expect(planning).toContain(domain);
    }
    for (const blocker of blockerCodes) {
      expect(planning).toContain(blocker);
    }
    expect(planning).toContain('Filter by tenant and merchant before comparing connectors.');
    expect(planning).toContain('Prefer lower `source_priority` values.');
    expect(planning).toContain('Break ties by `connector_key` for deterministic review output.');
    expect(planning).toContain('tenant mismatch');
    expect(planning).toContain('merchant mismatch');
    expect(planning).toContain('Credential fields remain blocked');
    expect(planning).toContain('Required audit evidence');
    expect(planning).toContain('redaction confirmation');
  });

  it('documents real merchant launch blockers and stop conditions', () => {
    const planning = readPlanning();

    expect(planning).toContain('C6P does not approve real merchant launch');
    expect(planning).toContain('real merchant source-system scope');
    expect(planning).toContain('credential intake, storage, rotation, and redaction process');
    expect(planning).toContain('outbound sync approval');
    expect(planning).toContain('public discovery approval');
    expect(planning).toContain('production Commerce V1 approval');
    expect(planning).toContain('checkout/payment approval');
    expect(planning).toContain('live payment, live Plural, and live provider approval');
    expect(planning).toContain('production allowlist approval');
    expect(planning).toContain('Stop and require a new approved work item');
  });

  it('does not add generated reports or committed release-review artifacts', () => {
    expect(existsSync(reportsDir)).toBe(false);
  });

  it('does not claim public discovery, production, checkout, live, provider, merchant API, direct execution, allowlist, or certification enablement', () => {
    const planning = readPlanning();

    expect(planning).toContain('does not add routes');
    expect(planning).toContain('does not add routes, workers, schedules, migrations, portal UI changes');
    expect(planning).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true/i);
    expect(planning).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=\s*[^<\s]/i);
    expect(planning).not.toMatch(/public_discovery_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/checkout[^.\n]*(enabled|created|published)\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/payment_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/live_[A-Za-z0-9_]*\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/provider_call_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/merchant_private_api_call_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/agenticorg_direct_execution_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/outbound_sync_enabled\s*[:=]\s*true/i);
    expect(planning).not.toMatch(/production_allowlist[^.\n]*\s*[:=]\s*true/i);
    expect(planning).not.toMatch(
      /\b(certified|certification approved|production approved|public protocol publication approved|live payment approved|provider approved|protocol-publication certified)\b/i,
    );
  });

  it('does not contain credential values, private URLs, DB URLs, provider credentials, raw payload values, or concrete allowlists', () => {
    const planning = readPlanning();

    expect(planning).not.toMatch(/sk_live_[A-Za-z0-9]+/);
    expect(planning).not.toMatch(/pk_live_[A-Za-z0-9]+/);
    expect(planning).not.toMatch(/gho_[A-Za-z0-9]+/);
    expect(planning).not.toMatch(/-----BEGIN [A-Z ]+PRIVATE KEY-----/);
    expect(planning).not.toMatch(/postgres(?:ql)?:\/\/[^\s)]+/i);
    expect(planning).not.toMatch(/redis:\/\/[^\s)]+/i);
    expect(planning).not.toMatch(/^https:\/\/[A-Za-z0-9.-]*\.myshopify\.com(?:\/|$)/i);
    expect(planning).not.toMatch(/client_secret\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i);
    expect(planning).not.toMatch(/access_token\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i);
    expect(planning).not.toMatch(/refresh_token\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i);
    expect(planning).not.toMatch(/api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/i);
    expect(planning).not.toMatch(/allowlist\s*[:=]\s*\[[^\]]+\]/i);
  });
});

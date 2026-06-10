/**
 * Schema-level invariants. These tests read the migration files directly
 * because the unit-test harness mocks the SQL client (no real Postgres
 * runs). They guard against silent edits that would weaken structural
 * guarantees the V1 spec mandates.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'src', 'db', 'migrations');

function read(name: string): string {
  return readFileSync(join(migrationsDir, name), 'utf8');
}

describe('Commerce schema — tenant_id presence on every tenant-owned table', () => {
  // Every commerce-* migration that defines a tenant-owned table must
  // declare `tenant_id` as a non-null column with FK to commerce_tenants.
  const tenantOwned = [
    ['033_commerce_merchants.sql', 'commerce_merchants'],
    ['034_commerce_agents.sql', 'commerce_agents'],
    ['035_commerce_products.sql', 'commerce_products'],
    ['035_commerce_products.sql', 'commerce_product_variants'],
    ['036_commerce_audit_events.sql', 'commerce_audit_events'],
    ['052_commerce_connectors.sql', 'commerce_connectors'],
  ] as const;

  it.each(tenantOwned)('%s: %s carries tenant_id NOT NULL with FK', (file, table) => {
    const sql = read(file);
    const tableMatch = sql.split(`CREATE TABLE IF NOT EXISTS ${table}`)[1];
    expect(tableMatch, `table ${table} missing from ${file}`).toBeDefined();
    const tableBlock = tableMatch!.split(/CREATE TABLE|CREATE OR REPLACE|CREATE INDEX|CREATE UNIQUE|DROP TRIGGER|CREATE TRIGGER|DO \$\$/)[0]!;
    expect(tableBlock).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES commerce_tenants\(id\)/);
  });
});

describe('Commerce schema - C5Z sandbox onboarding columns', () => {
  it('051 extends merchants with safe sandbox onboarding state and no provider credential columns', () => {
    const s = read('051_commerce_sandbox_onboarding.sql');
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS support_url TEXT/);
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS public_discovery_description_draft TEXT/);
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS agentic_commerce_requested BOOLEAN NOT NULL DEFAULT FALSE/);
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS sandbox_onboarding_state TEXT NOT NULL DEFAULT 'draft_created'/);
    expect(s).toMatch(/sandbox_onboarding_state IN \(/);
    for (const state of [
      'draft_created',
      'profile_incomplete',
      'sandbox_ready',
      'submitted_for_review',
      'blocked',
      'not_approved',
      'rollout_not_requested',
    ]) {
      expect(s).toContain(`'${state}'`);
    }
    expect(s).not.toMatch(/provider_credential|secret|token|jwt/i);
  });
});

describe('Commerce schema — required indexes/constraints from spec §15', () => {
  it('commerce_merchants has unique (tenant_id, id) — as CONSTRAINT, not bare index', () => {
    // The hardening migration converted the original CREATE UNIQUE INDEX
    // to a table CONSTRAINT so it can be referenced by composite FKs from
    // commerce_products and commerce_product_variants. PG rejects bare
    // unique indexes as FK targets.
    expect(read('033_commerce_merchants.sql')).toMatch(
      /CONSTRAINT uq_commerce_merchants_tenant_id UNIQUE \(tenant_id, id\)/,
    );
  });

  it('commerce_agents has unique (tenant_id, id) and trust_status check', () => {
    const s = read('034_commerce_agents.sql');
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_agents_tenant_id/);
    expect(s).toMatch(/trust_status IN \('pending','trusted','suspended','disabled'\)/);
    expect(s).toMatch(/public_key_jwk IS NOT NULL OR api_key_hash IS NOT NULL/);
  });

  it('commerce_products has partial unique on (tenant_id, merchant_id, product_id) WHERE archived_at IS NULL', () => {
    expect(read('035_commerce_products.sql')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_products_active[\s\S]*?ON commerce_products\(tenant_id, merchant_id, product_id\)[\s\S]*?WHERE archived_at IS NULL/,
    );
  });

  it('commerce_product_variants has partial unique on SKU for active rows', () => {
    expect(read('035_commerce_products.sql')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_variants_active_sku[\s\S]*?ON commerce_product_variants\(tenant_id, merchant_id, sku\)[\s\S]*?WHERE archived_at IS NULL/,
    );
  });

  it('commerce_product_variants has tenant_id FK to commerce_tenants', () => {
    // merchant_id and product_id FKs are no longer single-column — they
    // moved to composite tenant-safe FKs asserted in the dedicated
    // describe block below.
    const s = read('035_commerce_products.sql');
    expect(s).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES commerce_tenants\(id\)/);
  });

  it('commerce_product_variants has availability_status enum check', () => {
    expect(read('035_commerce_products.sql')).toMatch(
      /availability_status IN \('in_stock','out_of_stock','pre_order','back_order','unknown'\)/,
    );
  });

  it('commerce_audit_events has the spec-required (tenant_id, merchant_id, occurred_at) index', () => {
    expect(read('036_commerce_audit_events.sql')).toMatch(
      /idx_commerce_audit_tenant_merchant_occurred[\s\S]*?ON commerce_audit_events\(tenant_id, merchant_id, occurred_at DESC\)/,
    );
  });

  it('commerce_developer_tenants has at most one default tenant per developer', () => {
    expect(read('031_commerce_tenants.sql')).toMatch(
      /uq_commerce_dev_tenants_default[\s\S]*?ON commerce_developer_tenants\(developer_id\) WHERE is_default = TRUE/,
    );
  });

  it('commerce_tenants has status CHECK limiting values to active|disabled', () => {
    expect(read('031_commerce_tenants.sql')).toMatch(
      /CONSTRAINT chk_commerce_tenants_status CHECK \(status IN \('active','disabled'\)\)/,
    );
  });
});

describe('Commerce schema — composite tenant-safe foreign keys (M1 hardening)', () => {
  it('commerce_merchants exposes UNIQUE CONSTRAINT (tenant_id, id) usable as an FK target', () => {
    // PG requires the referenced columns to be a UNIQUE/PK constraint, not
    // a bare unique index, before another table can FK to them. The
    // hardening migration converted the original CREATE UNIQUE INDEX to a
    // table CONSTRAINT inside CREATE TABLE.
    const s = read('033_commerce_merchants.sql');
    expect(s).toMatch(
      /CONSTRAINT uq_commerce_merchants_tenant_id UNIQUE \(tenant_id, id\)/,
    );
  });

  it('commerce_products has composite FK (tenant_id, merchant_id) → commerce_merchants(tenant_id, id)', () => {
    const s = read('035_commerce_products.sql');
    expect(s).toMatch(
      /CONSTRAINT fk_commerce_products_merchant_tenant\s*\n?\s*FOREIGN KEY \(tenant_id, merchant_id\)\s*\n?\s*REFERENCES commerce_merchants\(tenant_id, id\)/,
    );
    // The legacy single-column FK to commerce_merchants(id) on products.merchant_id is gone.
    expect(s).not.toMatch(/merchant_id\s+TEXT NOT NULL REFERENCES commerce_merchants\(id\)/);
  });

  it('commerce_products has UNIQUE CONSTRAINT (tenant_id, id) so variants can FK back', () => {
    expect(read('035_commerce_products.sql')).toMatch(
      /CONSTRAINT uq_commerce_products_tenant_id UNIQUE \(tenant_id, id\)/,
    );
  });

  it('commerce_product_variants has composite FK (tenant_id, merchant_id) → commerce_merchants(tenant_id, id)', () => {
    const s = read('035_commerce_products.sql');
    expect(s).toMatch(
      /CONSTRAINT fk_commerce_variants_merchant_tenant\s*\n?\s*FOREIGN KEY \(tenant_id, merchant_id\)\s*\n?\s*REFERENCES commerce_merchants\(tenant_id, id\)/,
    );
    expect(s).not.toMatch(/merchant_id\s+TEXT NOT NULL REFERENCES commerce_merchants\(id\)/);
  });

  it('commerce_product_variants has composite FK (tenant_id, product_id) → commerce_products(tenant_id, id)', () => {
    const s = read('035_commerce_products.sql');
    expect(s).toMatch(
      /CONSTRAINT fk_commerce_variants_product_tenant\s*\n?\s*FOREIGN KEY \(tenant_id, product_id\)\s*\n?\s*REFERENCES commerce_products\(tenant_id, id\)/,
    );
    expect(s).not.toMatch(/product_id\s+TEXT NOT NULL REFERENCES commerce_products\(id\)/);
  });
});

describe('Commerce schema — M2 migrations (037-041)', () => {
  it('037 commerce_tenant_operators has role CHECK and backfill from M1 default mappings', () => {
    const s = read('037_commerce_tenant_operators.sql');
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_tenant_operators/);
    expect(s).toMatch(/CHECK \(role IN \('owner','operator'\)\)/);
    expect(s).toMatch(/INSERT INTO commerce_tenant_operators[\s\S]*FROM commerce_developer_tenants/);
    expect(s).toMatch(/ON CONFLICT \(developer_id, tenant_id\) DO NOTHING/);
  });

  it('038 commerce_merchant_api_keys uses sha256 hash + composite tenant FK + partial unique on active', () => {
    const s = read('038_commerce_merchant_api_keys.sql');
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_merchant_api_keys/);
    expect(s).toMatch(/key_hash\s+TEXT NOT NULL/);
    expect(s).toMatch(/CONSTRAINT fk_merchant_api_key_merchant\s*\n?\s*FOREIGN KEY \(tenant_id, merchant_id\)\s*\n?\s*REFERENCES commerce_merchants\(tenant_id, id\)/);
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_merchant_api_keys_hash[\s\S]*WHERE revoked_at IS NULL/);
    expect(s).toMatch(/CHECK \(environment IN \('sandbox','live'\)\)/);
  });

  it('039 commerce_passport_keys enforces ES256 algorithm and kid namespace at the DB layer', () => {
    const s = read('039_commerce_passport_keys.sql');
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_passport_keys/);
    expect(s).toMatch(/CHECK \(algorithm = 'ES256'\)/);
    expect(s).toMatch(/CHECK \(\s*kid ~ '\^commerce-passport-\[0-9\]\{8\}-\[a-z0-9\]\{8\}\$'\s*\)/);
    expect(s).toMatch(/CHECK \(status IN \('active','retired','compromised'\)\)/);
    // Exactly one active key at any time.
    expect(s).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_passport_keys_active[\s\S]*WHERE status = 'active'/);
    // Private key is encrypted.
    expect(s).toMatch(/encrypted_private_key_jwk\s+TEXT NOT NULL/);
  });

  it('040 commerce_consent_records has composite tenant FKs + status CHECK + presented_payload_hash + user_principal_hint', () => {
    const s = read('040_commerce_consent_records.sql');
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_consent_records/);
    expect(s).toMatch(/CHECK \(status IN \('requested','granted','denied','expired'\)\)/);
    expect(s).toMatch(/CHECK \(passport_type IN \('browse','checkout'\)\)/);
    expect(s).toMatch(/presented_payload_hash\s+TEXT/);
    // Finding 1 redesign: csrf_secret_hash dropped (CSRF derived per-form
    // from principal session token); user_principal_hint added (agent
    // hint that's enforced at approval against verified principal).
    expect(s).not.toMatch(/csrf_secret_hash/);
    expect(s).toMatch(/user_principal_hint\s+TEXT/);
    expect(s).toMatch(/consent_request_id\s+TEXT NOT NULL UNIQUE/);
    expect(s).toMatch(/CONSTRAINT fk_consent_merchant\s*\n?\s*FOREIGN KEY \(tenant_id, merchant_id\)\s*\n?\s*REFERENCES commerce_merchants\(tenant_id, id\)/);
    expect(s).toMatch(/CONSTRAINT fk_consent_agent\s*\n?\s*FOREIGN KEY \(tenant_id, agent_id\)\s*\n?\s*REFERENCES commerce_agents\(tenant_id, id\)/);
  });

  it('041 commerce_passports has UNIQUE consent_record_id (Finding 3 — single-use exchange)', () => {
    const s = read('041_commerce_passports.sql');
    expect(s).toMatch(/consent_record_id\s+TEXT NOT NULL UNIQUE/);
    // Belt-and-braces idempotent ALTER TABLE for upgrade scenarios.
    expect(s).toMatch(/ADD CONSTRAINT commerce_passports_consent_record_id_key/);
  });

  it('041 commerce_passports is append-only with BEFORE UPDATE/DELETE triggers + revocations sibling table', () => {
    const s = read('041_commerce_passports.sql');
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_passports/);
    expect(s).toMatch(/jti\s+TEXT PRIMARY KEY/);
    expect(s).toMatch(/kid\s+TEXT NOT NULL REFERENCES commerce_passport_keys\(kid\)/);
    expect(s).toMatch(/CREATE OR REPLACE FUNCTION commerce_passports_block_mutation/);
    expect(s).toMatch(/BEFORE UPDATE ON commerce_passports/);
    expect(s).toMatch(/BEFORE DELETE ON commerce_passports/);
    // Revocations sibling table exists and is itself append-only at the role layer.
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS commerce_passport_revocations/);
    expect(s).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE ON commerce_passports FROM grantex_app/);
    expect(s).toMatch(/GRANT INSERT, SELECT ON commerce_passports TO grantex_app/);
  });
});

describe('Commerce schema — electronics_appliances preset is seeded', () => {
  it('migration 032 inserts electronics_appliances with required_fields and default_policy_rules', () => {
    const s = read('032_commerce_category_presets.sql');
    expect(s).toMatch(/INSERT INTO commerce_category_presets/);
    expect(s).toMatch(/'electronics_appliances'/);
    expect(s).toMatch(/ON CONFLICT \(preset_key\) DO NOTHING/);
    // Spec §16.1 default_policy_rules shape
    expect(s).toMatch(/"max_amount_minor_units":\s*50000000/);
    expect(s).toMatch(/"currency":\s*"INR"/);
    expect(s).toMatch(/"emergency_disable":\s+false/);
  });
});

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
  ] as const;

  it.each(tenantOwned)('%s: %s carries tenant_id NOT NULL with FK', (file, table) => {
    const sql = read(file);
    const tableMatch = sql.split(`CREATE TABLE IF NOT EXISTS ${table}`)[1];
    expect(tableMatch, `table ${table} missing from ${file}`).toBeDefined();
    const tableBlock = tableMatch!.split(/CREATE TABLE|CREATE OR REPLACE|CREATE INDEX|CREATE UNIQUE|DROP TRIGGER|CREATE TRIGGER|DO \$\$/)[0]!;
    expect(tableBlock).toMatch(/tenant_id\s+TEXT NOT NULL REFERENCES commerce_tenants\(id\)/);
  });
});

describe('Commerce schema — required indexes/constraints from spec §15', () => {
  it('commerce_merchants has unique (tenant_id, id)', () => {
    expect(read('033_commerce_merchants.sql')).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_merchants_tenant_id\s*\n\s*ON commerce_merchants\(tenant_id, id\)/,
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

  it('commerce_product_variants has FK to products and merchants and tenants', () => {
    const s = read('035_commerce_products.sql');
    expect(s).toMatch(/product_id\s+TEXT NOT NULL REFERENCES commerce_products\(id\)/);
    expect(s).toMatch(/merchant_id\s+TEXT NOT NULL REFERENCES commerce_merchants\(id\)/);
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

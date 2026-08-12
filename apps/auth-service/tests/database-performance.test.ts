import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const serviceDir = join(testDir, '..');
const migrationsDir = join(serviceDir, 'src', 'db', 'migrations');

const indexMigrations = [
  '064_agents_developer_created_index.sql',
  '065_auth_requests_owner_agent_index.sql',
  '066_grants_developer_issued_index.sql',
  '067_grants_active_expiry_index.sql',
  '068_grants_principal_session_index.sql',
  '069_grants_parent_index.sql',
  '070_grant_tokens_grant_index.sql',
  '071_refresh_tokens_grant_index.sql',
  '072_audit_developer_timestamp_index.sql',
  '073_audit_principal_timestamp_index.sql',
  '074_webhooks_developer_created_index.sql',
  '075_webhook_deliveries_webhook_created_index.sql',
  '076_policies_evaluation_index.sql',
  '077_anomalies_developer_detected_index.sql',
  '078_commerce_products_listing_index.sql',
  '079_commerce_variants_product_listing_index.sql',
  '081_commerce_products_search_index.sql',
  '082_grants_agent_principal_history_index.sql',
  '083_grants_status_listing_index.sql',
  '084_audit_agent_timestamp_index.sql',
  '085_webhook_deliveries_status_index.sql',
  '086_anomalies_status_listing_index.sql',
] as const;

describe('database performance migrations', () => {
  it.each(indexMigrations)('%s builds exactly one index without a blocking table build', (file) => {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    expect(sql.match(/CREATE INDEX CONCURRENTLY/gi)).toHaveLength(1);
    expect(sql.match(/CREATE INDEX/gi)).toHaveLength(1);
    expect(sql).toMatch(/IF NOT EXISTS/i);
  });

  it('installs pg_trgm before creating the matching catalog search index', () => {
    const extension = readFileSync(join(migrationsDir, '080_pg_trgm_extension.sql'), 'utf8');
    const index = readFileSync(join(migrationsDir, '081_commerce_products_search_index.sql'), 'utf8');
    const catalog = readFileSync(join(serviceDir, 'src', 'lib', 'commerce', 'catalog.ts'), 'utf8');
    const searchDocument = "COALESCE(p.title, '') || ' ' || COALESCE(p.brand, '') || ' ' || p.product_id";

    expect(extension).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_trgm/i);
    expect(index).toContain('gin_trgm_ops');
    expect(catalog.match(new RegExp(searchDocument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('uses concrete predicates for high-volume optional-filter routes', () => {
    for (const file of ['grants.ts', 'audit.ts', 'webhooks.ts', 'anomalies.ts']) {
      const source = readFileSync(join(serviceDir, 'src', 'routes', file), 'utf8');
      expect(source).not.toMatch(/IS NULL OR/i);
    }
  });

  it('serializes startup migrations on one reserved database session', () => {
    const source = readFileSync(join(serviceDir, 'src', 'db', 'migrate.ts'), 'utf8');
    expect(source).toContain('sql.reserve()');
    expect(source).toContain("pg_advisory_lock(hashtextextended('grantex:migrations', 0))");
    expect(source).toContain("pg_advisory_unlock(hashtextextended('grantex:migrations', 0))");
    expect(source).toContain('migrationSql.release()');
  });

  it('holds the migration lock while every file runs and releases the connection', async () => {
    const migrationSql = Object.assign(vi.fn().mockResolvedValue([]), {
      unsafe: vi.fn().mockResolvedValue([]),
      release: vi.fn(),
    });
    const sql = { reserve: vi.fn().mockResolvedValue(migrationSql) };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runMigrations(sql as never);
    } finally {
      log.mockRestore();
    }

    expect(sql.reserve).toHaveBeenCalledOnce();
    expect(migrationSql.mock.calls).toHaveLength(2);
    expect((migrationSql.mock.calls[0]?.[0] as string[]).join('')).toContain('pg_advisory_lock');
    expect((migrationSql.mock.calls[1]?.[0] as string[]).join('')).toContain('pg_advisory_unlock');
    // Derived from the directory rather than hardcoded — a literal count turns
    // every new migration into an unrelated test failure.
    const migrationCount = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length;
    expect(migrationSql.unsafe).toHaveBeenCalledTimes(migrationCount);
    expect(migrationSql.release).toHaveBeenCalledOnce();
  });
});

/**
 * How the migration runner reads a file before running it. Both decisions are
 * made from the SQL text, and both were fooled by things that are not SQL:
 *
 * - a file is run outside a transaction when it uses CONCURRENTLY, which
 *   costs it the atomicity of its statements and its ledger row. A mention of
 *   the word in a comment used to be enough to trigger that.
 * - the names of concurrently-built indexes decide which invalid indexes are
 *   repaired. UNIQUE and quoted names were missed, so a half-built one would
 *   never be dropped and never be rebuilt.
 */
import { describe, expect, it } from 'vitest';
import { blankSqlNoise, concurrentIndexNames, migrationLockTimeoutError, runsConcurrently } from '../src/db/migrate.js';

describe('reading a migration file', () => {
  it('does not give up atomicity because a comment mentions CONCURRENTLY', () => {
    const sql = `-- This one deliberately does NOT use CREATE INDEX CONCURRENTLY.
/* CONCURRENTLY would need its own file. */
ALTER TABLE grants ADD COLUMN IF NOT EXISTS note TEXT;`;
    expect(runsConcurrently(sql)).toBe(false);
  });

  it('still runs outside a transaction when the statement really is concurrent', () => {
    expect(runsConcurrently('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON grants (id);')).toBe(true);
  });

  it('does not treat a string literal as SQL', () => {
    const sql = "INSERT INTO notes (body) VALUES ('run this CONCURRENTLY one day');";
    expect(runsConcurrently(sql)).toBe(false);
  });

  it('leaves dollar-quoted function bodies alone', () => {
    const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  -- CONCURRENTLY
  RETURN;
END;
$$ LANGUAGE plpgsql;`;
    expect(runsConcurrently(sql)).toBe(false);
  });

  it('finds unique and quoted index names, and ignores commented-out ones', () => {
    const sql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_unique ON grants (id);
CREATE INDEX CONCURRENTLY "Quoted Name" ON grants (agent_id);
-- CREATE INDEX CONCURRENTLY idx_never ON grants (principal_id);`;
    expect(concurrentIndexNames(sql)).toEqual(['idx_unique', 'Quoted Name']);
  });

  it('keeps the SQL the same length so nothing else shifts', () => {
    const sql = "SELECT 1; -- comment\nSELECT 'literal';";
    expect(blankSqlNoise(sql)).toHaveLength(sql.length);
    expect(blankSqlNoise(sql)).toContain('SELECT 1;');
  });
});

describe('MIGRATION_LOCK_TIMEOUT', () => {
  it.each(['2s', '500ms', '1min', '2000', undefined, ''])('accepts %s', (value) => {
    expect(migrationLockTimeoutError(value)).toBeNull();
  });

  it.each(['soon', "2s'; DROP TABLE grants; --", '-1', '2 fortnights'])('rejects %s', (value) => {
    expect(migrationLockTimeoutError(value)).toMatch(/MIGRATION_LOCK_TIMEOUT/);
  });

  it('rejects 0, which would mean waiting forever', () => {
    expect(migrationLockTimeoutError('0')).toMatch(/must not be 0/);
  });
});

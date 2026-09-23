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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blankSqlNoise,
  concurrentIndexNames,
  expectedSchemaOf,
  migrationLockTimeoutError,
  runsConcurrently,
} from '../src/db/migrate.js';

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


/**
 * What a database at head must contain, read from the migration files.
 *
 * This list decides whether `migrate-baseline` refuses, so it has two failure
 * directions and they are not symmetric. An object expected but not built
 * blocks an operator doing exactly the right thing. An object built but not
 * expected is worse and quieter: a database missing it is reported at head,
 * gets baselined, and no later start ever applies the file. The corpus test in
 * migrate-ledger-postgres covers both directions against the real files; these
 * cover the rules themselves.
 */
describe('reading what the migrations build', () => {
  it('takes the table name, schema-qualified or not', () => {
    const schema = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY);',
      'CREATE TABLE IF NOT EXISTS public.audit_entries (id TEXT PRIMARY KEY);',
    ]);
    expect(schema.tables).toEqual(['audit_entries', 'grants']);
  });

  it('keeps the case of a quoted identifier and lowercases a bare one', () => {
    const schema = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS "MixedCase" (id TEXT);',
      'CREATE TABLE IF NOT EXISTS AlsoMixed (id TEXT);',
    ]);
    // `information_schema` reports a bare name folded to lower case and a
    // quoted one exactly as written, so the expectation has to match that.
    expect(schema.tables).toEqual(['MixedCase', 'alsomixed']);
  });

  it('reads ALTER TABLE ONLY … ADD COLUMN IF NOT EXISTS', () => {
    const schema = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS grants (id TEXT);',
      'ALTER TABLE ONLY grants ADD COLUMN IF NOT EXISTS purpose TEXT;',
      'ALTER TABLE IF EXISTS grants ADD COLUMN IF NOT EXISTS parent_grant_id TEXT;',
    ]);
    expect(schema.columns).toEqual([
      { table: 'grants', column: 'parent_grant_id' },
      { table: 'grants', column: 'purpose' },
    ]);
  });

  it('forgets a table a later migration drops, and its columns with it', () => {
    const schema = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS signing_keys (id TEXT);',
      'ALTER TABLE signing_keys ADD COLUMN IF NOT EXISTS alg TEXT;',
      'DROP TABLE IF EXISTS signing_keys;',
    ]);
    expect(schema.tables).toEqual([]);
    expect(schema.columns).toEqual([]);
  });

  it('forgets a column a later migration drops', () => {
    const schema = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS grants (id TEXT);',
      'ALTER TABLE grants ADD COLUMN IF NOT EXISTS legacy_flag BOOLEAN;',
      'ALTER TABLE grants DROP COLUMN IF EXISTS legacy_flag;',
    ]);
    expect(schema.tables).toEqual(['grants']);
    expect(schema.columns).toEqual([]);
  });

  it('does not expect anything a comment or a string literal mentions', () => {
    const schema = expectedSchemaOf([
      `-- CREATE TABLE IF NOT EXISTS ghost_table (id TEXT);
       /* CREATE TABLE IF NOT EXISTS other_ghost (id TEXT); */
       INSERT INTO notes (body) VALUES ('CREATE TABLE IF NOT EXISTS quoted_ghost (id TEXT)');`,
    ]);
    expect(schema.tables).toEqual([]);
  });

  /**
   * Renames are the shape the scanner gets wrong, in the direction that
   * blocks a correct operator: it goes on expecting the old name, so an
   * at-head database is refused. There is no `RENAME` in the corpus today,
   * and the guard below fails the moment one appears — at which point this is
   * the note explaining what to do about it.
   */
  it('still expects the old name after a rename, which is why the corpus must not contain one', () => {
    const renamedTable = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS old_name (id TEXT);',
      'ALTER TABLE old_name RENAME TO new_name;',
    ]);
    expect(renamedTable.tables).toEqual(['old_name']); // wrong, and known to be

    const renamedColumn = expectedSchemaOf([
      'CREATE TABLE IF NOT EXISTS grants (id TEXT);',
      'ALTER TABLE grants ADD COLUMN IF NOT EXISTS old_column TEXT;',
      'ALTER TABLE grants RENAME COLUMN old_column TO new_column;',
    ]);
    expect(renamedColumn.columns).toEqual([{ table: 'grants', column: 'old_column' }]);
  });

  it('has no RENAME in the migration corpus', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .filter((file) => /\bRENAME\b/i.test(blankSqlNoise(readFileSync(join(dir, file), 'utf-8'))));
    // If this fails, the new migration renames a table or a column, and
    // `expectedSchemaOf` will go on expecting the old name — which makes
    // `migrate-baseline` refuse a database that really is at head. Teach the
    // scanner the rename before merging it.
    expect(offenders).toEqual([]);
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

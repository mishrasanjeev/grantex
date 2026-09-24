/**
 * The compiler, not a test, is what keeps a helper from opening a transaction
 * inside its caller's one.
 *
 * postgres.js has no `begin` on a transaction handle — it exposes `savepoint`
 * — so calling it throws `sql.begin is not a function`, aborts the caller's
 * transaction and rolls back everything it had done. Cascade revocation hit
 * exactly that and left grants ACTIVE while reporting success, and the type
 * that was supposed to prevent it, `TxSql`, was an alias for the *pool*.
 *
 * These are compile-time assertions. `@ts-expect-error` fails the build when
 * the line it guards stops being an error, so if `TxSql` ever goes back to
 * meaning the pool, `npm run typecheck` fails here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TxSql } from '../src/db/client.js';

// The global test setup mocks `db/client.js`; this file needs the real
// `queries`, which is pure and touches no connection.
const { queries } = await vi.importActual<typeof import('../src/db/client.js')>('../src/db/client.js');

declare const tx: TxSql;
declare const pool: TxSql;

export async function typeProbes(): Promise<void> {
  // A transaction handle runs queries.
  await tx`SELECT 1`;
  await tx<{ id: string }[]>`SELECT id FROM grants WHERE id = ${'grnt_x'}`;
  // And can take a savepoint.
  await tx.savepoint(async () => { await tx`SELECT 1`; });
  // @ts-expect-error a transaction handle cannot open a transaction
  await tx.begin(async () => { await tx`SELECT 1`; });

  // `queries(pool)` hands a query-only handle to helpers that run queries and
  // nothing else. It runs the same queries...
  await pool`SELECT 1`;
  await pool<{ id: string }[]>`SELECT id FROM grants WHERE id = ${'grnt_x'}`;
  // ...and is accepted wherever a transaction handle is wanted, because every
  // such helper only queries.
  await takesTransaction(pool);
  // @ts-expect-error the pool cannot open a transaction either
  await pool.begin(async () => { await pool`SELECT 1`; });
}

async function takesTransaction(sql: TxSql): Promise<void> {
  await sql`SELECT 1`;
}

describe('TxSql', () => {
  it('is checked by the compiler, not at runtime', () => {
    expect(typeof typeProbes).toBe('function');
  });

  /**
   * `queries()` hands the pool to helpers that only run queries. The type
   * cannot take `savepoint` away — an intersection that removes it also makes
   * the value uncallable, and the tagged-template signature is the whole
   * point of `TxSql` — so the value refuses it instead, at the point of the
   * mistake rather than as a TypeError from inside postgres.js.
   */
  it('refuses savepoint on the pool, and passes everything else through', () => {
    const fakePool = Object.assign(() => 'query', { unsafe: () => 'unsafe', begin: () => 'begin' });
    const handle = queries(fakePool as never) as unknown as Record<string, unknown>;
    expect(() => handle['savepoint']).toThrow(/no savepoint/i);
    expect(typeof handle['unsafe']).toBe('function');
    expect((handle as unknown as () => string)()).toBe('query');
  });
});

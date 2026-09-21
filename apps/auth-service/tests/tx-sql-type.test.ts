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
import { describe, expect, it } from 'vitest';
import type { TxSql } from '../src/db/client.js';

declare const tx: TxSql;

export async function typeProbes(): Promise<void> {
  // A transaction handle runs queries.
  await tx`SELECT 1`;
  await tx<{ id: string }[]>`SELECT id FROM grants WHERE id = ${'grnt_x'}`;
  // And can take a savepoint.
  await tx.savepoint(async () => { await tx`SELECT 1`; });
  // @ts-expect-error a transaction handle cannot open a transaction
  await tx.begin(async () => { await tx`SELECT 1`; });
}

describe('TxSql', () => {
  it('is checked by the compiler, not at runtime', () => {
    expect(typeof typeProbes).toBe('function');
  });
});

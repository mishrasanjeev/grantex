import postgres from 'postgres';
import { config } from '../config.js';

/**
 * postgres.js v3 TransactionSql loses the tagged-template call signature due to
 * `extends Omit<Sql, ...>`. This helper type restores it for use in transaction
 * callbacks: `sql.begin(async (tx: TxSql) => { await tx\`...\`; })`
 */
/**
 * A handle that is already inside a transaction, for use in `begin`
 * callbacks: `sql.begin(async (tx: TxSql) => { await tx`...`; })`.
 *
 * This used to alias the **pool** type, which has `begin` on it — so a
 * parameter typed `TxSql` gave no protection at all, and a helper handed a
 * caller's transaction could open a nested one. postgres.js has no `begin` on
 * a transaction handle (it exposes `savepoint`), so that throws
 * `sql.begin is not a function`, aborts the caller's transaction and rolls
 * back everything it had done. Cascade revocation hit exactly that and left
 * grants active while reporting success.
 *
 * `TransactionSql` is the real type: tagged templates and `${}` interpolation
 * still compile, `savepoint` compiles, and `tx.begin(...)` is a compile error.
 */
export type TxSql = postgres.TransactionSql<Record<string, unknown>>;

/**
 * Present the pool where a query-only handle is wanted.
 *
 * Helpers that run queries and nothing else take `TxSql`, so that they cannot
 * open a transaction — inside a caller's transaction that would throw and roll
 * the caller's work back. The pool runs exactly the same queries, so this is
 * the one place that says so, rather than a cast scattered over every call
 * site.
 *
 * `TxSql` promises one thing the pool does not have: `savepoint`. The type
 * system cannot take it away again without also losing the tagged-template
 * call signature the whole type exists for — an intersection with
 * `{ savepoint?: never }` makes the value uncallable — so the value says it
 * instead. Reaching for `savepoint` on the pool fails at the point of the
 * mistake, with a message naming it, rather than as a `TypeError` from inside
 * postgres.js.
 */
export function queries(sql: ReturnType<typeof postgres>): TxSql {
  return new Proxy(sql as unknown as TxSql, {
    get(target, property, receiver) {
      if (property === 'savepoint') {
        throw new Error(
          'queries(sql) is the connection pool presented as a query-only handle: it has no savepoint. '
          + 'Take the transaction you meant to be inside, or use sql.begin() to start one.',
        );
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(config.databaseUrl, {
      max: 20,                    // connection pool size
      idle_timeout: 30,           // close idle connections after 30s
      connect_timeout: 10,        // fail if connection takes > 10s
      max_lifetime: 60 * 30,      // recycle connections every 30 minutes
    });
  }
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

import postgres from 'postgres';
import { config } from '../config.js';

/**
 * A transaction helper can run queries and explicitly take savepoints, but
 * cannot start a transaction. Postgres.js 4 adds nested begin to TransactionSql;
 * use its callable query interface and add only the savepoint capability.
 */
export type TxSql = postgres.ISql & Pick<postgres.TransactionSql, 'savepoint'>;

/**
 * Present the pool where a query-only handle is wanted.
 *
 * Helpers that run queries and nothing else take `TxSql`, so that they cannot
 * open a transaction — inside a caller's transaction that would throw and roll
 * the caller's work back. The pool runs exactly the same queries, so this is
 * the one place that says so, rather than a cast scattered over every call
 * site.
 *
 * Reaching for `savepoint` on the pool fails at the point of the mistake.
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
      max: config.databasePoolMax,
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

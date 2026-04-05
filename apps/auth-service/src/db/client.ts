import postgres from 'postgres';
import { config } from '../config.js';

/**
 * postgres.js v3 TransactionSql loses the tagged-template call signature due to
 * `extends Omit<Sql, ...>`. This helper type restores it for use in transaction
 * callbacks: `sql.begin(async (tx: TxSql) => { await tx\`...\`; })`
 */
export type TxSql = ReturnType<typeof postgres>;

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

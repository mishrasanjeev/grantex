import postgres from 'postgres';
import { config } from '../config.js';

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(config.databaseUrl);
  }
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  AuthorizationCode,
  ClientRegistration,
  ConsentRecord,
  PendingAuthorization,
  RefreshTokenBinding,
  RevocationRecord,
} from '../types.js';
import type { McpAuthStorage } from './types.js';
import { assertExpiry, secretKey } from './keys.js';

/**
 * The one capability `PostgresStorage` needs from a driver: run a statement
 * with positional (`$1`) parameters and return its rows. A `pg.Pool` or
 * `pg.Client` satisfies it as-is; wrap a `postgres` (postgres.js) instance
 * with {@link fromPostgresJs}.
 *
 * When `params` is omitted the text may contain several statements (the
 * migration runner relies on this), which both drivers support.
 */
export interface PostgresQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Minimal shape of a postgres.js `sql` instance. */
export interface PostgresJsSql {
  unsafe(query: string, params?: never[]): PromiseLike<ReadonlyArray<Record<string, unknown>>>;
}

/** Adapts a postgres.js (`postgres`) instance to {@link PostgresQueryable}. */
export function fromPostgresJs(sql: PostgresJsSql): PostgresQueryable {
  return {
    async query(text, params) {
      const rows = params === undefined
        ? await sql.unsafe(text)
        : await sql.unsafe(text, params as never[]);
      return { rows: [...rows] };
    },
  };
}

export interface PostgresStorageOptions {
  /** A `pg.Pool`/`pg.Client`, or `fromPostgresJs(sql)`. The caller owns its lifecycle. */
  db: PostgresQueryable;
}

const EXPIRING_TABLES = [
  'mcp_auth_pending_authorizations',
  'mcp_auth_authorization_codes',
  'mcp_auth_refresh_token_bindings',
  'mcp_auth_consents',
  'mcp_auth_revocations',
] as const;

function parseRecord<T>(value: unknown, what: string): T {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`PostgresStorage: stored ${what} is not a JSON object`);
  }
  return parsed as T;
}

/**
 * Postgres-backed {@link McpAuthStorage}. Run {@link runMigrations} (or
 * apply `migrations/*.sql` with your own tooling) before first use.
 *
 * Single use is enforced by `DELETE … RETURNING`: Postgres lets exactly one
 * of any number of concurrent deletes of a row return it.
 */
export class PostgresStorage implements McpAuthStorage {
  readonly kind = 'postgres';
  readonly #db: PostgresQueryable;

  constructor(options: PostgresStorageOptions) {
    if (!options?.db || typeof options.db.query !== 'function') {
      throw new TypeError('PostgresStorage requires a db with a query(text, params) method');
    }
    this.#db = options.db;
  }

  async getClient(clientId: string): Promise<ClientRegistration | undefined> {
    const { rows } = await this.#db.query(
      'SELECT registration FROM mcp_auth_clients WHERE client_id = $1',
      [clientId],
    );
    const row = rows[0];
    return row === undefined ? undefined : parseRecord<ClientRegistration>(row['registration'], 'client');
  }

  async putClient(client: ClientRegistration): Promise<void> {
    await this.#db.query(
      `INSERT INTO mcp_auth_clients (client_id, registration)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (client_id)
       DO UPDATE SET registration = EXCLUDED.registration, updated_at = now()`,
      [client.clientId, JSON.stringify(client)],
    );
  }

  async deleteClient(clientId: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      'DELETE FROM mcp_auth_clients WHERE client_id = $1 RETURNING client_id',
      [clientId],
    );
    return rows.length > 0;
  }

  async putPendingAuthorization(id: string, record: PendingAuthorization): Promise<void> {
    await this.#put('mcp_auth_pending_authorizations', secretKey(id), record.clientId, record);
  }

  async takePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    return this.#take<PendingAuthorization>('mcp_auth_pending_authorizations', secretKey(id));
  }

  async putAuthorizationCode(code: string, record: AuthorizationCode): Promise<void> {
    await this.#put('mcp_auth_authorization_codes', secretKey(code), record.clientId, record);
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.#take<AuthorizationCode>('mcp_auth_authorization_codes', secretKey(code));
  }

  async putRefreshTokenBinding(refreshToken: string, binding: RefreshTokenBinding): Promise<void> {
    await this.#put('mcp_auth_refresh_token_bindings', secretKey(refreshToken), binding.clientId, binding);
  }

  async takeRefreshTokenBinding(refreshToken: string, clientId: string): Promise<RefreshTokenBinding | undefined> {
    return this.#take<RefreshTokenBinding>('mcp_auth_refresh_token_bindings', secretKey(refreshToken), clientId);
  }

  async putConsent(id: string, record: ConsentRecord): Promise<void> {
    await this.#put('mcp_auth_consents', secretKey(id), record.clientId, record);
  }

  async takeConsent(id: string): Promise<ConsentRecord | undefined> {
    return this.#take<ConsentRecord>('mcp_auth_consents', secretKey(id));
  }

  async revokeToken(jti: string, record: RevocationRecord): Promise<void> {
    assertExpiry(record.expiresAt, 'revocation');
    await this.#db.query(
      `INSERT INTO mcp_auth_revocations (key, client_id, record, expires_at)
       VALUES ($1, $2, $3::jsonb, to_timestamp($4::double precision / 1000))
       ON CONFLICT (key) DO UPDATE SET
         record = EXCLUDED.record,
         expires_at = GREATEST(mcp_auth_revocations.expires_at, EXCLUDED.expires_at)`,
      [jti, record.clientId ?? null, JSON.stringify(record), record.expiresAt],
    );
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    const { rows } = await this.#db.query(
      `SELECT 1 FROM mcp_auth_revocations
       WHERE key = $1 AND expires_at > to_timestamp($2::double precision / 1000)`,
      [jti, Date.now()],
    );
    return rows.length > 0;
  }

  /**
   * Deletes expired rows. Expired rows are already invisible to every read;
   * call this on a schedule (for example every few minutes) to bound table
   * size. Returns the number of rows removed.
   */
  async purgeExpired(): Promise<number> {
    let removed = 0;
    for (const table of EXPIRING_TABLES) {
      const { rows } = await this.#db.query(
        `DELETE FROM ${table} WHERE expires_at <= to_timestamp($1::double precision / 1000) RETURNING 1`,
        [Date.now()],
      );
      removed += rows.length;
    }
    return removed;
  }

  async #put(table: string, key: string, clientId: string, record: { expiresAt: number }): Promise<void> {
    assertExpiry(record.expiresAt, 'record');
    await this.#db.query(
      `INSERT INTO ${table} (key, client_id, record, expires_at)
       VALUES ($1, $2, $3::jsonb, to_timestamp($4::double precision / 1000))
       ON CONFLICT (key) DO UPDATE SET
         client_id = EXCLUDED.client_id,
         record = EXCLUDED.record,
         expires_at = EXCLUDED.expires_at`,
      [key, clientId, JSON.stringify(record), record.expiresAt],
    );
  }

  async #take<T>(table: string, key: string, clientId?: string): Promise<T | undefined> {
    const params: unknown[] = [key, Date.now()];
    let where = 'key = $1';
    if (clientId !== undefined) {
      params.push(clientId);
      where += ' AND client_id = $3';
    }
    const { rows } = await this.#db.query(
      `DELETE FROM ${table} WHERE ${where}
       RETURNING record, expires_at > to_timestamp($2::double precision / 1000) AS live`,
      params,
    );
    const row = rows[0];
    if (row === undefined || row['live'] !== true) return undefined;
    return parseRecord<T>(row['record'], table);
  }
}

const MIGRATION_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('grantex:mcp-auth:migrations', 0));";

/** Directory holding the forward-only `NNN_name.sql` migrations shipped with the package. */
export function migrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

/**
 * Applies the package's migrations in file-name order. Each file is
 * idempotent (`IF NOT EXISTS`) and runs as one implicit transaction holding
 * an advisory lock, so replicas starting together serialise and a failed
 * file leaves no partial change. Returns the file names applied.
 */
export async function runMigrations(db: PostgresQueryable): Promise<string[]> {
  const directory = migrationsDirectory();
  const files = (await readdir(directory)).filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (files.length === 0) {
    throw new Error(`No mcp-auth migrations found in ${directory}`);
  }
  for (const file of files) {
    const content = await readFile(new URL(file, new URL('../../migrations/', import.meta.url)), 'utf8');
    // No params: the driver sends a simple query, which Postgres runs as a
    // single implicit transaction (the lock is released when it ends).
    await db.query(`${MIGRATION_LOCK}\n${content}`);
  }
  return files;
}

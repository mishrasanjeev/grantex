/**
 * Postgres caps backend: row locks serialize reservations per counter.
 *
 * A reservation runs in one READ COMMITTED transaction: it makes sure a row
 * exists per counter in `grantex_cap_counters`, locks those rows in a fixed
 * order (so concurrent reservations cannot deadlock), prunes and sums the
 * counter's reservations in `grantex_cap_reservations`, and inserts the new
 * reservation only if every limit holds. Time comes from the database
 * (`clock_timestamp()`) unless a clock is injected for tests. Same tables and
 * statements as the Python SDK's `PostgresCapsBackend`.
 *
 * Rows carry a SHA-256-derived hash of the tenant id, not the tenant id, in
 * `tenant_id`: isolation comes from that hash being part of every key and
 * query, and row-level security policies written against plain tenant ids do
 * not match these rows.
 *
 * Expired rows are deleted lazily when their counter is next reserved. Run
 * `prune()` periodically (for example hourly) to delete expired reservations,
 * per-case reservations older than `caseTtlSeconds` if one is set, and
 * counters with no reservations left.
 *
 * `pool` is a `pg` Pool, or anything with the same `connect()` / `query()` /
 * `release()` shape. Create the tables with `CAPS_SCHEMA_SQL` through your own
 * migration tool, or `ensureSchema()`.
 */

import { CapExceededError, WINDOW_MS, tenantHash, type CapsBackend, type ResolvedCapLimit } from './meter.js';

export const CAPS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grantex_cap_counters (
  tenant_id   TEXT NOT NULL,
  counter_key TEXT NOT NULL,
  PRIMARY KEY (tenant_id, counter_key)
);

CREATE TABLE IF NOT EXISTS grantex_cap_reservations (
  tenant_id      TEXT NOT NULL,
  counter_key    TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  units          BIGINT NOT NULL CHECK (units >= 0),
  reserved_at    TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, counter_key, reservation_id),
  FOREIGN KEY (tenant_id, counter_key)
    REFERENCES grantex_cap_counters (tenant_id, counter_key)
);

ALTER TABLE grantex_cap_reservations ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_grantex_cap_reservations_time
  ON grantex_cap_reservations (tenant_id, counter_key, reserved_at);

CREATE INDEX IF NOT EXISTS idx_grantex_cap_reservations_expiry
  ON grantex_cap_reservations (expires_at)
  WHERE expires_at IS NOT NULL;
`;

export interface PgClientLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  /** `pg` destroys the connection instead of reusing it when given an error. */
  release(err?: Error | boolean): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

const NOW_SQL =
  'SELECT CASE WHEN $1::bigint IS NULL THEN clock_timestamp() ELSE to_timestamp($1::bigint / 1000.0) END AS now';
const LOCK_ATTEMPTS = 3;

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error('database returned an invalid usage');
  return n;
}

export class PostgresCapsBackend implements CapsBackend {
  readonly #pool: PgPoolLike;
  readonly #caseTtlSeconds: number | undefined;

  /**
   * `caseTtlSeconds` optionally lets `prune()` delete per-case reservations
   * that old; by default they are kept, because deleting them would reset the
   * per-case cap.
   */
  constructor(pool: PgPoolLike, options: { caseTtlSeconds?: number } = {}) {
    const ttl = options.caseTtlSeconds;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) {
      throw new Error('caseTtlSeconds must be a positive integer');
    }
    this.#pool = pool;
    this.#caseTtlSeconds = ttl;
  }

  async ensureSchema(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      for (const statement of CAPS_SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
        await client.query(statement);
      }
    } finally {
      client.release();
    }
  }

  static async #now(client: PgClientLike, nowMs: number | undefined): Promise<unknown> {
    const { rows } = await client.query(NOW_SQL, [nowMs ?? null]);
    const row = rows[0];
    if (row === undefined) throw new Error('database returned no time');
    return row['now'];
  }

  static async #used(client: PgClientLike, tenant: string, key: string, windowMs: number, now: unknown, prune: boolean): Promise<number> {
    let rows: Array<Record<string, unknown>>;
    if (windowMs > 0) {
      if (prune) {
        await client.query(
          'DELETE FROM grantex_cap_reservations WHERE tenant_id = $1 AND counter_key = $2 ' +
            'AND reserved_at <= $3::timestamptz - make_interval(secs => $4::double precision)',
          [tenant, key, now, windowMs / 1000],
        );
      }
      ({ rows } = await client.query(
        'SELECT COALESCE(SUM(units), 0) AS used FROM grantex_cap_reservations ' +
          'WHERE tenant_id = $1 AND counter_key = $2 AND reserved_at > $3::timestamptz - make_interval(secs => $4::double precision)',
        [tenant, key, now, windowMs / 1000],
      ));
    } else {
      ({ rows } = await client.query(
        'SELECT COALESCE(SUM(units), 0) AS used FROM grantex_cap_reservations WHERE tenant_id = $1 AND counter_key = $2',
        [tenant, key],
      ));
    }
    const row = rows[0];
    if (row === undefined) throw new Error('database returned no usage');
    return int(row['used']);
  }

  #expirySeconds(limit: ResolvedCapLimit): number | null {
    const window = WINDOW_MS[limit.window];
    if (window > 0) return window / 1000;
    return this.#caseTtlSeconds ?? null;
  }

  /** Run `work` in a READ COMMITTED transaction; a connection whose rollback fails is destroyed. */
  async #transaction<T>(work: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The original error propagates; the connection is not reused.
          releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw err;
      }
    } finally {
      client.release(releaseError);
    }
  }

  async reserve(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void> {
    const tenant = await tenantHash(tenantId);
    const ordered = [...limits].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    await this.#transaction(async (client) => {
      for (const limit of ordered) {
        let locked = false;
        for (let attempt = 0; attempt < LOCK_ATTEMPTS && !locked; attempt += 1) {
          await client.query(
            'INSERT INTO grantex_cap_counters (tenant_id, counter_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [tenant, limit.key],
          );
          const { rows } = await client.query(
            'SELECT counter_key FROM grantex_cap_counters WHERE tenant_id = $1 AND counter_key = $2 FOR UPDATE',
            [tenant, limit.key],
          );
          // No row: prune() removed an empty counter between the two statements.
          locked = rows.length === 1;
        }
        if (!locked) throw new Error('caps counter row could not be locked');
      }
      // Read the time after the locks are held, so a reservation that waited
      // is judged against the moment it actually runs.
      const now = await PostgresCapsBackend.#now(client, nowMs);
      for (const limit of ordered) {
        const used = await PostgresCapsBackend.#used(client, tenant, limit.key, WINDOW_MS[limit.window], now, true);
        if (used + limit.units > limit.limit) {
          throw new CapExceededError({
            limit: limit.limit, window: limit.window, used, requested: limit.units, scope: limit.scope, kind: limit.kind,
          });
        }
      }
      for (const limit of ordered) {
        await client.query(
          'INSERT INTO grantex_cap_reservations (tenant_id, counter_key, reservation_id, units, reserved_at, expires_at) ' +
            'VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(secs => $6::double precision))',
          [tenant, limit.key, reservationId, limit.units, now, this.#expirySeconds(limit)],
        );
      }
    });
  }

  async refund(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[]): Promise<void> {
    const tenant = await tenantHash(tenantId);
    const client = await this.#pool.connect();
    try {
      for (const limit of limits) {
        await client.query(
          'DELETE FROM grantex_cap_reservations WHERE tenant_id = $1 AND counter_key = $2 AND reservation_id = $3',
          [tenant, limit.key, reservationId],
        );
      }
    } finally {
      client.release();
    }
  }

  async usage(tenantId: string, limit: ResolvedCapLimit, nowMs: number | undefined): Promise<number> {
    const tenant = await tenantHash(tenantId);
    const client = await this.#pool.connect();
    try {
      const now = await PostgresCapsBackend.#now(client, nowMs);
      return await PostgresCapsBackend.#used(client, tenant, limit.key, WINDOW_MS[limit.window], now, false);
    } finally {
      client.release();
    }
  }

  /**
   * Delete expired reservations and counters left empty; returns the numbers
   * deleted. Counters being reserved are locked and skipped, and a counter that
   * still has reservations cannot be deleted (the foreign key refuses it,
   * failing this run rather than losing a reservation; run it again).
   */
  async prune(nowMs?: number): Promise<{ reservations: number; counters: number }> {
    return this.#transaction(async (client) => {
      const now = await PostgresCapsBackend.#now(client, nowMs);
      const expired = await client.query(
        'DELETE FROM grantex_cap_reservations WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz',
        [now],
      );
      const empty = await client.query(
        'DELETE FROM grantex_cap_counters WHERE (tenant_id, counter_key) IN (' +
          ' SELECT c.tenant_id, c.counter_key FROM grantex_cap_counters c' +
          ' WHERE NOT EXISTS (SELECT 1 FROM grantex_cap_reservations r' +
          '   WHERE r.tenant_id = c.tenant_id AND r.counter_key = c.counter_key)' +
          ' FOR UPDATE SKIP LOCKED)',
      );
      return { reservations: expired.rowCount ?? 0, counters: empty.rowCount ?? 0 };
    });
  }
}

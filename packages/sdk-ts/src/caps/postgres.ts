/**
 * Postgres caps backend: row locks serialize reservations per counter.
 *
 * A reservation runs in one transaction: it upserts a row per counter in
 * `grantex_cap_counters`, locks those rows in a fixed order (so concurrent
 * reservations cannot deadlock), prunes and sums the counter's reservations in
 * `grantex_cap_reservations`, and inserts the new reservation only if every
 * limit holds. Rows carry `tenant_id`. Time comes from the database
 * (`clock_timestamp()`) unless a clock is injected for tests. Same tables and
 * statements as the Python SDK's `PostgresCapsBackend`.
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
  PRIMARY KEY (tenant_id, counter_key, reservation_id),
  FOREIGN KEY (tenant_id, counter_key)
    REFERENCES grantex_cap_counters (tenant_id, counter_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_grantex_cap_reservations_time
  ON grantex_cap_reservations (tenant_id, counter_key, reserved_at);
`;

export interface PgClientLike {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

const NOW_SQL =
  'SELECT CASE WHEN $1::bigint IS NULL THEN clock_timestamp() ELSE to_timestamp($1::bigint / 1000.0) END AS now';

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n)) throw new Error('database returned an invalid usage');
  return n;
}

export class PostgresCapsBackend implements CapsBackend {
  readonly #pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.#pool = pool;
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

  async reserve(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void> {
    const tenant = await tenantHash(tenantId);
    const ordered = [...limits].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const client = await this.#pool.connect();
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;
      for (const limit of ordered) {
        await client.query(
          'INSERT INTO grantex_cap_counters (tenant_id, counter_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [tenant, limit.key],
        );
      }
      for (const limit of ordered) {
        const { rows } = await client.query(
          'SELECT counter_key FROM grantex_cap_counters WHERE tenant_id = $1 AND counter_key = $2 FOR UPDATE',
          [tenant, limit.key],
        );
        if (rows.length !== 1) throw new Error('caps counter row missing after upsert');
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
          'INSERT INTO grantex_cap_reservations (tenant_id, counter_key, reservation_id, units, reserved_at) ' +
            'VALUES ($1, $2, $3, $4, $5::timestamptz)',
          [tenant, limit.key, reservationId, limit.units, now],
        );
      }
      await client.query('COMMIT');
      open = false;
    } finally {
      if (open) {
        // The original error propagates; a failed rollback must not mask it.
        await client.query('ROLLBACK').catch(() => undefined);
      }
      client.release();
    }
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
}

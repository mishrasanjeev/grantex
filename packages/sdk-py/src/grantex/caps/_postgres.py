"""Postgres caps backend: row locks serialize reservations per counter.

A reservation runs in one transaction. It upserts a row per counter in
``grantex_cap_counters``, locks those rows in a fixed order (so concurrent
reservations cannot deadlock), prunes and sums the counter's reservations in
``grantex_cap_reservations``, and inserts the new reservation only if every
limit holds. Rows carry ``tenant_id``, so tenant isolation (including
row-level security, if you use it) applies. Time comes from the database
(``clock_timestamp()``) unless a clock is injected for tests.

The backend is driver-neutral: ``connection_factory`` returns a DB-API 2.0
connection using the ``format`` parameter style (``%s``), such as pg8000 or
psycopg. Create the tables with ``SCHEMA_SQL`` (idempotent) through your own
migration tool. The TypeScript SDK uses the same tables.
"""

from __future__ import annotations

from typing import Any, Callable, List, Optional, Sequence, Tuple

from ._meter import WINDOW_MS, CapExceededError, CapLimit, tenant_hash

SCHEMA_SQL = """
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
"""

_NOW_SQL = "SELECT CASE WHEN %s::bigint IS NULL THEN clock_timestamp() ELSE to_timestamp(%s::bigint / 1000.0) END"


class PostgresCapsBackend:
    """Caps counters in Postgres."""

    def __init__(self, connection_factory: Callable[[], Any]) -> None:
        self._connect = connection_factory

    def ensure_schema(self) -> None:
        """Create the caps tables if they do not exist."""
        conn = self._connect()
        try:
            cur = conn.cursor()
            for statement in (s.strip() for s in SCHEMA_SQL.split(";")):
                if statement:
                    cur.execute(statement)
            conn.commit()
        finally:
            conn.close()

    def _locked(self, cur: Any, tenant: str, limits: Sequence[CapLimit]) -> List[Tuple[CapLimit, str]]:
        ordered = sorted(((limit, limit.key()) for limit in limits), key=lambda item: item[1])
        for _, key in ordered:
            cur.execute(
                "INSERT INTO grantex_cap_counters (tenant_id, counter_key) VALUES (%s, %s) "
                "ON CONFLICT DO NOTHING",
                (tenant, key),
            )
        for _, key in ordered:
            cur.execute(
                "SELECT counter_key FROM grantex_cap_counters "
                "WHERE tenant_id = %s AND counter_key = %s FOR UPDATE",
                (tenant, key),
            )
            if cur.fetchone() is None:
                raise RuntimeError("caps counter row missing after upsert")
        return ordered

    @staticmethod
    def _now(cur: Any, now_ms: Optional[int]) -> Any:
        cur.execute(_NOW_SQL, (now_ms, now_ms))
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("database returned no time")
        return row[0]

    @staticmethod
    def _used(cur: Any, tenant: str, key: str, window_ms: int, now: Any, prune: bool) -> int:
        if window_ms > 0:
            if prune:
                cur.execute(
                    "DELETE FROM grantex_cap_reservations WHERE tenant_id = %s AND counter_key = %s "
                    "AND reserved_at <= %s::timestamptz - make_interval(secs => %s::double precision)",
                    (tenant, key, now, window_ms / 1000.0),
                )
            cur.execute(
                "SELECT COALESCE(SUM(units), 0) FROM grantex_cap_reservations "
                "WHERE tenant_id = %s AND counter_key = %s AND reserved_at > %s::timestamptz - make_interval(secs => %s::double precision)",
                (tenant, key, now, window_ms / 1000.0),
            )
        else:
            cur.execute(
                "SELECT COALESCE(SUM(units), 0) FROM grantex_cap_reservations "
                "WHERE tenant_id = %s AND counter_key = %s",
                (tenant, key),
            )
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("database returned no usage")
        return int(row[0])

    def reserve(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        tenant = tenant_hash(tenant_id)
        conn = self._connect()
        try:
            cur = conn.cursor()
            ordered = self._locked(cur, tenant, limits)
            # Read the time after the locks are held, so a reservation that
            # waited is judged against the moment it actually runs.
            now = self._now(cur, now_ms)
            for limit, key in ordered:
                used = self._used(cur, tenant, key, WINDOW_MS[limit.window], now, prune=True)
                if used + limit.units > limit.limit:
                    conn.rollback()
                    raise CapExceededError(
                        limit=limit.limit, window=limit.window, used=used,
                        requested=limit.units, scope=limit.scope, kind=limit.kind,
                    )
            for limit, key in ordered:
                cur.execute(
                    "INSERT INTO grantex_cap_reservations "
                    "(tenant_id, counter_key, reservation_id, units, reserved_at) VALUES (%s, %s, %s, %s, %s::timestamptz)",
                    (tenant, key, reservation_id, limit.units, now),
                )
            conn.commit()
        except BaseException:
            try:
                conn.rollback()
            except Exception:  # nosec B110
                pass  # the original error is re-raised below
            raise
        finally:
            conn.close()

    def refund(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        tenant = tenant_hash(tenant_id)
        conn = self._connect()
        try:
            cur = conn.cursor()
            for limit in limits:
                cur.execute(
                    "DELETE FROM grantex_cap_reservations "
                    "WHERE tenant_id = %s AND counter_key = %s AND reservation_id = %s",
                    (tenant, limit.key(), reservation_id),
                )
            conn.commit()
        finally:
            conn.close()

    def usage(self, tenant_id: str, limit: CapLimit, now_ms: Optional[int]) -> int:
        tenant = tenant_hash(tenant_id)
        conn = self._connect()
        try:
            cur = conn.cursor()
            now = self._now(cur, now_ms)
            used = self._used(cur, tenant, limit.key(), WINDOW_MS[limit.window], now, prune=False)
            conn.commit()
            return used
        finally:
            conn.close()

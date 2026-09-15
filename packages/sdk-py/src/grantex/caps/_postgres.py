"""Postgres caps backend: row locks serialize reservations per counter.

A reservation runs in one READ COMMITTED transaction. It makes sure a row
exists per counter in ``grantex_cap_counters`` and locks those rows in a fixed
order (so concurrent reservations cannot deadlock). It then prunes and sums
the counter's reservations in ``grantex_cap_reservations`` and inserts the new
reservation only if every limit holds. Time comes from the database
(``clock_timestamp()``) unless a clock is injected for tests.

Rows carry a SHA-256-derived hash of the tenant id, not the tenant id, in
``tenant_id``. Isolation comes from that hash being part of every key and
query. Row-level security policies written against plain tenant ids do not
match these rows.

Expired rows are deleted lazily when their counter is next reserved. Run
``prune()`` periodically (for example hourly) to delete expired reservations,
per-case reservations older than ``case_ttl_seconds`` if one is set, and
counters with no reservations left.

The backend is driver-neutral: ``connection_factory`` returns a DB-API 2.0
connection using the ``format`` parameter style (``%s``), such as pg8000 or
psycopg. Create the tables with ``SCHEMA_SQL`` (idempotent) through your own
migration tool. The TypeScript SDK uses the same tables and statements.
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
"""

_NOW_SQL = "SELECT CASE WHEN %s::bigint IS NULL THEN clock_timestamp() ELSE to_timestamp(%s::bigint / 1000.0) END"
_LOCK_ATTEMPTS = 3


class PostgresCapsBackend:
    """Caps counters in Postgres.

    ``case_ttl_seconds`` optionally lets ``prune()`` delete per-case
    reservations that old; by default they are kept, because deleting them
    would reset the per-case cap.
    """

    def __init__(self, connection_factory: Callable[[], Any], *, case_ttl_seconds: Optional[int] = None) -> None:
        if case_ttl_seconds is not None and (
            isinstance(case_ttl_seconds, bool) or not isinstance(case_ttl_seconds, int) or case_ttl_seconds <= 0
        ):
            raise ValueError("case_ttl_seconds must be a positive integer")
        self._connect = connection_factory
        self._case_ttl_seconds = case_ttl_seconds

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

    @staticmethod
    def _lock_counters(cur: Any, tenant: str, limits: Sequence[CapLimit]) -> List[Tuple[CapLimit, str]]:
        ordered = sorted(((limit, limit.key()) for limit in limits), key=lambda item: item[1])
        for _, key in ordered:
            for _attempt in range(_LOCK_ATTEMPTS):
                cur.execute(
                    "INSERT INTO grantex_cap_counters (tenant_id, counter_key) VALUES (%s, %s) "
                    "ON CONFLICT DO NOTHING",
                    (tenant, key),
                )
                cur.execute(
                    "SELECT counter_key FROM grantex_cap_counters "
                    "WHERE tenant_id = %s AND counter_key = %s FOR UPDATE",
                    (tenant, key),
                )
                if cur.fetchone() is not None:
                    break
                # prune() removed an empty counter between the two statements.
            else:
                raise RuntimeError("caps counter row could not be locked")
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

    def _expiry_seconds(self, limit: CapLimit) -> Optional[float]:
        window = WINDOW_MS[limit.window]
        if window > 0:
            return window / 1000.0
        return None if self._case_ttl_seconds is None else float(self._case_ttl_seconds)

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
            # The row locks, not the snapshot, give atomicity: each statement
            # after the lock must see rows committed by the previous holder.
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            ordered = self._lock_counters(cur, tenant, limits)
            # Read the time after the locks are held, so a reservation that
            # waited is judged against the moment it actually runs.
            now = self._now(cur, now_ms)
            for limit, key in ordered:
                used = self._used(cur, tenant, key, WINDOW_MS[limit.window], now, prune=True)
                if used + limit.units > limit.limit:
                    raise CapExceededError(
                        limit=limit.limit, window=limit.window, used=used,
                        requested=limit.units, scope=limit.scope, kind=limit.kind,
                    )
            for limit, key in ordered:
                cur.execute(
                    "INSERT INTO grantex_cap_reservations "
                    "(tenant_id, counter_key, reservation_id, units, reserved_at, expires_at) VALUES "
                    "(%s, %s, %s, %s, %s::timestamptz, "
                    "%s::timestamptz + make_interval(secs => %s::double precision))",
                    (tenant, key, reservation_id, limit.units, now, now, self._expiry_seconds(limit)),
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

    def prune(self, now_ms: Optional[int] = None) -> Tuple[int, int]:
        """Delete expired reservations and counters left empty.

        Returns ``(reservations_deleted, counters_deleted)``. Safe to run while
        reservations are made: counters being reserved are locked and skipped,
        and a counter that still has reservations cannot be deleted (the
        foreign key refuses it, failing this run rather than losing a
        reservation; run it again).
        """
        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
            now = self._now(cur, now_ms)
            cur.execute(
                "DELETE FROM grantex_cap_reservations WHERE expires_at IS NOT NULL AND expires_at <= %s::timestamptz",
                (now,),
            )
            reservations = int(cur.rowcount)
            cur.execute(
                "DELETE FROM grantex_cap_counters WHERE (tenant_id, counter_key) IN ("
                " SELECT c.tenant_id, c.counter_key FROM grantex_cap_counters c"
                " WHERE NOT EXISTS (SELECT 1 FROM grantex_cap_reservations r"
                "   WHERE r.tenant_id = c.tenant_id AND r.counter_key = c.counter_key)"
                " FOR UPDATE SKIP LOCKED)"
            )
            counters = int(cur.rowcount)
            conn.commit()
            return reservations, counters
        except BaseException:
            try:
                conn.rollback()
            except Exception:  # nosec B110
                pass  # the original error is re-raised below
            raise
        finally:
            conn.close()

"""In-process caps backend. **For tests only.**

Counters live in one process's memory: they are not shared between workers,
are lost on restart, and would let a multi-process deployment exceed every
cap. Use the Redis or Postgres backend in any deployment.
"""

from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional, Sequence, Tuple

from ._meter import WINDOW_MS, CapExceededError, CapLimit, tenant_hash

# (tenant hash, counter key) -> list of (reserved_at_ms, reservation id, units)
_Entries = List[Tuple[int, str, int]]


class InMemoryCapsBackend:
    """Thread-safe, single-process counters for unit tests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counters: Dict[Tuple[str, str], _Entries] = {}

    @staticmethod
    def _now(now_ms: Optional[int]) -> int:
        return now_ms if now_ms is not None else int(time.time() * 1000)

    def _live(self, tenant_id: str, limit: CapLimit, now: int) -> _Entries:
        entries = self._counters.setdefault((tenant_hash(tenant_id), limit.key()), [])
        window = WINDOW_MS[limit.window]
        if window > 0:
            entries[:] = [e for e in entries if e[0] > now - window]
        return entries

    def reserve(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        now = self._now(now_ms)
        with self._lock:
            live = [self._live(tenant_id, limit, now) for limit in limits]
            for limit, entries in zip(limits, live):
                used = sum(units for _, _, units in entries)
                if used + limit.units > limit.limit:
                    raise CapExceededError(
                        limit=limit.limit, window=limit.window, used=used,
                        requested=limit.units, scope=limit.scope, kind=limit.kind,
                    )
            for limit, entries in zip(limits, live):
                entries.append((now, reservation_id, limit.units))

    def refund(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        with self._lock:
            for limit in limits:
                entries = self._counters.get((tenant_hash(tenant_id), limit.key()), [])
                entries[:] = [e for e in entries if e[1] != reservation_id]

    def usage(self, tenant_id: str, limit: CapLimit, now_ms: Optional[int]) -> int:
        with self._lock:
            return sum(units for _, _, units in self._live(tenant_id, limit, self._now(now_ms)))

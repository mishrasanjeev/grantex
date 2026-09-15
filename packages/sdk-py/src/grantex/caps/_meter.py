"""Caps meter: atomic reservation of call caps and cost-unit budgets."""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Protocol, Sequence, Tuple

ERROR_CODE = "E1008"
"""Error code for an exceeded cap."""

CAPS_OFF = "off"
"""Caps are not evaluated."""
CAPS_WARN = "warn"
"""Caps are evaluated; a call they would deny is allowed and reported in ``would_deny``."""
CAPS_ENFORCE = "enforce"
"""Caps are evaluated and enforced (the default)."""
CAPS_MODES = (CAPS_OFF, CAPS_WARN, CAPS_ENFORCE)

PER_HOUR = "per_hour"
PER_DAY = "per_day"
PER_CASE = "per_case"

WINDOW_MS: Dict[str, int] = {PER_HOUR: 3_600_000, PER_DAY: 86_400_000, PER_CASE: 0}
"""Rolling window length per window name; ``per_case`` has no time window."""

MAX_COUNT = 2147483647
_TENANT_MAX = 256
_RESERVATION_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}\Z")


class CapExceededError(Exception):
    """A reservation would exceed a cap. ``code`` is ``E1008``.

    ``limit`` and ``window`` identify the cap; ``used`` is what the counter
    already held and ``requested`` what this call asked for.
    """

    code = ERROR_CODE
    reason = "cap_exceeded"

    def __init__(
        self,
        *,
        limit: int,
        window: str,
        used: int,
        requested: int,
        scope: str,
        kind: str,
    ) -> None:
        self.limit = limit
        self.window = window
        self.used = used
        self.requested = requested
        self.scope = scope
        self.kind = kind
        noun = "call" if kind == "calls" else "cost unit"
        super().__init__(
            f"{ERROR_CODE} cap_exceeded: {scope} {window} {noun} cap of {limit} "
            f"reached ({used} used, {requested} requested)"
        )


class MeterUnavailableError(Exception):
    """The caps backend could not answer. Callers must treat the call as denied."""


class CapsConfigurationError(ValueError):
    """Limits or arguments passed to the meter are invalid. ``sub_reason`` names why."""

    def __init__(self, message: str, sub_reason: str = "invalid_limits") -> None:
        super().__init__(message)
        self.sub_reason = sub_reason


@dataclass(frozen=True)
class CapLimit:
    """One counter a call is metered against.

    ``counter`` identifies the counter within a tenant, for example
    ``manifest|acme_kyb|verify_business|calls|per_hour``; per-case counters
    must include the case. Backends store only a hash of it.
    """

    counter: str
    limit: int
    window: str
    units: int = 1
    scope: str = "manifest"
    kind: str = "calls"

    def key(self) -> str:
        """Stable, fixed-length identifier used by backends."""
        return hashlib.sha256(
            f"grantex-caps:v1\0{self.window}\0{self.counter}".encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True)
class Reservation:
    """Units reserved for one call. Keep it to refund a call proven unsent."""

    reservation_id: str
    tenant_id: str
    limits: Tuple[CapLimit, ...]


@dataclass(frozen=True)
class CounterUsage:
    """Units currently held by a counter and what remains under its limit."""

    limit: CapLimit
    used: int

    @property
    def remaining(self) -> int:
        return max(self.limit.limit - self.used, 0)


class CapsBackend(Protocol):
    """Storage for counters. Implementations must be atomic across all limits."""

    def reserve(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        """Reserve every limit or none. Raise ``CapExceededError`` naming the first
        limit that would be exceeded, or any other exception when unavailable."""

    def refund(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        """Remove a reservation. Idempotent."""

    def usage(self, tenant_id: str, limit: CapLimit, now_ms: Optional[int]) -> int:
        """Units currently held by ``limit``'s counter within its window."""


def tenant_hash(tenant_id: str) -> str:
    """Fixed-length tenant component for storage keys."""
    return hashlib.sha256(f"grantex-caps-tenant:v1\0{tenant_id}".encode("utf-8")).hexdigest()[:32]


def _check_count(value: object, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > MAX_COUNT:
        raise CapsConfigurationError(f"{what} must be an integer between 0 and {MAX_COUNT}")
    return value


def validate_limits(tenant_id: object, limits: Sequence[CapLimit]) -> Tuple[CapLimit, ...]:
    """Validate the arguments of a reservation; return the limits to apply."""
    if not isinstance(tenant_id, str) or not tenant_id or len(tenant_id) > _TENANT_MAX:
        raise CapsConfigurationError("tenant_id must be a non-empty string of at most 256 characters")
    checked = []
    seen = set()
    for limit in limits:
        if not isinstance(limit, CapLimit):
            raise CapsConfigurationError("limits must be CapLimit instances")
        if limit.window not in WINDOW_MS:
            raise CapsConfigurationError(f"unknown cap window {limit.window!r}")
        if not isinstance(limit.counter, str) or not limit.counter:
            raise CapsConfigurationError("a cap counter must be a non-empty string")
        _check_count(limit.limit, "a cap limit")
        _check_count(limit.units, "reserved units")
        if limit.key() in seen:
            raise CapsConfigurationError(f"counter {limit.counter!r} appears twice in one reservation")
        seen.add(limit.key())
        checked.append(limit)
    return tuple(checked)


class CapsMeter:
    """Reserve call caps and cost-unit budgets before the call that incurs cost.

    ``reserve()`` checks every limit and records the call atomically, so
    concurrent callers can never exceed a cap. Reservation happens before the
    provider call. A failed call is **not** refunded by default: a timeout or
    error does not prove the provider did no work. Call ``refund_unsent()``
    only when the provider call is known not to have been sent.

    Any backend failure raises ``MeterUnavailableError``; callers must deny.
    """

    def __init__(self, backend: CapsBackend, *, clock: Optional[Callable[[], int]] = None) -> None:
        self._backend = backend
        self._clock = clock

    def _now(self) -> Optional[int]:
        return None if self._clock is None else int(self._clock())

    def reserve(self, tenant_id: str, limits: Sequence[CapLimit]) -> Reservation:
        """Reserve ``limits`` for one call.

        Raises:
            CapExceededError: a limit would be exceeded; nothing was reserved.
            MeterUnavailableError: the backend failed; treat as denied.
            CapsConfigurationError: the arguments are invalid.
        """
        checked = validate_limits(tenant_id, limits)
        applied = tuple(limit for limit in checked if limit.units > 0)
        for limit in applied:
            if limit.limit == 0:
                # A cap of zero disables the tool, whatever the backend holds.
                raise CapExceededError(
                    limit=0, window=limit.window, used=0,
                    requested=limit.units, scope=limit.scope, kind=limit.kind,
                )
            if limit.units > limit.limit:
                # This call alone exceeds the cap; report what the counter holds.
                try:
                    used = self._backend.usage(tenant_id, limit, self._now())
                except Exception as exc:
                    raise MeterUnavailableError(
                        f"caps backend unavailable: {type(exc).__name__}"
                    ) from exc
                raise CapExceededError(
                    limit=limit.limit, window=limit.window, used=used,
                    requested=limit.units, scope=limit.scope, kind=limit.kind,
                )
        reservation = Reservation(
            reservation_id=secrets.token_hex(16), tenant_id=tenant_id, limits=applied
        )
        if not applied:
            return reservation
        try:
            self._backend.reserve(tenant_id, reservation.reservation_id, applied, self._now())
        except CapExceededError:
            raise
        except Exception as exc:
            raise MeterUnavailableError(f"caps backend unavailable: {type(exc).__name__}") from exc
        return reservation

    def refund_unsent(self, reservation: Reservation) -> None:
        """Release a reservation whose provider call was proven not sent.

        Do not call this for a call that failed or timed out after it may have
        reached the provider.
        """
        if not _RESERVATION_RE.match(reservation.reservation_id):
            raise CapsConfigurationError("invalid reservation id")
        if not reservation.limits:
            return
        try:
            self._backend.refund(
                reservation.tenant_id, reservation.reservation_id, reservation.limits, self._now()
            )
        except Exception as exc:
            raise MeterUnavailableError(f"caps backend unavailable: {type(exc).__name__}") from exc

    def usage(self, tenant_id: str, limits: Sequence[CapLimit]) -> Tuple[CounterUsage, ...]:
        """Current usage of each counter, for display (consent page, case view)."""
        checked = validate_limits(tenant_id, limits)
        try:
            return tuple(
                CounterUsage(limit=limit, used=self._backend.usage(tenant_id, limit, self._now()))
                for limit in checked
            )
        except Exception as exc:
            raise MeterUnavailableError(f"caps backend unavailable: {type(exc).__name__}") from exc

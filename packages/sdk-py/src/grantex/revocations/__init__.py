"""Revocation checking for ``enforce()`` (PRD G-6).

- ``online`` (default): ask the auth service about the grant on every call.
  Simplest, slowest, and denies when the service cannot be reached.
- ``feed``: follow the revocation feed and keep an in-memory set of revoked
  grants and tokens. Denies within seconds of a revocation, with no network
  call on the hot path, and fails closed when the feed goes stale.
- ``offline``: no check, the explicit opt-out. A revoked grant's token stays
  cryptographically valid until it expires.

``REVOCATION_CHECK_STRENGTH`` orders the modes by how soon a revocation is
seen: ``offline`` never, ``feed`` within its staleness bound, ``online`` on
the next call. A per-call ``revocation_check`` may only be as strict as the
client's mode or stricter.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping, Tuple

from ._feed import (
    DEFAULT_RECONNECT_DELAY,
    DEFAULT_STALE_AFTER,
    FeedUnavailableReason,
    RevocationFeed,
    RevocationFeedState,
)
from ._set import RevocationAction, RevocationEntry, RevocationMatch, RevokedSet

REVOCATION_CHECK_MODES: Tuple[str, ...] = ("offline", "online", "feed")
DEFAULT_REVOCATION_CHECK = "online"
REVOCATION_CHECK_STRENGTH: Mapping[str, int] = MappingProxyType(
    {"offline": 0, "feed": 1, "online": 2}
)


def is_revocation_check_mode(value: object) -> bool:
    return isinstance(value, str) and value in REVOCATION_CHECK_MODES


__all__ = [
    "DEFAULT_RECONNECT_DELAY",
    "DEFAULT_REVOCATION_CHECK",
    "DEFAULT_STALE_AFTER",
    "REVOCATION_CHECK_MODES",
    "REVOCATION_CHECK_STRENGTH",
    "FeedUnavailableReason",
    "RevocationAction",
    "RevocationEntry",
    "RevocationFeed",
    "RevocationFeedState",
    "RevocationMatch",
    "RevokedSet",
    "is_revocation_check_mode",
]

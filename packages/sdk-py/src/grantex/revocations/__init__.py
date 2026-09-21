"""Revocation checking for ``enforce()`` (PRD G-6).

- ``offline`` (default): no check. A revoked grant's token stays
  cryptographically valid until it expires, which is why the other two modes
  exist.
- ``feed``: follow the revocation feed and keep an in-memory set of revoked
  grants and tokens. Denies within seconds of a revocation, with no network
  call on the hot path, and fails closed when the feed goes stale.
- ``online``: ask the auth service about the grant on every call. Simplest,
  slowest, and denies when the service cannot be reached.
"""

from __future__ import annotations

from typing import Tuple

from ._feed import (
    DEFAULT_RECONNECT_DELAY,
    DEFAULT_STALE_AFTER,
    FeedUnavailableReason,
    RevocationFeed,
    RevocationFeedState,
)
from ._set import RevocationAction, RevocationEntry, RevocationMatch, RevokedSet

REVOCATION_CHECK_MODES: Tuple[str, ...] = ("offline", "online", "feed")


def is_revocation_check_mode(value: object) -> bool:
    return isinstance(value, str) and value in REVOCATION_CHECK_MODES


__all__ = [
    "DEFAULT_RECONNECT_DELAY",
    "DEFAULT_STALE_AFTER",
    "REVOCATION_CHECK_MODES",
    "FeedUnavailableReason",
    "RevocationAction",
    "RevocationEntry",
    "RevocationFeed",
    "RevocationFeedState",
    "RevocationMatch",
    "RevokedSet",
    "is_revocation_check_mode",
]

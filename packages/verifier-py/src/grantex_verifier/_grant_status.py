# SPDX-License-Identifier: Apache-2.0
"""Where the verifier learns whether a grant is revoked.

Two sources, as the grantex SDKs' ``enforce()`` has (``revocation_check``):

- :class:`OnlineGrantStatus` asks the auth service on every verification,
  ``GET /v1/revocations/status?grantId=&jti=`` (the endpoint the SDKs'
  ``online`` mode reads), through a ``get`` function the caller injects;
- :class:`FeedGrantStatus` reads a ``grantex.revocations.RevocationFeed``
  (or anything with its ``state()`` and ``match()``) and trusts it only
  within 10 seconds of its last heartbeat (PRD section 9).

Both answer ``unknown`` when they cannot tell, and the verifier refuses an
``unknown`` grant (``status_stale``): an unknown revocation state is never a
pass.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, Protocol
from urllib.parse import quote

from ._staleness import FEED_FAIL_CLOSED_SECONDS

GRANT_STATES = ("active", "revoked", "suspended", "unknown")


@dataclass(frozen=True)
class GrantStatus:
    """``state`` is ``active``, ``revoked``, ``suspended`` or ``unknown``;
    ``checked_at`` is when the source last knew it (UNIX seconds)."""

    state: str
    checked_at: float
    detail: str = ""

    def __post_init__(self) -> None:
        if self.state not in GRANT_STATES:
            raise ValueError("state must be one of " + ", ".join(GRANT_STATES))


class GrantStatusSource(Protocol):
    def grant_status(
        self, *, grant_id: str, token_id: str, parent_grant_id: Optional[str]
    ) -> GrantStatus:
        """The grant's revocation state. May raise; the verifier then refuses."""
        ...


class OnlineGrantStatus:
    """The auth service's revocation status endpoint, read on every call.

    ``get`` takes the path and query and returns the decoded JSON body, for
    example a function around your HTTP client that sends your developer API
    key. It may raise; the verifier refuses the grant (``status_stale``).
    """

    def __init__(self, get: Callable[[str], Any], *, clock: Callable[[], float] = time.time) -> None:
        self._get = get
        self._clock = clock

    def grant_status(
        self, *, grant_id: str, token_id: str, parent_grant_id: Optional[str]
    ) -> GrantStatus:
        query = []
        if grant_id:
            query.append("grantId=" + quote(grant_id, safe=""))
        if token_id:
            query.append("jti=" + quote(token_id, safe=""))
        answer = self._get("/v1/revocations/status?" + "&".join(query))
        now = self._clock()
        if not isinstance(answer, dict) or not isinstance(answer.get("revoked"), bool):
            # An answer this client cannot read is not a live grant.
            return GrantStatus("unknown", now, "the revocation status answer is unreadable")
        if not answer["revoked"]:
            return GrantStatus("active", now)
        state = str(answer.get("status", "revoked"))
        if state == "suspended":
            return GrantStatus("suspended", now)
        if state == "unknown":
            return GrantStatus("unknown", now, "the auth service does not recognise this grant")
        return GrantStatus("revoked", now)


class FeedGrantStatus:
    """A revocation feed, trusted within 10 seconds of its last heartbeat.

    ``feed`` is a ``grantex.revocations.RevocationFeed`` or has its interface:
    ``state()`` with ``synced``, ``unavailable`` and ``fresh_at`` (on
    ``time.monotonic()``), and ``match(grant_id=, token_id=,
    parent_grant_id=)``. The feed sends a heartbeat every second; after 10
    seconds without one the grant's state is ``unknown``.
    """

    def __init__(
        self,
        feed: Any,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._feed = feed
        self._monotonic = monotonic
        self._clock = clock

    def grant_status(
        self, *, grant_id: str, token_id: str, parent_grant_id: Optional[str]
    ) -> GrantStatus:
        state = self._feed.state()
        age = self._monotonic() - float(state.fresh_at)
        checked_at = self._clock() - max(age, 0.0)
        if not state.synced or state.unavailable is not None:
            return GrantStatus("unknown", checked_at, "the revocation feed is not synced")
        if age > FEED_FAIL_CLOSED_SECONDS:
            return GrantStatus(
                "unknown", checked_at, "no revocation feed heartbeat for %.1f s" % age
            )
        found = self._feed.match(
            grant_id=grant_id or None, token_id=token_id or None, parent_grant_id=parent_grant_id
        )
        if found is None:
            return GrantStatus("active", checked_at)
        if getattr(found, "action", None) == "suspended":
            return GrantStatus("suspended", checked_at)
        return GrantStatus("revoked", checked_at, "revoked (%s)" % getattr(found, "kind", "grant"))

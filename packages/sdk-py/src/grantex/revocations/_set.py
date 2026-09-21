"""What the client knows is revoked.

``enforce()`` verifies a grant token offline, so on its own it cannot see a
revocation: the token stays cryptographically valid until it expires. This set
is the answer — a small in-memory index of the grants and tokens the auth
service says are no longer usable, kept current by the revocation feed.
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Optional

RevocationAction = Literal["revoked", "suspended", "resumed", "token_revoked"]


@dataclass(frozen=True)
class RevocationEntry:
    """One entry of the revocation feed."""

    seq: int
    action: RevocationAction
    grant_id: Optional[str]
    jti: Optional[str]
    expires_at: Optional[str]
    at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RevocationEntry":
        return cls(
            seq=int(data.get("seq", 0) or 0),
            action=data.get("action", "revoked"),
            grant_id=data.get("grantId"),
            jti=data.get("jti"),
            expires_at=data.get("expiresAt"),
            at=data.get("at"),
        )


@dataclass(frozen=True)
class RevocationMatch:
    """Why a credential must not be used."""

    kind: Literal["grant", "token", "parent_grant"]
    id: str
    action: RevocationAction


def _timestamp(value: Optional[str]) -> float:
    if not value:
        return math.inf
    try:
        text = value.replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return math.inf


class RevokedSet:
    """The identifiers a client believes are revoked or suspended, with when they expire."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._grants: dict[str, tuple[float, RevocationAction]] = {}
        self._tokens: dict[str, tuple[float, RevocationAction]] = {}

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._grants) + len(self._tokens)

    def apply(self, entry: RevocationEntry) -> None:
        """Apply one feed entry.

        ``resumed`` removes a suspension; a revocation is never undone, and the
        auth service never emits ``resumed`` for one.
        """
        until = _timestamp(entry.expires_at)
        with self._lock:
            if entry.action == "resumed":
                if entry.grant_id:
                    self._grants.pop(entry.grant_id, None)
                return
            if entry.action == "token_revoked":
                if entry.jti:
                    self._tokens[entry.jti] = (until, entry.action)
                return
            if entry.grant_id:
                self._grants[entry.grant_id] = (until, entry.action)

    def apply_all(self, entries: Iterable[RevocationEntry]) -> None:
        for entry in entries:
            self.apply(entry)

    def replace_all(self, entries: Iterable[RevocationEntry]) -> None:
        """Replace everything this set knows with ``entries``.

        A snapshot is the complete list of what is revoked or suspended *now*,
        so applying one on top of an existing set keeps anything that has since
        been resumed: a grant suspended and then resumed while this client was
        disconnected would go on being denied until it expired, because the
        resume entry passed by while nobody was listening and the snapshot
        never mentions it.

        The swap happens under the set's own lock, so a concurrent ``match``
        sees the old contents or the new ones, never an empty set.
        """
        materialised = list(entries)
        with self._lock:
            self._grants.clear()
            self._tokens.clear()
        self.apply_all(materialised)

    def match(
        self,
        *,
        grant_id: Optional[str] = None,
        token_id: Optional[str] = None,
        parent_grant_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> Optional[RevocationMatch]:
        """Why this credential must not be used, or ``None``."""
        moment = now if now is not None else datetime.now(timezone.utc).timestamp()
        with self._lock:
            if grant_id is not None:
                found = self._grants.get(grant_id)
                if found is not None and found[0] > moment:
                    return RevocationMatch(kind="grant", id=grant_id, action=found[1])
            if token_id is not None:
                found = self._tokens.get(token_id)
                if found is not None and found[0] > moment:
                    return RevocationMatch(kind="token", id=token_id, action=found[1])
            # A cascade revokes children too, so a parent entry alone should
            # never decide a call - but honouring it closes the window where a
            # child's own entry has not arrived yet.
            if parent_grant_id is not None:
                found = self._grants.get(parent_grant_id)
                if found is not None and found[0] > moment:
                    return RevocationMatch(kind="parent_grant", id=parent_grant_id, action=found[1])
        return None

    def prune(self, now: Optional[float] = None) -> None:
        """Forget entries whose credential has expired; it cannot be used anyway."""
        moment = now if now is not None else datetime.now(timezone.utc).timestamp()
        with self._lock:
            for key in [key for key, value in self._grants.items() if value[0] <= moment]:
                del self._grants[key]
            for key in [key for key, value in self._tokens.items() if value[0] <= moment]:
                del self._tokens[key]

    def clear(self) -> None:
        with self._lock:
            self._grants.clear()
            self._tokens.clear()

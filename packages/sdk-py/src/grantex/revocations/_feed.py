"""The revocation feed client (PRD G-6).

It takes a snapshot of everything currently revoked, then follows the live
stream in a background thread, so ``enforce()`` can deny a call on a grant that
was revoked seconds ago without a network round trip per call.

The important part is what happens when it cannot keep up. The feed records
when it last heard from the auth service; if that is longer ago than
``stale_after``, it reports itself stale and ``enforce()`` denies rather than
allowing calls on information it knows may be out of date.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Literal, Optional

import httpx

from ._set import RevocationEntry, RevocationMatch, RevokedSet

FeedUnavailableReason = Literal["disabled", "not_ready", "unauthorized", "network"]

DEFAULT_STALE_AFTER = 5.0
DEFAULT_RECONNECT_DELAY = 0.5
_MAX_RECONNECT_DELAY = 30.0
# The stream may sit idle between revocations, but heartbeats arrive often;
# connecting and sending must not hang.
_STREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
_REQUEST_TIMEOUT = httpx.Timeout(10.0)


@dataclass(frozen=True)
class RevocationFeedState:
    """What the feed knows, and whether it can be trusted."""

    synced: bool
    fresh_at: float
    cursor: int
    known: int
    unavailable: Optional[FeedUnavailableReason]


class RevocationFeed:
    """Follows the auth service's revocation feed in a background thread."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        stale_after: float = DEFAULT_STALE_AFTER,
        reconnect_delay: float = DEFAULT_RECONNECT_DELAY,
        transport: Literal["stream", "poll"] = "stream",
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key.strip()}", "Accept": "application/json"}
        self.stale_after = stale_after
        self._reconnect_delay = reconnect_delay
        self._transport = transport
        self._set = RevokedSet()
        self._lock = threading.Lock()
        self._changed = threading.Condition(self._lock)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._synced = False
        self._fresh_at = 0.0
        self._cursor = 0
        self._unavailable: Optional[FeedUnavailableReason] = None
        self._response: Optional[httpx.Response] = None

    # ── state ────────────────────────────────────────────────────────────────

    def state(self) -> RevocationFeedState:
        with self._lock:
            return RevocationFeedState(
                synced=self._synced,
                fresh_at=self._fresh_at,
                cursor=self._cursor,
                known=self._set.size,
                unavailable=self._unavailable,
            )

    def is_fresh(self, now: Optional[float] = None) -> bool:
        """Synced recently enough to be trusted."""
        moment = now if now is not None else time.time()
        with self._lock:
            return (
                self._synced
                and self._unavailable is None
                and moment - self._fresh_at <= self.stale_after
            )

    def match(
        self,
        *,
        grant_id: Optional[str] = None,
        token_id: Optional[str] = None,
        parent_grant_id: Optional[str] = None,
    ) -> Optional[RevocationMatch]:
        """Why this credential must not be used, according to what the feed knows."""
        return self._set.match(
            grant_id=grant_id, token_id=token_id, parent_grant_id=parent_grant_id
        )

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start following the feed. Idempotent."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="grantex-revocation-feed", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Stop following, and forget what was known."""
        self._stop.set()
        with self._lock:
            response = self._response
            thread = self._thread
            self._thread = None
            self._synced = False
            self._fresh_at = 0.0
            self._changed.notify_all()
        if response is not None:
            try:
                response.close()
            except Exception:  # noqa: BLE001 - closing a dead stream is not an error
                pass
        if thread is not None:
            thread.join(timeout=5)
        self._set.clear()

    def ready(self, timeout: Optional[float] = None) -> bool:
        """Wait until the feed is fresh, or the timeout passes.

        Returns whether it is fresh: ``False`` means callers must fail closed.
        """
        self.start()
        deadline = time.time() + (timeout if timeout is not None else self.stale_after)
        while True:
            if self.is_fresh():
                return True
            with self._lock:
                if self._unavailable is not None:
                    return False
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                self._changed.wait(min(remaining, 0.05))
        return self.is_fresh()

    # ── the loop ─────────────────────────────────────────────────────────────

    def _touch(self) -> None:
        with self._lock:
            self._fresh_at = time.time()
            self._unavailable = None
            self._changed.notify_all()

    def _fail(self, reason: FeedUnavailableReason) -> None:
        with self._lock:
            self._unavailable = reason
            self._synced = False
            self._changed.notify_all()

    def _run(self) -> None:
        delay = self._reconnect_delay
        with httpx.Client(headers=self._headers, timeout=_REQUEST_TIMEOUT) as client:
            while not self._stop.is_set():
                try:
                    self._snapshot(client)
                    delay = self._reconnect_delay
                    if self._transport == "stream":
                        self._stream(client)
                    else:
                        self._poll(client)
                except Exception as exc:  # noqa: BLE001 - every failure is a reason to fail closed
                    self._fail(_classify(exc))
                    self._stop.wait(delay)
                    delay = min(delay * 2, _MAX_RECONNECT_DELAY)

    def _snapshot(self, client: httpx.Client) -> None:
        page_token: Optional[str] = None
        cursor = 0
        while True:
            params: dict[str, Any] = {}
            if page_token:
                params["pageToken"] = page_token
            response = client.get(f"{self._base_url}/v1/revocations", params=params)
            response.raise_for_status()
            page = response.json()
            self._set.apply_all(RevocationEntry.from_dict(item) for item in page.get("entries", []))
            cursor = int(page.get("cursor", 0) or 0)
            page_token = page.get("nextPageToken")
            if not page_token:
                break
        self._set.prune()
        with self._lock:
            self._cursor = cursor
            self._synced = True
        self._touch()

    def _stream(self, client: httpx.Client) -> None:
        with self._lock:
            cursor = self._cursor
        with client.stream(
            "GET",
            f"{self._base_url}/v1/revocations/stream",
            params={"since": cursor},
            timeout=_STREAM_TIMEOUT,
        ) as response:
            response.raise_for_status()
            with self._lock:
                self._response = response
            try:
                event = "message"
                data = ""
                for line in response.iter_lines():
                    if self._stop.is_set():
                        return
                    if line == "":
                        self._handle_event(event, data)
                        event, data = "message", ""
                        continue
                    if line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data += line[5:].strip()
            finally:
                with self._lock:
                    self._response = None

    def _handle_event(self, event: str, data: str) -> None:
        if event in ("heartbeat", "ready"):
            self._touch()
            return
        if event != "revocation" or not data:
            return
        try:
            entry = RevocationEntry.from_dict(json.loads(data))
        except (ValueError, TypeError):
            # A line we cannot read is not evidence that nothing is revoked;
            # the next heartbeat decides freshness.
            return
        self._set.apply(entry)
        with self._lock:
            if entry.seq > self._cursor:
                self._cursor = entry.seq
        self._touch()

    def _poll(self, client: httpx.Client) -> None:
        wait = max(1, int(self.stale_after / 2))
        while not self._stop.is_set():
            with self._lock:
                cursor = self._cursor
            response = client.get(
                f"{self._base_url}/v1/revocations",
                params={"since": cursor, "wait": wait},
                timeout=httpx.Timeout(connect=10.0, read=wait + 10.0, write=10.0, pool=10.0),
            )
            response.raise_for_status()
            page = response.json()
            entries = [RevocationEntry.from_dict(item) for item in page.get("entries", [])]
            self._set.apply_all(entries)
            with self._lock:
                self._cursor = max(
                    [int(page.get("cursor", cursor) or cursor), *[entry.seq for entry in entries], cursor]
                )
            self._touch()


def _classify(exc: Exception) -> FeedUnavailableReason:
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status == 404:
        return "disabled"
    if status == 503:
        return "not_ready"
    if status in (401, 403):
        return "unauthorized"
    return "network"

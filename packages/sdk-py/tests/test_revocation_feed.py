"""Revocation checking in enforce() (PRD G-6): the feed, and online checks."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import respx

from grantex import (
    DenialReason,
    Grantex,
    Permission,
    RevocationEntry,
    RevocationSubReason,
    RevokedSet,
    ToolManifest,
)
from grantex._types import VerifiedGrant

BASE_URL = "https://api.grantex.test"


def _entry(**overrides: Any) -> RevocationEntry:
    data: dict[str, Any] = {
        "seq": 1,
        "action": "revoked",
        "grantId": "grnt_child",
        "jti": None,
        "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "at": datetime.now(timezone.utc).isoformat(),
    }
    data.update(overrides)
    return RevocationEntry.from_dict(data)


def _grant(**overrides: Any) -> VerifiedGrant:
    fields: dict[str, Any] = {
        "token_id": "tok_01",
        "grant_id": "grnt_child",
        "principal_id": "user_1",
        "agent_did": "did:grantex:ag_01",
        "developer_id": "dev_1",
        "scopes": ("tool:acme_kyb:read",),
        "issued_at": int(time.time()),
        "expires_at": int(time.time()) + 3600,
    }
    fields.update(overrides)
    return VerifiedGrant(**fields)


def _client(**options: Any) -> Grantex:
    grantex = Grantex(api_key="test_key", base_url=BASE_URL, **options)
    grantex.load_manifest(
        ToolManifest(connector="acme_kyb", tools={"resolve_business": Permission.READ})
    )
    return grantex


def _snapshot(entries: list[RevocationEntry], cursor: int = 5) -> dict[str, Any]:
    return {
        "entries": [
            {
                "seq": entry.seq,
                "action": entry.action,
                "grantId": entry.grant_id,
                "jti": entry.jti,
                "expiresAt": entry.expires_at,
                "at": entry.at,
            }
            for entry in entries
        ],
        "cursor": cursor,
        "nextPageToken": None,
        "snapshot": True,
    }


def _sse(events: list[tuple[str, Any]]) -> bytes:
    body = ""
    for event, data in events:
        body += f"event: {event}\ndata: {json.dumps(data)}\n\n"
    return body.encode("utf-8")


def _route_feed(entries: list[RevocationEntry]) -> None:
    respx.get(f"{BASE_URL}/v1/revocations").mock(
        return_value=httpx.Response(200, json=_snapshot(entries))
    )
    respx.get(f"{BASE_URL}/v1/revocations/stream").mock(
        return_value=httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=_sse([("ready", {"cursor": 5}), ("heartbeat", {"cursor": 5})]),
        )
    )


# ── What the client knows is revoked ─────────────────────────────────────────


def test_revoked_set_remembers_revocations_and_forgets_a_resumed_grant() -> None:
    revoked = RevokedSet()
    revoked.apply(_entry(grantId="grnt_a"))
    revoked.apply(_entry(seq=2, action="suspended", grantId="grnt_b"))
    revoked.apply(_entry(seq=3, action="token_revoked", grantId="grnt_c", jti="tok_c"))

    grant_a = revoked.match(grant_id="grnt_a")
    grant_b = revoked.match(grant_id="grnt_b")
    token_c = revoked.match(token_id="tok_c")
    assert grant_a is not None and grant_a.action == "revoked"
    assert grant_b is not None and grant_b.action == "suspended"
    assert token_c is not None and token_c.kind == "token"
    # The token's grant itself is not revoked.
    assert revoked.match(grant_id="grnt_c") is None

    revoked.apply(_entry(seq=4, action="resumed", grantId="grnt_b"))
    assert revoked.match(grant_id="grnt_b") is None


def test_revoked_set_denies_a_child_whose_parent_is_revoked() -> None:
    revoked = RevokedSet()
    revoked.apply(_entry(grantId="grnt_parent"))
    found = revoked.match(grant_id="grnt_child", parent_grant_id="grnt_parent")
    assert found is not None
    assert found.kind == "parent_grant"


def test_revoked_set_forgets_entries_whose_credential_expired() -> None:
    revoked = RevokedSet()
    past = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    revoked.apply(_entry(grantId="grnt_old", expiresAt=past))
    assert revoked.match(grant_id="grnt_old") is None
    assert revoked.size == 1
    revoked.prune()
    assert revoked.size == 0


# ── enforce(revocation_check="feed") ─────────────────────────────────────────


@respx.mock
def test_feed_allows_while_fresh_and_knowing_nothing_against_the_grant() -> None:
    _route_feed([])
    grantex = _client(revocation_check="feed")
    try:
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.allowed is True
        state = grantex.revocation_feed_state()
        assert state is not None and state.synced is True
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_feed_denies_a_revoked_grant_with_grant_revoked() -> None:
    _route_feed([_entry()])
    grantex = _client(revocation_check="feed")
    try:
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.allowed is False
        assert result.reason_code == DenialReason.GRANT_REVOKED
        assert result.sub_reason == RevocationSubReason.REVOKED
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_feed_denies_a_child_when_only_the_parent_revocation_has_arrived() -> None:
    _route_feed([_entry(grantId="grnt_parent")])
    grantex = _client(revocation_check="feed")
    try:
        with patch(
            "grantex._client.verify_grant_token",
            return_value=_grant(parent_grant_id="grnt_parent"),
        ):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.sub_reason == RevocationSubReason.PARENT_REVOKED
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_feed_denies_a_suspended_grant_with_its_own_sub_reason() -> None:
    _route_feed([_entry(action="suspended")])
    grantex = _client(revocation_check="feed")
    try:
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.sub_reason == RevocationSubReason.SUSPENDED
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_feed_fails_closed_when_the_deployment_does_not_serve_it() -> None:
    respx.get(f"{BASE_URL}/v1/revocations").mock(
        return_value=httpx.Response(404, json={"message": "Not found"})
    )
    grantex = _client(revocation_check="feed", revocation_feed_stale_after=0.2)
    try:
        feed = grantex.revocation_feed()
        deadline = time.time() + 5
        while feed.state().unavailable is None and time.time() < deadline:
            time.sleep(0.02)
        assert feed.state().unavailable == "disabled"
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.allowed is False
        assert result.reason_code == DenialReason.GRANT_REVOKED
        assert result.sub_reason == RevocationSubReason.FEED_UNAVAILABLE
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_feed_fails_closed_when_it_cannot_be_reached() -> None:
    respx.get(f"{BASE_URL}/v1/revocations").mock(side_effect=httpx.ConnectError("unreachable"))
    grantex = _client(revocation_check="feed", revocation_feed_stale_after=0.2)
    try:
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.allowed is False
        assert result.sub_reason in (
            RevocationSubReason.FEED_STALE,
            RevocationSubReason.FEED_UNAVAILABLE,
        )
    finally:
        grantex.stop_revocation_feed()


@respx.mock
def test_revocation_checking_is_off_by_default() -> None:
    route = respx.get(f"{BASE_URL}/v1/revocations").mock(
        return_value=httpx.Response(200, json=_snapshot([_entry()]))
    )
    grantex = _client()
    with patch("grantex._client.verify_grant_token", return_value=_grant()):
        result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
    assert result.allowed is True
    assert route.call_count == 0


@respx.mock
def test_feed_applies_an_entry_that_arrives_on_the_stream() -> None:
    _route_feed([])
    grantex = _client(revocation_check="feed")
    try:
        feed = grantex.revocation_feed()
        assert feed.ready(timeout=2.0) is True
        # What the stream reader does with one event, without racing a thread.
        feed._handle_event("revocation", json.dumps({
            "seq": 6,
            "action": "revoked",
            "grantId": "grnt_child",
            "jti": None,
            "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            "at": datetime.now(timezone.utc).isoformat(),
        }))
        with patch("grantex._client.verify_grant_token", return_value=_grant()):
            result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
        assert result.allowed is False
        assert result.sub_reason == RevocationSubReason.REVOKED
        assert feed.state().cursor == 6
    finally:
        grantex.stop_revocation_feed()


# ── enforce(revocation_check="online") ───────────────────────────────────────


@respx.mock
def test_online_asks_the_auth_service_and_allows_an_active_grant() -> None:
    route = respx.get(f"{BASE_URL}/v1/revocations/status").mock(
        return_value=httpx.Response(200, json={"status": "active", "revoked": False})
    )
    grantex = _client(revocation_check="online")
    with patch("grantex._client.verify_grant_token", return_value=_grant()):
        result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
    assert result.allowed is True
    url = str(route.calls[0].request.url)
    assert "grantId=grnt_child" in url
    assert "jti=tok_01" in url


@pytest.mark.parametrize(
    ("status", "sub_reason"),
    [
        ("revoked", RevocationSubReason.REVOKED),
        ("suspended", RevocationSubReason.SUSPENDED),
        ("expired", RevocationSubReason.REVOKED),
        ("unknown", RevocationSubReason.STATUS_UNAVAILABLE),
    ],
)
@respx.mock
def test_online_denies_everything_the_service_says_is_not_usable(
    status: str, sub_reason: str
) -> None:
    respx.get(f"{BASE_URL}/v1/revocations/status").mock(
        return_value=httpx.Response(200, json={"status": status, "revoked": True})
    )
    grantex = _client(revocation_check="online")
    with patch("grantex._client.verify_grant_token", return_value=_grant()):
        result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
    assert result.allowed is False
    assert result.reason_code == DenialReason.GRANT_REVOKED
    assert result.sub_reason == sub_reason


@respx.mock
def test_online_denies_when_the_check_cannot_be_made() -> None:
    respx.get(f"{BASE_URL}/v1/revocations/status").mock(
        side_effect=httpx.ConnectError("unreachable")
    )
    grantex = Grantex(
        api_key="test_key", base_url=BASE_URL, revocation_check="online", max_retries=0
    )
    grantex.load_manifest(
        ToolManifest(connector="acme_kyb", tools={"resolve_business": Permission.READ})
    )
    with patch("grantex._client.verify_grant_token", return_value=_grant()):
        result = grantex.enforce("jwt", "acme_kyb", "resolve_business")
    assert result.allowed is False
    assert result.sub_reason == RevocationSubReason.STATUS_UNAVAILABLE


@respx.mock
def test_the_mode_can_be_chosen_per_call() -> None:
    respx.get(f"{BASE_URL}/v1/revocations/status").mock(
        return_value=httpx.Response(200, json={"status": "revoked", "revoked": True})
    )
    grantex = _client()
    with patch("grantex._client.verify_grant_token", return_value=_grant()):
        assert grantex.enforce("jwt", "acme_kyb", "resolve_business").allowed is True
        denied = grantex.enforce(
            "jwt", "acme_kyb", "resolve_business", revocation_check="online"
        )
    assert denied.allowed is False
    assert denied.reason_code == DenialReason.GRANT_REVOKED


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(ValueError, match="revocation_check"):
        Grantex(api_key="test_key", base_url=BASE_URL, revocation_check="sometimes")

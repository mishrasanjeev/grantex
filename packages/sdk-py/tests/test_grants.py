"""Tests for GrantsClient."""
from __future__ import annotations

import json
import pytest
import respx
import httpx

from grantex import Grantex, GrantexTokenError
from grantex._types import ListGrantsParams
from tests.conftest import MOCK_GRANT, MOCK_JWT_PAYLOAD


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


def _make_fake_jwt(payload: dict) -> str:
    """Build a minimal dot-separated fake JWT string for decode mocking."""
    import base64
    import json

    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{body}.fakesig"


@respx.mock
def test_get(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/grants/grant_01HXYZ").mock(
        return_value=httpx.Response(200, json=MOCK_GRANT)
    )
    grant = client.grants.get("grant_01HXYZ")
    assert grant.id == "grant_01HXYZ"
    assert grant.status == "active"


@respx.mock
def test_list(client: Grantex) -> None:
    payload = {
        "grants": [MOCK_GRANT],
    }
    respx.get("https://api.grantex.dev/v1/grants").mock(
        return_value=httpx.Response(200, json=payload)
    )
    response = client.grants.list()
    assert len(response.grants) == 1


@respx.mock
def test_list_with_query_params(client: Grantex) -> None:
    payload = {"grants": []}
    route = respx.get("https://api.grantex.dev/v1/grants").mock(
        return_value=httpx.Response(200, json=payload)
    )
    params = ListGrantsParams(agent_id="ag_01HXYZ123abc", status="active")
    client.grants.list(params)

    url = str(route.calls[0].request.url)
    assert "agentId=ag_01HXYZ123abc" in url
    assert "status=active" in url


@respx.mock
def test_revoke_delete(client: Grantex) -> None:
    respx.delete("https://api.grantex.dev/v1/grants/grant_01HXYZ").mock(
        return_value=httpx.Response(204)
    )
    result = client.grants.revoke("grant_01HXYZ")
    assert result is None


@respx.mock
def test_verify_returns_verified_grant(client: Grantex) -> None:
    server_claims = {
        "iss": "https://api.grantex.dev",
        "sub": "user_abc123",
        "agt": "did:grantex:ag_01HXYZ123abc",
        "dev": "org_test",
        "scp": ["calendar:read"],
        "iat": 1709000000,
        "exp": 9999999999,
        "jti": "tok_01HXYZ987xyz",
        "grnt": "grant_01HXYZ",
    }
    respx.post("https://api.grantex.dev/v1/grants/verify").mock(
        return_value=httpx.Response(200, json={"active": True, "claims": server_claims})
    )
    grant = client.grants.verify("any.caller.supplied.token")
    assert grant.token_id == "tok_01HXYZ987xyz"
    assert grant.grant_id == "grant_01HXYZ"
    assert grant.principal_id == "user_abc123"
    assert grant.scopes == ("calendar:read",)


@respx.mock
def test_verify_raises_when_inactive(client: Grantex) -> None:
    from grantex import GrantexTokenError

    respx.post("https://api.grantex.dev/v1/grants/verify").mock(
        return_value=httpx.Response(200, json={"active": False, "reason": "revoked"})
    )
    with pytest.raises(GrantexTokenError, match="revoked"):
        client.grants.verify("any.caller.supplied.token")


def _build_verified_grant():
    from grantex._types import VerifiedGrant

    return VerifiedGrant(
        token_id="tok_01HXYZ987xyz",
        grant_id="grant_01HXYZ",
        principal_id="user_abc123",
        agent_did="did:grantex:ag_01HXYZ123abc",
        developer_id="org_test",
        scopes=("calendar:read",),
        issued_at=1709000000,
        expires_at=9999999999,
    )


@respx.mock
def test_delegate_posts_to_endpoint(client: Grantex) -> None:
    delegate_response = {
        "grantToken": "delegated.jwt.token",
        "expiresAt": "2026-03-01T00:00:00Z",
        "scopes": ["calendar:read"],
        "grantId": "grnt_DELEGATED01",
    }
    route = respx.post("https://api.grantex.dev/v1/grants/delegate").mock(
        return_value=httpx.Response(201, json=delegate_response)
    )
    result = client.grants.delegate(
        parent_grant_token="parent.jwt.token",
        sub_agent_id="ag_sub01",
        scopes=["calendar:read"],
        expires_in="1h",
    )

    assert result["grantToken"] == "delegated.jwt.token"
    assert result["scopes"] == ["calendar:read"]
    assert result["grantId"] == "grnt_DELEGATED01"

    body = json.loads(route.calls[0].request.content)
    assert body["parentGrantToken"] == "parent.jwt.token"
    assert body["subAgentId"] == "ag_sub01"
    assert body["scopes"] == ["calendar:read"]
    assert body["expiresIn"] == "1h"

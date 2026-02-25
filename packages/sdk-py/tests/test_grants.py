"""Tests for GrantsClient."""
from __future__ import annotations

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
        "total": 1,
        "page": 1,
        "pageSize": 20,
    }
    respx.get("https://api.grantex.dev/v1/grants").mock(
        return_value=httpx.Response(200, json=payload)
    )
    response = client.grants.list()
    assert response.total == 1
    assert len(response.grants) == 1


@respx.mock
def test_list_with_query_params(client: Grantex) -> None:
    payload = {"grants": [], "total": 0, "page": 1, "pageSize": 20}
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
def test_verify_returns_verified_grant(
    client: Grantex, mocker: pytest.FixtureRequest
) -> None:
    fake_token = _make_fake_jwt(MOCK_JWT_PAYLOAD)
    respx.post("https://api.grantex.dev/v1/grants/verify").mock(
        return_value=httpx.Response(200, json={"token": fake_token})
    )
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._map_online_verify_to_verified_grant",
        return_value=_build_verified_grant(),
    )
    grant = client.grants.verify(fake_token)
    assert grant.token_id == "tok_01HXYZ987xyz"
    assert grant.grant_id == "grant_01HXYZ"


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

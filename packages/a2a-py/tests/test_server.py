"""Tests for A2A server auth middleware."""

import base64
import json
import time
from types import SimpleNamespace

import pytest
from grantex import GrantexTokenError

from grantex_a2a._server import create_a2a_auth_middleware, A2AAuthError
from grantex_a2a._types import A2AAuthMiddlewareOptions


def _make_token(payload: dict) -> str:
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
    ).decode().rstrip("=")
    body = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(b"test-signature").decode().rstrip("=")
    return f"{header}.{body}.{sig}"


def _valid_payload(**overrides):
    base = {
        "iss": "https://grantex.dev",
        "sub": "user_123",
        "agt": "did:grantex:ag_TEST",
        "dev": "dev_TEST",
        "scp": ["read", "write"],
        "jti": "tok_TEST",
        "grnt": "grnt_TEST",
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    base.update(overrides)
    return base


def _verified_grant_from_token(token: str, options) -> SimpleNamespace:
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    except Exception as exc:
        raise GrantexTokenError("invalid signature") from exc

    if payload.get("exp", 0) < int(time.time()):
        raise GrantexTokenError("Grant token expired")

    required_scopes = options.required_scopes or []
    scopes = list(payload.get("scp", []))
    missing = [scope for scope in required_scopes if scope not in scopes]
    if missing:
        raise GrantexTokenError(
            f"Grant token is missing required scopes: {', '.join(missing)}"
        )

    return SimpleNamespace(
        grant_id=payload.get("grnt") or payload.get("jti", ""),
        agent_did=payload.get("agt", ""),
        principal_id=payload.get("sub", ""),
        developer_id=payload.get("dev", ""),
        scopes=tuple(scopes),
        expires_at=payload.get("exp", 0),
        delegation_depth=payload.get("delegationDepth"),
    )


@pytest.fixture(autouse=True)
def _mock_verify_grant_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "grantex_a2a._server.verify_grant_token",
        _verified_grant_from_token,
    )


def test_valid_token():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    token = _make_token(_valid_payload())
    grant = middleware({"authorization": f"Bearer {token}"})

    assert grant.grant_id == "grnt_TEST"
    assert grant.agent_did == "did:grantex:ag_TEST"
    assert grant.principal_id == "user_123"
    assert grant.developer_id == "dev_TEST"
    assert grant.scopes == ["read", "write"]


def test_missing_auth_header():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    with pytest.raises(A2AAuthError) as exc_info:
        middleware({})
    assert exc_info.value.status_code == 401


def test_non_bearer_auth():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    with pytest.raises(A2AAuthError) as exc_info:
        middleware({"authorization": "Basic dXNlcjpwYXNz"})
    assert exc_info.value.status_code == 401


def test_expired_token():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    token = _make_token(_valid_payload(exp=int(time.time()) - 3600))
    with pytest.raises(A2AAuthError) as exc_info:
        middleware({"authorization": f"Bearer {token}"})
    assert exc_info.value.status_code == 401
    assert "expired" in str(exc_info.value).lower()


def test_invalid_token_format():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    with pytest.raises(A2AAuthError) as exc_info:
        middleware({"authorization": "Bearer not-a-jwt"})
    assert exc_info.value.status_code == 401


def test_missing_required_scopes():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(
            jwks_uri="https://grantex.dev/.well-known/jwks.json",
            required_scopes=["admin"],
        )
    )
    token = _make_token(_valid_payload(scp=["read"]))
    with pytest.raises(A2AAuthError) as exc_info:
        middleware({"authorization": f"Bearer {token}"})
    assert exc_info.value.status_code == 403
    assert "admin" in str(exc_info.value)


def test_all_scopes_present():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(
            jwks_uri="https://grantex.dev/.well-known/jwks.json",
            required_scopes=["read"],
        )
    )
    token = _make_token(_valid_payload())
    grant = middleware({"authorization": f"Bearer {token}"})
    assert "read" in grant.scopes


def test_delegation_depth():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    token = _make_token(_valid_payload(delegationDepth=2))
    grant = middleware({"authorization": f"Bearer {token}"})
    assert grant.delegation_depth == 2


def test_fallback_to_jti():
    middleware = create_a2a_auth_middleware(
        A2AAuthMiddlewareOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    )
    payload = _valid_payload()
    del payload["grnt"]
    token = _make_token(payload)
    grant = middleware({"authorization": f"Bearer {token}"})
    assert grant.grant_id == "tok_TEST"

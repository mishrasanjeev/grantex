"""Tests for verify_grant_token and _map_online_verify_to_verified_grant."""
from __future__ import annotations

import base64
import json

import pytest

from grantex import verify_grant_token, GrantexTokenError
from grantex._types import VerifyGrantTokenOptions, VerifiedGrant
from grantex._verify import _map_online_verify_to_verified_grant
from tests.conftest import MOCK_JWT_PAYLOAD


def _fake_jwt(payload: dict, alg: str = "RS256") -> str:
    """Create a fake (unsigned) JWT string for testing."""
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": alg, "typ": "JWT", "kid": "key-1"}).encode()
    ).rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(
        json.dumps(payload).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{body}.fakesig"


def _make_verified_grant() -> VerifiedGrant:
    return VerifiedGrant(
        token_id=MOCK_JWT_PAYLOAD["jti"],
        grant_id=MOCK_JWT_PAYLOAD["grnt"],
        principal_id=MOCK_JWT_PAYLOAD["sub"],
        agent_did=MOCK_JWT_PAYLOAD["agt"],
        developer_id=MOCK_JWT_PAYLOAD["dev"],
        scopes=tuple(MOCK_JWT_PAYLOAD["scp"]),
        issued_at=MOCK_JWT_PAYLOAD["iat"],
        expires_at=MOCK_JWT_PAYLOAD["exp"],
    )


# ─── verify_grant_token ───────────────────────────────────────────────────────


def test_valid_token_returns_verified_grant(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    expected = _make_verified_grant()

    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key", return_value="mock-key"
    )
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", return_value=MOCK_JWT_PAYLOAD
    )

    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    result = verify_grant_token(token, options)

    assert result.token_id == expected.token_id
    assert result.grant_id == expected.grant_id
    assert result.principal_id == expected.principal_id
    assert result.scopes == expected.scopes


def test_expired_token_raises_token_error(mocker: pytest.FixtureRequest) -> None:
    import jwt as pyjwt

    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key", return_value="mock-key"
    )
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", side_effect=pyjwt.ExpiredSignatureError("Signature has expired")
    )
    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    with pytest.raises(GrantexTokenError, match="expired"):
        verify_grant_token(token, options)


def test_missing_required_scopes_raises_token_error(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key", return_value="mock-key"
    )
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", return_value=MOCK_JWT_PAYLOAD
    )
    options = VerifyGrantTokenOptions(
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        required_scopes=["payments:initiate", "missing:scope"],
    )
    with pytest.raises(GrantexTokenError, match="missing required scopes"):
        verify_grant_token(token, options)


def test_subset_scopes_pass(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key", return_value="mock-key"
    )
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", return_value=MOCK_JWT_PAYLOAD
    )
    options = VerifyGrantTokenOptions(
        jwks_uri="https://grantex.dev/.well-known/jwks.json",
        required_scopes=["calendar:read"],
    )
    result = verify_grant_token(token, options)
    assert "calendar:read" in result.scopes


def test_grnt_fallback_to_jti(mocker: pytest.FixtureRequest) -> None:
    payload_no_grnt = {**MOCK_JWT_PAYLOAD}
    del payload_no_grnt["grnt"]
    token = _fake_jwt(payload_no_grnt)

    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key", return_value="mock-key"
    )
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", return_value=payload_no_grnt
    )
    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    result = verify_grant_token(token, options)
    assert result.grant_id == MOCK_JWT_PAYLOAD["jti"]


def test_hs256_header_raises_token_error() -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD, alg="HS256")
    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    with pytest.raises(GrantexTokenError, match="HS256"):
        verify_grant_token(token, options)


def test_jwks_fetch_failure_raises_token_error(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key",
        side_effect=GrantexTokenError("Failed to fetch JWKS"),
    )
    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    with pytest.raises(GrantexTokenError, match="JWKS"):
        verify_grant_token(token, options)


def test_no_matching_kid_raises_token_error(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "grantex._verify._fetch_signing_key",
        side_effect=GrantexTokenError("No matching RSA key found in JWKS"),
    )
    options = VerifyGrantTokenOptions(jwks_uri="https://grantex.dev/.well-known/jwks.json")
    with pytest.raises(GrantexTokenError, match="RSA key"):
        verify_grant_token(token, options)


# ─── _map_online_verify_to_verified_grant ────────────────────────────────────


def test_decode_without_verify_path(mocker: pytest.FixtureRequest) -> None:
    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", return_value=MOCK_JWT_PAYLOAD
    )
    result = _map_online_verify_to_verified_grant(token)
    assert result.token_id == MOCK_JWT_PAYLOAD["jti"]
    assert result.grant_id == MOCK_JWT_PAYLOAD["grnt"]


def test_decode_error_raises_token_error(mocker: pytest.FixtureRequest) -> None:
    import jwt as pyjwt

    token = _fake_jwt(MOCK_JWT_PAYLOAD)
    mocker.patch(  # type: ignore[attr-defined]
        "jwt.decode", side_effect=pyjwt.DecodeError("invalid token")
    )
    with pytest.raises(GrantexTokenError, match="decode"):
        _map_online_verify_to_verified_grant(token)

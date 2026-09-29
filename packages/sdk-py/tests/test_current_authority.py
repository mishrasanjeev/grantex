"""Execution identity and current-authority denial regressions."""
from dataclasses import replace
from unittest.mock import Mock, patch

import pytest

from grantex import GrantexTokenError, VerifyGrantTokenOptions, verify_grant_token
from grantex._verify import _build_payload, _payload_to_verified_grant
from tests.conftest import MOCK_JWT_PAYLOAD
from tests.test_verify import _fake_jwt


def verify(options: VerifyGrantTokenOptions):
    with patch("grantex._verify._fetch_signing_key", return_value="key"), patch("jwt.decode", return_value=MOCK_JWT_PAYLOAD):
        return verify_grant_token(_fake_jwt(MOCK_JWT_PAYLOAD), options)


def test_authority_checked_each_time_then_revocation_denies():
    local = _payload_to_verified_grant(_build_payload(MOCK_JWT_PAYLOAD))
    callback = Mock(side_effect=[local, RuntimeError("revoked")])
    options = VerifyGrantTokenOptions(jwks_uri="https://issuer.example/.well-known/jwks.json", audience="service", current_authority=callback)
    assert verify(options).principal_id == local.principal_id
    with pytest.raises(GrantexTokenError, match="authority could not"):
        verify(options)
    assert callback.call_count == 2


@pytest.mark.parametrize("field,value", [
    ("issuer", "https://other.example"), ("audience", "other-service"),
    ("token_id", "other"), ("grant_id", "other"), ("principal_id", "other"),
    ("agent_did", "other"), ("developer_id", "other"), ("issued_at", 1),
    ("expires_at", 2), ("scopes", ("admin:all",)),
])
def test_authority_must_match_verified_token(field, value):
    local = _payload_to_verified_grant(_build_payload(MOCK_JWT_PAYLOAD))
    options = VerifyGrantTokenOptions(jwks_uri="https://issuer.example/.well-known/jwks.json", audience="service", current_authority=lambda _: replace(local, **{field: value}))
    with pytest.raises(GrantexTokenError, match="does not match"):
        verify(options)


@pytest.mark.parametrize("option,value", [
    ("audience", None), ("expected_principal_id", "another-human"),
    ("expected_agent_did", "did:grantex:another"),
])
def test_host_binding_denied_before_authority(option, value):
    callback = Mock()
    options = VerifyGrantTokenOptions(jwks_uri="https://issuer.example/.well-known/jwks.json", audience="service", current_authority=callback)
    setattr(options, option, value)
    with pytest.raises(GrantexTokenError):
        verify(options)
    callback.assert_not_called()


@pytest.mark.parametrize("field", ["jti", "sub"])
def test_empty_required_identity_is_denied(field):
    with pytest.raises(GrantexTokenError):
        _build_payload({**MOCK_JWT_PAYLOAD, field: ""})

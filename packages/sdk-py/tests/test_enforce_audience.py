# SPDX-License-Identifier: Apache-2.0
"""enforce() checks the grant token's audience (RFC 7519 section 4.1.3).

A token that names an audience is only for that relying party. enforce()
denies a token that carries ``aud`` when the client has no expected audience
(``audience_unconfigured``), and a token whose ``aud`` does not contain the
expected audience (``audience_mismatch``). ``audience_check="off"`` restores
the earlier behaviour, which ignored ``aud``.

The cases in spec/examples/enforce-audience.json are shared with the
TypeScript SDK, @grantex/gateway and @grantex/adapters.
"""
from __future__ import annotations

import json
import time
import warnings
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm

from grantex import DenialReason, Grantex, TokenSubReason, ToolManifest
from grantex._types import VerifiedGrant
from tests.conftest import serve_jwks

CASES: List[Dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "enforce-audience.json").read_text(
        encoding="utf-8"
    )
)["cases"]

MANIFEST = ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"get_case": "read"}})
MERCHANT = "https://api.merchant.example"


def _grant(aud: Any) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="shopper-01",
        agent_did="did:grantex:ag_01", developer_id="dev_01",
        scopes=("tool:acme_kyb:read",), issued_at=1709000000, expires_at=9999999999,
        audience=aud,
    )


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        yield mock


def _client(**options: Any) -> Grantex:
    c = Grantex(api_key="test-key", **options)
    c.load_manifest(MANIFEST)
    return c


def _outcome(result: Any) -> str:
    if result.allowed:
        return "allow"
    assert result.reason_code == DenialReason.TOKEN_INVALID
    return str(result.sub_reason)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_audience_cases(case: Dict[str, Any], verify: MagicMock) -> None:
    verify.return_value = _grant(case["aud"])
    options: Dict[str, Any] = {"audience_check": case["audience_check"]}
    if case["client_audience"] is not None:
        options["audience"] = case["client_audience"]
    call: Dict[str, Any] = {}
    if case["call_audience"] is not None:
        call["audience"] = case["call_audience"]
    result = _client(**options).enforce("t", "acme_kyb", "get_case", **call)
    assert _outcome(result) == case["expect"]


def test_enforce_denies_aud_token_without_configured_audience(verify: MagicMock) -> None:
    verify.return_value = _grant(MERCHANT)
    result = _client().enforce("t", "acme_kyb", "get_case")
    assert (result.allowed, result.reason_code, result.sub_reason) == (
        False, DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_UNCONFIGURED,
    )
    assert result.details == {"token_audience": [MERCHANT]}
    assert result.grant_id == "grnt_01"


def test_enforce_denies_audience_mismatch(verify: MagicMock) -> None:
    verify.return_value = _grant(["https://api.provider.example"])
    result = _client(audience=MERCHANT).enforce("t", "acme_kyb", "get_case")
    assert (result.allowed, result.reason_code, result.sub_reason) == (
        False, DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_MISMATCH,
    )
    assert result.details == {
        "expected_audience": MERCHANT,
        "token_audience": ["https://api.provider.example"],
    }


def test_enforce_denies_a_token_without_aud_when_an_audience_is_expected(verify: MagicMock) -> None:
    verify.return_value = _grant(None)
    result = _client(audience=MERCHANT).enforce("t", "acme_kyb", "get_case")
    assert (result.allowed, result.sub_reason) == (False, TokenSubReason.AUDIENCE_MISMATCH)
    assert result.details == {"expected_audience": MERCHANT, "token_audience": []}


def test_enforce_allows_an_array_aud_that_contains_the_audience(verify: MagicMock) -> None:
    verify.return_value = _grant(["https://issuer.example", MERCHANT])
    result = _client(audience=MERCHANT).enforce("t", "acme_kyb", "get_case")
    assert result.allowed is True
    assert (result.reason_code, result.sub_reason) == ("", "")


def test_per_call_audience_overrides_the_client(verify: MagicMock) -> None:
    verify.return_value = _grant("https://tools.merchant.example")
    c = _client(audience=MERCHANT)
    assert c.enforce("t", "acme_kyb", "get_case").sub_reason == TokenSubReason.AUDIENCE_MISMATCH
    assert c.enforce("t", "acme_kyb", "get_case", audience="https://tools.merchant.example").allowed


def test_audience_check_off_restores_the_earlier_behaviour(verify: MagicMock) -> None:
    for aud in (MERCHANT, [MERCHANT, "https://issuer.example"], [], None):
        verify.return_value = _grant(aud)
        result = _client(audience_check="off").enforce("t", "acme_kyb", "get_case")
        assert result.allowed is True
        assert (result.reason_code, result.sub_reason, result.details) == ("", "", {})


def test_audience_is_checked_before_the_revocation_status(verify: MagicMock) -> None:
    # A token for another relying party is refused without asking the auth
    # service about it.
    verify.return_value = _grant("https://api.provider.example")
    c = _client(audience=MERCHANT, revocation_check="online")
    with patch.object(c._http, "get") as get:
        result = c.enforce("t", "acme_kyb", "get_case")
    assert result.sub_reason == TokenSubReason.AUDIENCE_MISMATCH
    get.assert_not_called()


# Permissive mode turns a denial into an allow with a warning. An audience
# denial is a correctly signed token for another relying party (or a client
# that does not know its own audience), so it stays denied in every mode.
@pytest.mark.parametrize(
    ("aud", "options", "sub_reason", "details"),
    [
        (MERCHANT, {}, TokenSubReason.AUDIENCE_UNCONFIGURED, {"token_audience": [MERCHANT]}),
        (
            "https://api.provider.example",
            {"audience": MERCHANT},
            TokenSubReason.AUDIENCE_MISMATCH,
            {"expected_audience": MERCHANT, "token_audience": ["https://api.provider.example"]},
        ),
    ],
    ids=["audience_unconfigured", "audience_mismatch"],
)
def test_permissive_mode_does_not_relax_an_audience_denial(
    aud: Any, options: Dict[str, Any], sub_reason: str, details: Dict[str, Any], verify: MagicMock
) -> None:
    verify.return_value = _grant(aud)
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        result = _client(enforce_mode="permissive", **options).enforce("t", "acme_kyb", "get_case")
    assert (result.allowed, result.reason_code, result.sub_reason) == (
        False, DenialReason.TOKEN_INVALID, sub_reason,
    )
    assert result.details == details
    assert "audience" in result.reason


def test_permissive_mode_still_relaxes_a_scope_denial_once_the_audience_matches(
    verify: MagicMock,
) -> None:
    verify.return_value = _grant(MERCHANT)
    c = Grantex(api_key="test-key", audience=MERCHANT, enforce_mode="permissive")
    c.load_manifest(ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"get_case": "write"}}))
    with pytest.warns(UserWarning, match="would deny"):
        result = c.enforce("t", "acme_kyb", "get_case")
    assert result.allowed is True
    assert result.reason_code == DenialReason.PERMISSION_INSUFFICIENT


@pytest.mark.parametrize("value", ["", "ON", "strict", None, 1, True])
def test_audience_check_accepts_only_on_or_off(value: Any) -> None:
    with pytest.raises(ValueError, match="audience_check"):
        Grantex(api_key="test-key", audience_check=value)


@pytest.mark.parametrize("value", ["", 1, ["https://api.merchant.example"]])
def test_expected_audience_must_be_a_non_empty_string(value: Any, verify: MagicMock) -> None:
    with pytest.raises(ValueError, match="audience"):
        Grantex(api_key="test-key", audience=value)
    verify.return_value = _grant(MERCHANT)
    with pytest.raises(ValueError, match="audience"):
        _client().enforce("t", "acme_kyb", "get_case", audience=value)


def test_an_expected_audience_with_the_check_off_is_refused(verify: MagicMock) -> None:
    # Configuring an audience and switching the check off would silently
    # accept tokens for other relying parties.
    with pytest.raises(ValueError, match="audience_check"):
        Grantex(api_key="test-key", audience=MERCHANT, audience_check="off")
    verify.return_value = _grant(MERCHANT)
    with pytest.raises(ValueError, match="audience_check"):
        _client(audience_check="off").enforce("t", "acme_kyb", "get_case", audience=MERCHANT)


def test_the_new_sub_reasons_are_part_of_the_vocabulary() -> None:
    assert TokenSubReason.AUDIENCE_UNCONFIGURED == "audience_unconfigured"
    assert TokenSubReason.AUDIENCE_MISMATCH == "audience_mismatch"


# ─── Signed tokens, verified end to end ──────────────────────────────────────

ISSUER = "https://issuer.example"
EC_KEY = ec.generate_private_key(ec.SECP256R1())
_JWK: Dict[str, Any] = json.loads(ECAlgorithm.to_jwk(EC_KEY.public_key()))
_JWK.update({"kid": "ES256-1", "alg": "ES256", "use": "sig"})
JWKS = {"keys": [_JWK]}


def _token(aud: Optional[Any]) -> str:
    now = int(time.time())
    claims: Dict[str, Any] = {
        "iss": ISSUER, "sub": "shopper-01", "iat": now, "exp": now + 600,
        "jti": "tok_01", "scope": "tool:acme_kyb:read",
        "urn:grantex:grant": {
            "grant_id": "grnt_01", "agent_did": "did:grantex:ag_01", "developer_id": "dev_01",
        },
    }
    if aud is not None:
        claims["aud"] = aud
    return jwt.encode(claims, EC_KEY, algorithm="ES256", headers={"kid": "ES256-1", "typ": "at+jwt"})


@pytest.fixture()
def jwks(mocker: Any) -> None:
    serve_jwks(mocker, JWKS)


def _signed_client(**options: Any) -> Grantex:
    return _client(base_url=ISSUER, legacy_claims=False, **options)


def test_signed_token_with_array_aud_matches(jwks: None) -> None:
    token = _token(["https://issuer.example", MERCHANT])
    assert _signed_client(audience=MERCHANT).enforce(token, "acme_kyb", "get_case").allowed is True
    denied = _signed_client(audience="https://tools.merchant.example").enforce(token, "acme_kyb", "get_case")
    assert (denied.reason_code, denied.sub_reason) == (
        DenialReason.TOKEN_INVALID, TokenSubReason.AUDIENCE_MISMATCH,
    )


def test_signed_token_with_aud_and_no_configured_audience(jwks: None) -> None:
    token = _token(MERCHANT)
    result = _signed_client().enforce(token, "acme_kyb", "get_case")
    assert result.sub_reason == TokenSubReason.AUDIENCE_UNCONFIGURED
    assert _signed_client(audience_check="off").enforce(token, "acme_kyb", "get_case").allowed is True


def test_signed_token_without_aud_is_unaffected(jwks: None) -> None:
    assert _signed_client().enforce(_token(None), "acme_kyb", "get_case").allowed is True

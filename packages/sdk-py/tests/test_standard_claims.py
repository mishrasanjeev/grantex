"""G-8 standard claims.

A 0.6 grant token validates with stock PyJWT using only standard semantics;
verify_grant_token reads standard claims, legacy aliases behind the
compatibility flag (with a deprecation warning), and refuses disagreement.

The payload is spec/examples/grant-token-0.6.json, which the auth service's
tests issue byte for byte.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
import warnings
from pathlib import Path
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from grantex import (
    GRANT_CLAIM,
    LEGACY_CLAIM_ALIASES,
    DenialReason,
    Grantex,
    GrantexTokenError,
    LegacyClaimsWarning,
    ToolManifest,
    TokenSubReason,
    parse_decision_references,
    verify_grant_token,
)
from grantex._authorization_details import DECISION_DETAIL_TYPE, AuthorizationDetailsError
from grantex._types import VerifiedGrant, VerifyGrantTokenOptions

FIXTURE: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "grant-token-0.6.json").read_text(
        encoding="utf-8"
    )
)
STANDARD: Dict[str, Any] = FIXTURE["standard"]
LEGACY: Dict[str, Any] = FIXTURE["legacy_aliases"]
ISSUER = STANDARD["iss"]
AUDIENCE = STANDARD["aud"]
JWKS_URI = f"{ISSUER}/.well-known/jwks.json"

RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
EC_KEY = ec.generate_private_key(ec.SECP256R1())
DPOP_KEY = ec.generate_private_key(ec.SECP256R1())


def _jwk(key: Any, kid: str, alg: str) -> Dict[str, Any]:
    algorithm = RSAAlgorithm if alg == "RS256" else ECAlgorithm
    data: Dict[str, Any] = json.loads(algorithm.to_jwk(key.public_key()))
    data.update({"kid": kid, "alg": alg, "use": "sig"})
    return data


JWKS = {"keys": [_jwk(RSA_KEY, "RS256-1", "RS256"), _jwk(EC_KEY, "ES256-1", "ES256")]}


def _thumbprint(key: Any) -> str:
    """RFC 7638 JWK SHA-256 thumbprint of an EC P-256 public key."""
    jwk = json.loads(ECAlgorithm.to_jwk(key.public_key()))
    members = {name: jwk[name] for name in ("crv", "kty", "x", "y")}
    digest = hashlib.sha256(json.dumps(members, separators=(",", ":"), sort_keys=True).encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


DPOP_JKT = _thumbprint(DPOP_KEY)


def _claims(extra: Dict[str, Any] | None = None, base: Dict[str, Any] | None = None) -> Dict[str, Any]:
    now = int(time.time())
    return {**(STANDARD if base is None else base), "iat": now, "exp": now + 600, "cnf": {"jkt": DPOP_JKT}, **(extra or {})}


def _sign(payload: Dict[str, Any], alg: str = "ES256", typ: str = "at+jwt") -> str:
    key = EC_KEY if alg == "ES256" else RSA_KEY
    return jwt.encode(payload, key, algorithm=alg, headers={"kid": f"{alg}-1", "typ": typ})


@pytest.fixture(autouse=True)
def _serve_jwks(mocker: Any) -> None:
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = JWKS
    mocker.patch("grantex._verify.httpx.get", return_value=response)


def _verify(token: str, **options: Any) -> VerifiedGrant:
    return verify_grant_token(token, VerifyGrantTokenOptions(jwks_uri=JWKS_URI, **options))


# Tokens issued by the auth service itself (apps/auth-service/tests/grant-token-issued-fixture.test.ts).
ISSUED: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "grant-token-0.6.issued.json").read_text(
        encoding="utf-8"
    )
)


def _serve(mocker: Any, jwks: Dict[str, Any]) -> None:
    response = mocker.Mock()
    response.raise_for_status.return_value = None
    response.json.return_value = jwks
    mocker.patch("grantex._verify.httpx.get", return_value=response)


@pytest.mark.parametrize("name", ["standard_rs256", "standard_es256"])
def test_a_stock_jose_library_validates_the_token_using_only_standard_semantics(name: str) -> None:
    token = ISSUED["tokens"][name]["token"]

    header = jwt.get_unverified_header(token)
    assert header["typ"] == "at+jwt"
    key = jwt.PyJWKSet.from_dict(ISSUED["jwks"])[header["kid"]]
    payload = jwt.decode(
        token,
        key.key,
        algorithms=["RS256", "ES256"],
        audience=ISSUED["audience"],
        issuer=ISSUED["issuer"],
        options={"require": ["iss", "sub", "aud", "exp", "iat", "jti"]},
    )

    assert payload["client_id"] == "ag_01UNDERWRITER"
    assert payload["scope"].split(" ") == ["tool:acme_kyb:read", "tool:acme_kyb:write"]
    assert payload["cnf"] == STANDARD["cnf"]
    assert payload["act"] == {"sub": "did:grantex:ag_01ORCHESTRATOR", "act": {"sub": "did:grantex:ag_01INTAKE"}}
    assert payload["authorization_details"] == STANDARD["authorization_details"]
    assert not set(LEGACY_CLAIM_ALIASES) & set(payload)


@pytest.mark.parametrize("name", sorted(ISSUED["tokens"]))
def test_every_auth_service_issued_token_verifies_with_the_sdk(mocker: Any, name: str) -> None:
    _serve(mocker, ISSUED["jwks"])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", LegacyClaimsWarning)
        grant = _verify(ISSUED["tokens"][name]["token"], audience=ISSUED["audience"])
    assert grant.agent_did == "did:grantex:ag_01UNDERWRITER"


def test_a_pre_0_6_token_with_a_whitespace_scope_reads_scp(mocker: Any) -> None:
    _serve(mocker, ISSUED["jwks"])
    with pytest.warns(LegacyClaimsWarning):
        grant = _verify(ISSUED["tokens"]["pre_0_6_whitespace_scope_rs256"]["token"])
    assert grant.scopes == ("tool:acme_kyb:read", "read case files")


def test_a_whitespace_scope_token_needs_legacy_claims(mocker: Any) -> None:
    _serve(mocker, ISSUED["jwks"])
    token = ISSUED["tokens"]["whitespace_scope_es256"]["token"]
    with pytest.warns(LegacyClaimsWarning):
        assert _verify(token).scopes == ("tool:acme_kyb:read", "read case files")
    with pytest.raises(GrantexTokenError, match="missing required claims"):
        _verify(token, legacy_claims=False)


def test_standard_claims_are_mapped_without_a_warning() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        grant = _verify(_sign(_claims()), audience=AUDIENCE, legacy_claims=False)
    assert [w for w in caught if issubclass(w.category, LegacyClaimsWarning)] == []
    assert grant.token_id == "tok_01EXAMPLETOKEN"
    assert grant.grant_id == "grnt_01EXAMPLECHILD"
    assert grant.principal_id == "user_01EXAMPLEPRINCIPAL"
    assert grant.agent_did == "did:grantex:ag_01UNDERWRITER"
    assert grant.developer_id == "dev_01EXAMPLE"
    assert grant.client_id == "ag_01UNDERWRITER"
    assert grant.scopes == ("tool:acme_kyb:read", "tool:acme_kyb:write")
    assert grant.parent_agent_did == "did:grantex:ag_01ORCHESTRATOR"
    assert grant.parent_grant_id == "grnt_01EXAMPLEPARENT"
    assert grant.delegation_depth == 2
    assert grant.act == STANDARD["act"]
    assert grant.cnf == {"jkt": DPOP_JKT}
    assert grant.audience == AUDIENCE
    assert grant.legacy_claims_used == ()


def test_a_token_with_both_forms_is_read_without_a_warning() -> None:
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        grant = _verify(_sign(_claims(LEGACY)))
    assert [w for w in caught if issubclass(w.category, LegacyClaimsWarning)] == []
    assert grant.legacy_claims_used == ()


def _legacy_only() -> Dict[str, Any]:
    return _claims(
        LEGACY,
        base={"iss": ISSUER, "sub": "user_01EXAMPLEPRINCIPAL", "jti": "tok_old", "act": {"sub": "did:grantex:ag_01ORCHESTRATOR"}},
    )


def test_without_legacy_claims_a_legacy_only_token_is_refused() -> None:
    with pytest.raises(GrantexTokenError, match=f"scope, {GRANT_CLAIM}.agent_did"):
        _verify(_sign(_legacy_only()), legacy_claims=False)


def test_without_legacy_claims_typ_must_be_at_jwt() -> None:
    with pytest.raises(GrantexTokenError, match="typ must be at\\+jwt"):
        _verify(_sign(_claims(), typ="JWT"), legacy_claims=False)


def test_legacy_aliases_are_read_by_default_with_a_deprecation_warning() -> None:
    with pytest.warns(LegacyClaimsWarning) as record:
        grant = _verify(_sign(_legacy_only()))
    assert grant.agent_did == "did:grantex:ag_01UNDERWRITER"
    assert grant.scopes == ("tool:acme_kyb:read", "tool:acme_kyb:write")
    assert grant.parent_agent_did == "did:grantex:ag_01ORCHESTRATOR"
    assert grant.legacy_claims_used == ("scp", "agt", "dev", "grnt", "parentGrnt", "delegationDepth")
    messages = [str(w.message) for w in record if issubclass(w.category, LegacyClaimsWarning)]
    assert any("'scp' is a legacy alias of scope" in m for m in messages)
    assert issubclass(LegacyClaimsWarning, FutureWarning)


def test_every_legacy_alias_is_named() -> None:
    assert sorted(LEGACY_CLAIM_ALIASES) == sorted(
        ["agt", "dev", "grnt", "scp", "parentAgt", "parentGrnt", "delegationDepth"]
    )
    assert set(LEGACY) <= set(LEGACY_CLAIM_ALIASES)


@pytest.mark.parametrize(
    "alias",
    [
        {"scp": ["tool:acme_kyb:read"]},
        {"agt": "did:grantex:ag_OTHER"},
        {"dev": "dev_OTHER"},
        {"grnt": "grnt_OTHER"},
        {"parentAgt": "did:grantex:ag_OTHER"},
        {"parentGrnt": "grnt_OTHER"},
        {"delegationDepth": 1},
    ],
)
def test_a_standard_claim_and_its_alias_that_disagree_are_refused(alias: Dict[str, Any]) -> None:
    with pytest.raises(GrantexTokenError, match="disagrees with its legacy alias"):
        _verify(_sign(_claims(alias)))


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({"scope": ["a"]}, "scope must be a space-delimited string"),
        ({GRANT_CLAIM: "grnt"}, f"{GRANT_CLAIM} must be an object"),
        ({"act": {"iss": "x"}}, "act claim must be an object"),
        ({"cnf": "jkt"}, "cnf must be an object"),
        ({GRANT_CLAIM: {**STANDARD[GRANT_CLAIM], "delegation_depth": -1}}, "non-negative integer"),
    ],
)
def test_malformed_standard_claims_are_refused(extra: Dict[str, Any], message: str) -> None:
    with pytest.raises(GrantexTokenError, match=message):
        _verify(_sign(_claims(extra)))


def test_an_act_chain_deeper_than_ten_is_refused() -> None:
    chain: Dict[str, Any] = {"sub": "did:grantex:ag_0"}
    for i in range(1, 11):
        chain = {"sub": f"did:grantex:ag_{i}", "act": chain}
    with pytest.raises(GrantexTokenError, match="deeper than 10"):
        _verify(_sign(_claims({"act": chain})))


# ─── Decision references ──────────────────────────────────────────────────────


def test_decision_references_parse_the_profile_example() -> None:
    refs = parse_decision_references(STANDARD["authorization_details"])
    ref = refs["acme_kyb"]
    assert ref.tools == ("case_decision",)
    assert dict(ref.four_eyes_on) == {"case_decision": ("decline",)}


@pytest.mark.parametrize(
    "entry",
    [
        {"tools": ["case_decision"], "approver": "x"},
        {"tools": []},
        {"tools": ["case decision"]},
        {"tools": ["case_decision"], "four_eyes_on": {"monitor_delete": ["decline"]}},
        {"tools": ["case_decision"], "four_eyes_on": {"case_decision": []}},
    ],
)
def test_malformed_decision_references_are_refused(entry: Dict[str, Any]) -> None:
    with pytest.raises(AuthorizationDetailsError):
        parse_decision_references([{"type": DECISION_DETAIL_TYPE, "connector": "acme_kyb", **entry}])


def test_two_decision_references_for_one_connector_are_refused() -> None:
    entry = {"type": DECISION_DETAIL_TYPE, "connector": "acme_kyb", "tools": ["case_decision"]}
    with pytest.raises(AuthorizationDetailsError, match="repeats connector"):
        parse_decision_references([entry, entry])


MANIFEST = ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"case_decision": "write", "get_case": "read"}})


def _grant(details: Any) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
        developer_id="dev_01", scopes=("tool:acme_kyb:write",), issued_at=1709000000,
        expires_at=9999999999, authorization_details=details,
    )


def _enforce(grant: VerifiedGrant, tool: str, **client: Any) -> Any:
    with patch("grantex._client.verify_grant_token") as verify:
        verify.return_value = grant
        g = Grantex(api_key="test-key", **client)
        g.load_manifest(MANIFEST)
        result = g.enforce(grant_token="t", connector="acme_kyb", tool=tool)
        return result, verify


def test_enforce_denies_a_tool_the_grant_says_needs_a_decision() -> None:
    details = [{"type": DECISION_DETAIL_TYPE, "connector": "acme_kyb", "tools": ["case_decision"]}]
    result, _ = _enforce(_grant(details), "case_decision")
    assert (result.allowed, result.reason_code) == (False, DenialReason.DECISION_REQUIRED)
    assert _enforce(_grant(details), "get_case")[0].allowed is True


def test_enforce_denies_every_call_when_a_decision_reference_is_malformed() -> None:
    details = [{"type": DECISION_DETAIL_TYPE, "connector": "acme_kyb", "tools": "case_decision"}]
    result, _ = _enforce(_grant(details), "get_case")
    assert (result.allowed, result.reason_code, result.sub_reason) == (
        False, DenialReason.TOKEN_INVALID, TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
    )


def test_client_legacy_claims_option_reaches_the_verifier() -> None:
    _, verify = _enforce(_grant(None), "get_case", legacy_claims=False)
    options: VerifyGrantTokenOptions = verify.call_args[0][1]
    assert options.legacy_claims is False
    _, verify = _enforce(_grant(None), "get_case")
    assert verify.call_args[0][1].legacy_claims is True
    assert isinstance(verify, MagicMock)


# ─── Null claims and proof of possession ──────────────────────────────────────


@pytest.mark.parametrize(
    "extra",
    [
        {"scope": None},
        {"scp": None},
        {"act": None},
        {"cnf": None},
        {"client_id": None},
        {"aud": None},
        {"authorization_details": None},
        {GRANT_CLAIM: None},
        {GRANT_CLAIM: {**STANDARD[GRANT_CLAIM], "grant_id": None}},
        {GRANT_CLAIM: {**STANDARD[GRANT_CLAIM], "delegation_depth": None}},
        {"client_id": 7},
    ],
)
def test_null_or_mistyped_standard_claims_are_refused(extra: Dict[str, Any]) -> None:
    with pytest.raises(GrantexTokenError, match="must not be null|must be"):
        _verify(_sign(_claims(extra)), audience=AUDIENCE if "aud" not in extra else None)


def test_proof_of_possession_is_checked_against_cnf_jkt_when_given() -> None:
    token = _sign(_claims())
    assert _verify(token, proof_jkt=DPOP_JKT, require_proof_of_possession=True).cnf == {"jkt": DPOP_JKT}
    with pytest.raises(GrantexTokenError, match="does not match the proof key"):
        _verify(token, proof_jkt="another-thumbprint")


def test_required_proof_of_possession_fails_closed() -> None:
    with pytest.raises(GrantexTokenError, match="no proof key thumbprint"):
        _verify(_sign(_claims()), require_proof_of_possession=True)
    unbound = {k: v for k, v in _claims().items() if k != "cnf"}
    with pytest.raises(GrantexTokenError, match="not key-bound"):
        _verify(_sign(unbound), proof_jkt=DPOP_JKT, require_proof_of_possession=True)


def test_cnf_is_not_enforced_unless_asked() -> None:
    assert _verify(_sign(_claims())).cnf == {"jkt": DPOP_JKT}

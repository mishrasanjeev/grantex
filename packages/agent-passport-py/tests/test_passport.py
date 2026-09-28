# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

import base64
import copy
import json
from typing import Any, Callable, Dict, List, Optional, Tuple

import pytest

from conftest import (
    AGENT_DID,
    IAT,
    ISSUER,
    NOW,
    PROFILE_CLAIMS,
    KeyPair,
    ed25519_key_pair,
    p256_key_pair,
    passport_params,
    resolver_for,
)
from grantex_agent_passport import (
    MAX_PASSPORT_LIFETIME_SECONDS,
    PASSPORT_TYP,
    PASSPORT_VCT,
    PassportError,
    disclosure_digest,
    encode_disclosure,
    external_credential_hash,
    issue_passport,
    jwk_thumbprint,
    verify_passport,
)
from grantex_agent_passport._jws import decode_jws_unverified, sign_jws

ISSUER_KEYS = p256_key_pair("mock-issuer-2026")
HOLDER = p256_key_pair()

Edit = Callable[[Dict[str, Any], Dict[str, Any]], None]


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def verify(compact: str, **extra: Any) -> Any:
    kwargs: Dict[str, Any] = {
        "issuer_keys": resolver_for(ISSUER_KEYS.public_jwk),
        "now": NOW,
        "status_resolver": lambda uri, idx: "valid",
    }
    kwargs.update(extra)
    return verify_passport(compact, **kwargs)


def refusal(compact: str, **extra: Any) -> Tuple[str, str]:
    with pytest.raises(PassportError) as info:
        verify(compact, **extra)
    return info.value.code, info.value.reason


def resign(
    compact: str, edit: Edit, key: Optional[Dict[str, Any]] = None
) -> str:
    """Re-sign an issued passport after editing its header or payload."""
    jwt, _, rest = compact.partition("~")
    header, payload = decode_jws_unverified(jwt)
    edit(header, payload)
    signed = sign_jws(header, payload, key or ISSUER_KEYS.private_jwk)
    return signed + "~" + rest


def issue(holder: KeyPair = HOLDER, **overrides: Any) -> Any:
    return issue_passport(**passport_params(ISSUER_KEYS, holder, **overrides))


def add_digest(d: str) -> Edit:
    def edit(_h: Dict[str, Any], payload: Dict[str, Any]) -> None:
        payload["_sd"] = sorted([*payload["_sd"], disclosure_digest(d)])

    return edit


# -- issue_passport -----------------------------------------------------------


def test_issues_the_sd_jwt_vc_profile() -> None:
    issued = issue()
    assert issued.compact.endswith("~")
    header, payload = decode_jws_unverified(issued.issuer_jwt)
    assert header == {"alg": "ES256", "typ": PASSPORT_TYP, "kid": "mock-issuer-2026"}
    assert PASSPORT_TYP == "dc+sd-jwt"
    assert payload["vct"] == PASSPORT_VCT == "urn:grantex:agent-passport:1"
    assert payload["iss"] == ISSUER
    assert payload["sub"] == AGENT_DID
    assert payload["cnf"] == {"jwk": HOLDER.public_jwk}
    assert payload["_sd_alg"] == "sha-256"
    assert payload["status"] == {
        "status_list": {"uri": "https://mock-issuer.example/status/1", "idx": 42}
    }
    for name in ("provider", "agent", "verification", "attestation_id"):
        assert name not in payload
    sd = payload["_sd"]
    assert len(sd) == 4
    assert sorted(sd) == sd
    assert sorted(disclosure_digest(d.encoded) for d in issued.disclosures) == sd


def test_uses_a_fresh_128_bit_salt_for_every_disclosure() -> None:
    salts = [d.salt for d in [*issue().disclosures, *issue().disclosures]]
    assert len(set(salts)) == len(salts)
    for salt in salts:
        assert len(base64.urlsafe_b64decode(salt + "==")) == 16


def test_skips_a_claim_whose_value_is_none_as_the_typescript_package_does() -> None:
    claims = {**copy.deepcopy(PROFILE_CLAIMS), "attestation_id": None, "verification": None}
    issued = issue(claims=claims)
    assert [d.name for d in issued.disclosures] == ["provider", "agent"]


def test_issue_refuses_long_lifetime_private_cnf_and_public_signing_key() -> None:
    with pytest.raises(PassportError):
        issue(exp=IAT + MAX_PASSPORT_LIFETIME_SECONDS + 1)
    with pytest.raises(PassportError):
        issue(cnf_jwk=HOLDER.private_jwk)
    with pytest.raises(PassportError):
        issue(issuer_key=ISSUER_KEYS.public_jwk)


# -- verify_passport ----------------------------------------------------------


def test_returns_disclosed_claims_cnf_key_and_hash() -> None:
    issued = issue()
    result = verify(issued.compact)
    assert result.iss == ISSUER
    assert result.sub == AGENT_DID
    assert result.vct == PASSPORT_VCT
    assert result.iat == IAT
    assert result.cnf_jwk == HOLDER.public_jwk
    assert result.cnf_thumbprint == jwk_thumbprint(HOLDER.public_jwk)
    assert result.status == {
        "status_list": {"uri": "https://mock-issuer.example/status/1", "idx": 42}
    }
    assert result.disclosed == PROFILE_CLAIMS
    assert "_sd" not in result.claims
    assert "_sd_alg" not in result.claims
    assert result.claims["provider"] == PROFILE_CLAIMS["provider"]
    assert result.external_credential_hash == external_credential_hash(issued.compact)
    assert result.key_binding is None


def test_returns_only_what_the_holder_disclosed() -> None:
    issued = issue()
    agent = next(d for d in issued.disclosures if d.name == "agent")
    result = verify(f"{issued.issuer_jwt}~{agent.encoded}~")
    assert result.disclosed == {"agent": PROFILE_CLAIMS["agent"]}
    assert verify(f"{issued.issuer_jwt}~").disclosed == {}


def test_eddsa_issuer_only_when_allowed() -> None:
    ed_issuer = ed25519_key_pair("ed-1")
    issued = issue_passport(**passport_params(ed_issuer, HOLDER))
    resolver = resolver_for(ed_issuer.public_jwk)
    assert refusal(issued.compact, issuer_keys=resolver) == (
        "passport_not_accepted",
        "eddsa_not_enabled",
    )
    result = verify(issued.compact, issuer_keys=resolver, allow_eddsa=True)
    assert result.iss == ISSUER


@pytest.mark.parametrize("typ", ["vc+sd-jwt", "JWT", None])
def test_refuses_wrong_typ(typ: Optional[str]) -> None:
    def edit(header: Dict[str, Any], _p: Dict[str, Any]) -> None:
        if typ is None:
            del header["typ"]
        else:
            header["typ"] = typ

    compact = resign(issue().compact, edit)
    assert refusal(compact) == ("passport_malformed", "wrong_typ")


def test_refuses_wrong_vct_and_honours_expected_vct() -> None:
    issued = issue(vct="urn:example:other:1")
    assert refusal(issued.compact) == ("passport_not_accepted", "wrong_vct")
    result = verify(issued.compact, expected_vct="urn:example:other:1")
    assert result.vct == "urn:example:other:1"


def test_refuses_bad_signature() -> None:
    issued = issue()
    other = p256_key_pair("mock-issuer-2026")
    forged = resign(issued.compact, lambda h, p: None, other.private_jwk)
    assert refusal(forged) == ("passport_invalid_signature", "signature_mismatch")
    jwt, _, rest = issued.compact.partition("~")
    h, p, s = jwt.split(".")
    sig = bytearray(base64.urlsafe_b64decode(s + "=="))
    sig[5] ^= 1
    flipped = ".".join([h, p, b64(bytes(sig))]) + "~" + rest
    assert refusal(flipped) == ("passport_invalid_signature", "signature_mismatch")


def test_accepts_the_n_minus_s_form_of_an_es256_signature_with_another_hash() -> None:
    # P-256 group order n. JWS does not require low-s, so (r, n - s) also verifies;
    # spec section 6 therefore says the hash names the exact bytes and is not a deny-list key.
    n = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
    issued = issue()
    jwt, _, rest = issued.compact.partition("~")
    h, p, s = jwt.split(".")
    sig = base64.urlsafe_b64decode(s + "==")
    mirrored_s = (n - int.from_bytes(sig[32:], "big")).to_bytes(32, "big")
    compact = ".".join([h, p, b64(sig[:32] + mirrored_s)]) + "~" + rest
    result = verify(compact)
    assert result.disclosed == PROFILE_CLAIMS
    assert result.external_credential_hash != external_credential_hash(issued.compact)


def test_refuses_when_the_resolver_has_no_key_or_fails() -> None:
    issued = issue()
    assert refusal(issued.compact, issuer_keys=lambda iss: []) == (
        "passport_invalid_signature",
        "issuer_key_not_found",
    )
    other_kid = dict(ISSUER_KEYS.public_jwk, kid="another")
    assert refusal(issued.compact, issuer_keys=lambda iss: [other_kid]) == (
        "passport_invalid_signature",
        "issuer_key_not_found",
    )

    def failing(iss: str) -> List[Dict[str, Any]]:
        raise RuntimeError("registry unavailable")

    with pytest.raises(PassportError) as info:
        verify(issued.compact, issuer_keys=failing)
    assert info.value.code == "passport_invalid_signature"
    assert info.value.reason == "issuer_key_resolution_failed"
    assert str(info.value.__cause__) == "registry unavailable"
    assert refusal(
        issued.compact, issuer_keys=lambda iss: [ISSUER_KEYS.private_jwk]
    ) == ("passport_invalid_signature", "issuer_key_invalid")


@pytest.mark.parametrize("member", ["jku", "x5u", "jwk", "x5c"])
def test_never_takes_the_issuer_key_from_the_token(member: str) -> None:
    value: Any = {
        "jwk": ISSUER_KEYS.public_jwk,
        "x5c": ["MIIB"],
    }.get(member, "https://keys.example/jwks.json")

    def edit(header: Dict[str, Any], _p: Dict[str, Any]) -> None:
        header[member] = value

    compact = resign(issue().compact, edit)
    called: List[str] = []

    def resolver(iss: str) -> List[Dict[str, Any]]:
        called.append(iss)
        return [ISSUER_KEYS.public_jwk]

    assert refusal(compact, issuer_keys=resolver) == (
        "passport_malformed",
        "header_key_not_allowed",
    )
    assert called == []


def test_refuses_alg_none_hs256_and_crit() -> None:
    issued = issue()
    _, payload = decode_jws_unverified(issued.issuer_jwt)
    unsigned = ".".join(
        [
            b64(json.dumps({"alg": "none", "typ": "dc+sd-jwt"}).encode()),
            b64(json.dumps(payload).encode()),
            "",
        ]
    )
    assert refusal(unsigned + "~") == ("passport_malformed", "alg_not_allowed")

    def hs(header: Dict[str, Any], _p: Dict[str, Any]) -> None:
        header["alg"] = "HS256"

    assert refusal(resign(issued.compact, hs)) == (
        "passport_malformed",
        "alg_not_allowed",
    )

    def crit(header: Dict[str, Any], _p: Dict[str, Any]) -> None:
        header["crit"] = ["exp"]

    assert refusal(resign(issued.compact, crit)) == (
        "passport_malformed",
        "crit_not_supported",
    )


def test_refuses_expired_and_not_yet_valid() -> None:
    issued = issue()
    exp = IAT + 30 * 86_400
    assert refusal(issued.compact, now=exp) == ("passport_expired", "expired")
    assert verify(issued.compact, now=exp - 1).exp == exp
    assert verify(issued.compact, now=exp + 30, clock_skew_seconds=60).exp == exp
    assert refusal(issued.compact, now=IAT - 1) == ("passport_expired", "not_yet_valid")

    def nbf(_h: Dict[str, Any], payload: Dict[str, Any]) -> None:
        payload["nbf"] = NOW + 10

    assert refusal(resign(issued.compact, nbf)) == ("passport_expired", "not_yet_valid")


def test_refuses_lifetime_beyond_one_year() -> None:
    issued = issue()

    def set_exp(value: int) -> Edit:
        def edit(_h: Dict[str, Any], payload: Dict[str, Any]) -> None:
            payload["exp"] = value

        return edit

    long = resign(issued.compact, set_exp(IAT + MAX_PASSPORT_LIFETIME_SECONDS + 1))
    assert refusal(long) == ("passport_not_accepted", "lifetime_exceeds_one_year")
    exact = resign(issued.compact, set_exp(IAT + MAX_PASSPORT_LIFETIME_SECONDS))
    assert verify(exact).exp == IAT + MAX_PASSPORT_LIFETIME_SECONDS
    assert refusal(resign(issued.compact, set_exp(IAT))) == (
        "passport_malformed",
        "bad_claim",
    )


def _set(key: str, value: Any) -> Callable[[Dict[str, Any]], None]:
    return lambda p: p.__setitem__(key, value)


def _del(key: str) -> Callable[[Dict[str, Any]], None]:
    return lambda p: p.pop(key)


@pytest.mark.parametrize(
    "change",
    [
        _del("iss"),
        _set("iss", "http://mock-issuer.example"),
        _del("sub"),
        _set("sub", "shopper-01"),
        _set("iat", str(IAT)),
        _del("exp"),
        _del("status"),
        _set(
            "status",
            {"status_list": {"uri": "https://mock-issuer.example/status/1", "idx": -1}},
        ),
        _set("status", {"status_list": {"idx": 1}}),
        _del("vct"),
    ],
)
def test_refuses_missing_or_malformed_registered_claims(
    change: Callable[[Dict[str, Any]], None],
) -> None:
    compact = resign(issue().compact, lambda _h, p: change(p))
    assert refusal(compact) == ("passport_malformed", "bad_claim")


def test_refuses_unsupported_sd_alg() -> None:
    compact = resign(issue().compact, lambda _h, p: p.__setitem__("_sd_alg", "sha-512"))
    assert refusal(compact) == ("passport_malformed", "sd_alg_not_supported")


def test_refuses_a_disclosure_whose_digest_is_not_in_sd() -> None:
    issued = issue()
    stray = encode_disclosure("c2FsdHNhbHRzYWx0c2FsdA", "attestation_id", "att_forged")
    assert refusal(f"{issued.compact}{stray}~") == (
        "passport_malformed",
        "disclosure_not_referenced",
    )
    agent = next(d for d in issued.disclosures if d.name == "agent")
    edited = encode_disclosure(
        agent.salt, "agent", dict(PROFILE_CLAIMS["agent"], software_version="9.9")
    )
    assert refusal(f"{issued.issuer_jwt}~{edited}~") == (
        "passport_malformed",
        "disclosure_not_referenced",
    )


def test_refuses_duplicate_disclosures_and_digests() -> None:
    issued = issue()
    first = issued.disclosures[0].encoded
    assert refusal(f"{issued.compact}{first}~") == (
        "passport_malformed",
        "duplicate_disclosure",
    )

    def dup(_h: Dict[str, Any], payload: Dict[str, Any]) -> None:
        payload["_sd"] = [*payload["_sd"], payload["_sd"][0]]

    assert refusal(resign(issued.compact, dup)) == (
        "passport_malformed",
        "duplicate_digest",
    )


@pytest.mark.parametrize(
    "name", ["iss", "exp", "cnf", "vct", "status", "_sd", "...", "sub", "iat"]
)
def test_refuses_disclosure_of_registered_or_reserved_names(name: str) -> None:
    issued = issue()
    d = encode_disclosure("c2FsdHNhbHRzYWx0c2FsdA", name, "x")
    compact = resign(f"{issued.issuer_jwt}~{d}~", add_digest(d))
    assert refusal(compact) == ("passport_malformed", "disclosure_name_not_allowed")


def test_refuses_a_disclosure_repeating_a_clear_claim() -> None:
    issued = issue()
    d = encode_disclosure("c2FsdHNhbHRzYWx0c2FsdA", "attestation_id", "att_2")

    def edit(h: Dict[str, Any], payload: Dict[str, Any]) -> None:
        payload["attestation_id"] = "att_1"
        add_digest(d)(h, payload)

    compact = resign(f"{issued.issuer_jwt}~{d}~", edit)
    assert refusal(compact) == ("passport_malformed", "claim_name_conflict")


@pytest.mark.parametrize(
    "disclosure",
    [
        b64(b"not json"),
        b64(json.dumps(["salt", "x"]).encode()),
        b64(json.dumps({"salt": "s"}).encode()),
        b64(json.dumps([1, "x", "y"]).encode()),
        "has+plus",
    ],
)
def test_refuses_malformed_disclosures(disclosure: str) -> None:
    issued = issue()
    compact = resign(f"{issued.issuer_jwt}~{disclosure}~", add_digest(disclosure))
    assert refusal(compact) == ("passport_malformed", "disclosure_malformed")


def test_refuses_malformed_framing() -> None:
    issued = issue()
    assert refusal(f"{issued.issuer_jwt}~~") == ("passport_malformed", "not_sd_jwt")
    assert refusal(issued.issuer_jwt) == ("passport_malformed", "not_sd_jwt")


def test_refuses_missing_private_or_unsupported_cnf() -> None:
    issued = issue()
    cases = [
        (lambda p: p.pop("cnf"), "cnf_missing"),
        (lambda p: p.__setitem__("cnf", {"kid": "holder-1"}), "cnf_missing"),
        (
            lambda p: p.__setitem__("cnf", {"jwk": HOLDER.private_jwk}),
            "cnf_private_key",
        ),
        (
            lambda p: p.__setitem__(
                "cnf", {"jwk": {"kty": "RSA", "n": "AQAB", "e": "AQAB"}}
            ),
            "cnf_unsupported_key",
        ),
    ]
    for change, reason in cases:
        compact = resign(issued.compact, lambda _h, p, c=change: c(p))  # type: ignore[misc]
        assert refusal(compact) == ("passport_malformed", reason)


def test_requires_p256_cnf_for_payments_rails() -> None:
    ed_holder = ed25519_key_pair()
    issued = issue(ed_holder)
    assert verify(issued.compact).cnf_jwk == ed_holder.public_jwk
    assert refusal(issued.compact, payments_rails=True) == (
        "passport_not_accepted",
        "cnf_not_p256",
    )
    assert verify(issue().compact, payments_rails=True).cnf_jwk["crv"] == "P-256"


def test_refuses_a_disclosed_profile_claim_of_the_wrong_shape() -> None:
    claims = copy.deepcopy(PROFILE_CLAIMS)
    claims["agent"] = {"software_name": "Nimbus Shopper"}
    assert refusal(issue(claims=claims).compact) == ("passport_malformed", "bad_claim")


def test_refuses_an_unrequested_kb_jwt() -> None:
    compact = issue().compact + "eyJhbGciOiJFUzI1NiJ9.e30.c2ln"
    assert refusal(compact) == ("passport_malformed", "unexpected_key_binding")


# -- recursive disclosures (RFC 9901 section 7.1) -----------------------------


def test_processes_nested_and_array_element_disclosures() -> None:
    issued = issue()
    nested = encode_disclosure("bmVzdGVkc2FsdG5lc3RlZA", "name", "Provider Example Ltd")
    element = encode_disclosure("ZWxlbWVudHNhbHRlbGVtZQ", None, "shopping")
    provider = encode_disclosure(
        "cHJvdmlkZXJzYWx0cHJvdg",
        "provider",
        {
            "did": "did:web:provider.example",
            "legal_identifiers": [],
            "_sd": [disclosure_digest(nested)],
        },
    )
    agent = encode_disclosure(
        "YWdlbnRzYWx0YWdlbnRzYQ",
        "agent",
        {
            "software_name": "Nimbus Shopper",
            "software_version": "2.4",
            "categories": [{"...": disclosure_digest(element)}, "travel"],
        },
    )

    def edit(_h: Dict[str, Any], payload: Dict[str, Any]) -> None:
        payload["_sd"] = sorted([disclosure_digest(provider), disclosure_digest(agent)])

    compact = resign(
        f"{issued.issuer_jwt}~{provider}~{nested}~{agent}~{element}~", edit
    )
    result = verify(compact)
    assert result.disclosed["provider"] == {
        "did": "did:web:provider.example",
        "legal_identifiers": [],
        "name": "Provider Example Ltd",
    }
    assert result.disclosed["agent"]["categories"] == ["shopping", "travel"]
    withheld = compact.replace(f"{element}~", "")
    assert verify(withheld).disclosed["agent"]["categories"] == ["travel"]


def test_refuses_element_and_property_disclosures_in_the_wrong_place() -> None:
    issued = issue()
    element = encode_disclosure("ZWxlbWVudHNhbHRlbGVtZQ", None, "shopping")
    as_property = resign(f"{issued.issuer_jwt}~{element}~", add_digest(element))
    assert refusal(as_property) == ("passport_malformed", "disclosure_malformed")
    prop = encode_disclosure("cHJvcGVydHlzYWx0cHJvcA", "x", "shopping")
    agent = encode_disclosure(
        "YWdlbnRzYWx0YWdlbnRzYQ",
        "agent",
        {
            "software_name": "Nimbus Shopper",
            "software_version": "2.4",
            "categories": [{"...": disclosure_digest(prop)}],
        },
    )
    as_element = resign(
        f"{issued.issuer_jwt}~{agent}~{prop}~",
        lambda _h, p: p.__setitem__("_sd", [disclosure_digest(agent)]),
    )
    assert refusal(as_element) == ("passport_malformed", "disclosure_malformed")


def test_disclosure_encoding_matches_the_typescript_library() -> None:
    # RFC 9901 section 4.2.1: base64url of the UTF-8 JSON array. Both libraries
    # serialise without whitespace and keep non-ASCII characters unescaped.
    d = encode_disclosure("c2FsdA", "name", "Café Ö")
    assert base64.urlsafe_b64decode(d + "==").decode("utf-8") == '["c2FsdA","name","Café Ö"]'


# Status (draft-ietf-oauth-status-list section 7.1): verify_passport fails closed.

STATUS_URI = "https://mock-issuer.example/status/1"


def bare(compact: str, **extra: Any) -> Any:
    """verify_passport without any status decision, so each test states its own."""
    kwargs: Dict[str, Any] = {"issuer_keys": resolver_for(ISSUER_KEYS.public_jwk), "now": NOW}
    kwargs.update(extra)
    return verify_passport(compact, **kwargs)


def bare_refusal(compact: str, **extra: Any) -> Tuple[str, str]:
    with pytest.raises(PassportError) as info:
        bare(compact, **extra)
    return info.value.code, info.value.reason


def test_status_neither_resolver_nor_acknowledgement_is_a_configuration_error() -> None:
    issued = issue()
    with pytest.raises(ValueError, match="status_resolver.*status_checked_by"):
        bare(issued.compact)


def test_status_both_options_or_another_acknowledgement_is_a_configuration_error() -> None:
    issued = issue()
    with pytest.raises(ValueError):
        bare(issued.compact, status_resolver=lambda uri, idx: "valid", status_checked_by="caller")
    with pytest.raises(ValueError):
        bare(issued.compact, status_checked_by="verifier")
    with pytest.raises(ValueError):
        bare(issued.compact, status_resolver="valid")


def test_status_resolver_gets_the_reference_and_valid_is_accepted() -> None:
    issued = issue()
    calls: List[Tuple[str, int]] = []

    def resolver(uri: str, idx: int) -> str:
        calls.append((uri, idx))
        return "valid"

    result = bare(issued.compact, status_resolver=resolver)
    assert calls == [(STATUS_URI, 42)]
    assert result.status_checked_by == "resolver"


def test_status_invalid_and_suspended_are_passport_revoked() -> None:
    issued = issue()
    assert bare_refusal(issued.compact, status_resolver=lambda uri, idx: "invalid") == (
        "passport_revoked",
        "status_invalid",
    )
    assert bare_refusal(issued.compact, status_resolver=lambda uri, idx: "suspended") == (
        "passport_revoked",
        "status_suspended",
    )


def test_status_failing_or_unknown_answer_is_status_stale() -> None:
    issued = issue()
    cause = RuntimeError("status list unreachable")

    def failing(uri: str, idx: int) -> str:
        raise cause

    with pytest.raises(PassportError) as info:
        bare(issued.compact, status_resolver=failing)
    assert (info.value.code, info.value.reason) == ("status_stale", "status_unresolved")
    assert info.value.__cause__ is cause
    for answer in ("unknown", "VALID", 0, None, True):
        assert bare_refusal(issued.compact, status_resolver=lambda uri, idx, a=answer: a) == (
            "status_stale",
            "status_unknown",
        )


def test_status_checked_by_caller_is_accepted_and_reported() -> None:
    issued = issue()
    result = bare(issued.compact, status_checked_by="caller")
    assert result.status_checked_by == "caller"
    assert result.status == {"status_list": {"uri": STATUS_URI, "idx": 42}}


def test_status_resolver_is_not_called_for_a_passport_refused_on_another_rule() -> None:
    issued = issue()
    called: List[bool] = []

    def resolver(uri: str, idx: int) -> str:
        called.append(True)
        return "valid"

    assert bare_refusal(
        issued.compact, now=IAT + 31 * 86_400, status_resolver=resolver
    ) == ("passport_expired", "expired")
    assert called == []


# DID syntax (W3C DID Core section 3.1).

VALID_DIDS = [
    "did:web:provider.example",
    "did:web:provider.example:agents:shopper-01",
    "did:web:provider.example%3A8443:agents:shopper-01",
    "did:example:123456789abcdefghi",
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    "did:example:a::b",
    "did:example:A.b-c_d",
]

INVALID_DIDS = [
    "xdid:web:provider.example",
    "did:web:provider.example agent",
    "did:web:provider.example\n",
    "did:web:provider.example/agents",
    "did:web:provider.example?service=x",
    "did:web:provider.example#key-1",
    "did:web:",
    "did:web:provider.example:",
    "did:Web:provider.example",
    "did::provider.example",
    "did:web",
    "did:web:provider%2",
    "did:web:provider%zz",
    "did:web:café.example",
]


@pytest.mark.parametrize("sub", VALID_DIDS)
def test_did_every_did_the_abnf_allows_is_issued_and_verified(sub: str) -> None:
    assert verify(issue(sub=sub).compact).sub == sub


@pytest.mark.parametrize("sub", INVALID_DIDS)
def test_did_a_sub_that_is_not_a_did_in_full_is_refused(sub: str) -> None:
    with pytest.raises(PassportError):
        issue(sub=sub)
    compact = resign(issue().compact, lambda _h, p: p.__setitem__("sub", sub))
    assert refusal(compact) == ("passport_malformed", "bad_claim")


@pytest.mark.parametrize("did", INVALID_DIDS)
def test_did_a_provider_did_that_is_not_a_did_in_full_is_refused(did: str) -> None:
    claims = copy.deepcopy(PROFILE_CLAIMS)
    claims["provider"]["did"] = did
    assert refusal(issue(claims=claims).compact) == ("passport_malformed", "bad_claim")


@pytest.mark.parametrize(
    "value", [float("nan"), float("inf"), float("-inf"), -1, True, "60"]
)
def test_time_options_must_be_finite_non_negative_numbers(value: Any) -> None:
    issued = issue()
    with pytest.raises(ValueError, match="finite number"):
        verify(issued.compact, now=value)
    with pytest.raises(ValueError, match="finite number"):
        verify(issued.compact, clock_skew_seconds=value)

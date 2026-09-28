# SPDX-License-Identifier: Apache-2.0
"""Key binding (RFC 9901 section 4.3)."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Dict, List, Optional, Tuple

import pytest

from conftest import (
    NOW,
    PROFILE_CLAIMS,
    ed25519_key_pair,
    p256_key_pair,
    passport_params,
    resolver_for,
)
from grantex_agent_passport import (
    DEFAULT_KB_MAX_AGE_SECONDS,
    KB_JWT_TYP,
    KeyBindingRequirement,
    PassportError,
    create_key_binding_jwt,
    external_credential_hash,
    issue_passport,
    select_disclosures,
    verify_passport,
)
from grantex_agent_passport._jws import decode_jws_unverified, sign_jws

ISSUER_KEYS = p256_key_pair("mock-issuer-2026")
HOLDER = p256_key_pair()
AUD = "https://merchant.example"
NONCE = "n-0S6_WzA2Mj"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def verify(compact: str, **extra: Any) -> Any:
    kwargs: Dict[str, Any] = {
        "issuer_keys": resolver_for(ISSUER_KEYS.public_jwk),
        "now": NOW,
        "key_binding": KeyBindingRequirement(aud=AUD, nonce=NONCE),
    }
    kwargs.update(extra)
    return verify_passport(compact, **kwargs)


def refusal(compact: str, **extra: Any) -> Tuple[str, str]:
    with pytest.raises(PassportError) as info:
        verify(compact, **extra)
    return info.value.code, info.value.reason


def present(
    disclose: Optional[List[str]] = None,
    key: Optional[Dict[str, Any]] = None,
    iat: int = NOW,
) -> str:
    issued = issue_passport(**passport_params(ISSUER_KEYS, HOLDER))
    names = ["provider", "agent"] if disclose is None else disclose
    sd_jwt = select_disclosures(issued.compact, names)
    return create_key_binding_jwt(
        sd_jwt,
        holder_key=key or HOLDER.private_jwk,
        aud=AUD,
        nonce=NONCE,
        iat=iat,
    )


def test_creates_a_kb_jwt_with_sd_hash_aud_nonce_iat() -> None:
    presentation = present()
    parts = presentation.split("~")
    kb_jwt = parts[-1]
    sd_jwt = presentation[: len(presentation) - len(kb_jwt)]
    header, payload = decode_jws_unverified(kb_jwt)
    assert KB_JWT_TYP == "kb+jwt"
    assert header == {"alg": "ES256", "typ": "kb+jwt"}
    assert payload == {
        "iat": NOW,
        "aud": AUD,
        "nonce": NONCE,
        "sd_hash": b64(hashlib.sha256(sd_jwt.encode("ascii")).digest()),
    }
    assert len(parts) == 4
    assert sd_jwt.endswith("~")


def test_verifies_a_presentation() -> None:
    presentation = present()
    result = verify(presentation)
    assert result.key_binding == {"aud": AUD, "nonce": NONCE, "iat": NOW}
    assert result.disclosed == {
        "provider": PROFILE_CLAIMS["provider"],
        "agent": PROFILE_CLAIMS["agent"],
    }
    assert result.external_credential_hash == external_credential_hash(
        presentation.split("~")[0] + "~"
    )


def test_ed25519_holder_when_eddsa_enabled() -> None:
    ed_holder = ed25519_key_pair()
    issued = issue_passport(**passport_params(ISSUER_KEYS, ed_holder))
    presentation = create_key_binding_jwt(
        issued.compact, holder_key=ed_holder.private_jwk, aud=AUD, nonce=NONCE, iat=NOW
    )
    assert refusal(presentation) == ("passport_not_accepted", "eddsa_not_enabled")
    assert verify(presentation, allow_eddsa=True).key_binding["aud"] == AUD


def test_requires_a_kb_jwt_when_asked() -> None:
    issued = issue_passport(**passport_params(ISSUER_KEYS, HOLDER))
    assert refusal(issued.compact) == ("key_unproven", "key_binding_missing")


def test_refuses_a_kb_jwt_signed_by_another_key() -> None:
    other = p256_key_pair()
    assert refusal(present(["agent"], other.private_jwk)) == (
        "key_binding_mismatch",
        "kb_signature_mismatch",
    )


def test_refuses_the_wrong_audience() -> None:
    wrong = KeyBindingRequirement(aud="https://other.example", nonce=NONCE)
    assert refusal(present(), key_binding=wrong) == (
        "audience_mismatch",
        "audience_mismatch",
    )


def test_refuses_the_wrong_nonce() -> None:
    wrong = KeyBindingRequirement(aud=AUD, nonce="other")
    assert refusal(present(), key_binding=wrong) == ("key_unproven", "nonce_mismatch")


def test_refuses_a_kb_jwt_outside_the_iat_window() -> None:
    stale = present(["agent"], iat=NOW - DEFAULT_KB_MAX_AGE_SECONDS - 1)
    assert refusal(stale) == ("key_unproven", "kb_stale")
    edge = present(["agent"], iat=NOW - DEFAULT_KB_MAX_AGE_SECONDS)
    assert verify(edge).key_binding["iat"] == NOW - DEFAULT_KB_MAX_AGE_SECONDS
    assert refusal(present(["agent"], iat=NOW + 1)) == ("key_unproven", "kb_stale")
    short = KeyBindingRequirement(aud=AUD, nonce=NONCE, max_age_seconds=10)
    assert refusal(present(["agent"], iat=NOW - 20), key_binding=short) == (
        "key_unproven",
        "kb_stale",
    )


def test_refuses_changed_disclosures_after_the_kb_jwt() -> None:
    parts = present(["provider", "agent"]).split("~")
    trimmed = "~".join([parts[0], parts[2], parts[3]])
    assert refusal(trimmed) == ("key_binding_mismatch", "sd_hash_mismatch")
    reordered = "~".join([parts[0], parts[2], parts[1], parts[3]])
    assert refusal(reordered) == ("key_binding_mismatch", "sd_hash_mismatch")


def _good_sd_jwt() -> Tuple[str, Dict[str, Any]]:
    issued = issue_passport(**passport_params(ISSUER_KEYS, HOLDER))
    sd_jwt = select_disclosures(issued.compact, ["agent"])
    sd_hash = b64(hashlib.sha256(sd_jwt.encode("ascii")).digest())
    return sd_jwt, {"iat": NOW, "aud": AUD, "nonce": NONCE, "sd_hash": sd_hash}


@pytest.mark.parametrize(
    "header, change",
    [
        ({"alg": "ES256", "typ": "JWT"}, {}),
        ({"alg": "ES256"}, {}),
        ({"alg": "ES256", "typ": "kb+jwt", "jwk": "HOLDER"}, {}),
        ({"alg": "ES256", "typ": "kb+jwt"}, {"sd_hash": None}),
        ({"alg": "ES256", "typ": "kb+jwt"}, {"nonce": 7}),
        ({"alg": "ES256", "typ": "kb+jwt"}, {"iat": "now"}),
        ({"alg": "ES256", "typ": "kb+jwt"}, {"aud": [AUD]}),
    ],
)
def test_refuses_a_malformed_kb_jwt(
    header: Dict[str, Any], change: Dict[str, Any]
) -> None:
    sd_jwt, good = _good_sd_jwt()
    if header.get("jwk") == "HOLDER":
        header = dict(header, jwk=HOLDER.public_jwk)
    payload = dict(good)
    for key, value in change.items():
        if value is None:
            payload.pop(key)
        else:
            payload[key] = value
    kb = sign_jws(header, json.loads(json.dumps(payload)), HOLDER.private_jwk)
    assert refusal(sd_jwt + kb) == ("key_unproven", "kb_malformed")


def test_refuses_to_create_over_a_non_sd_jwt_or_with_a_public_key() -> None:
    issued = issue_passport(**passport_params(ISSUER_KEYS, HOLDER))
    with pytest.raises(PassportError):
        create_key_binding_jwt(
            issued.issuer_jwt, holder_key=HOLDER.private_jwk, aud=AUD, nonce=NONCE
        )
    with pytest.raises(PassportError):
        create_key_binding_jwt(
            issued.compact, holder_key=HOLDER.public_jwk, aud=AUD, nonce=NONCE
        )


def test_select_disclosures_keeps_only_named_claims() -> None:
    issued = issue_passport(**passport_params(ISSUER_KEYS, HOLDER))
    parts = select_disclosures(issued.compact, ["verification"]).split("~")
    assert len(parts) == 3
    assert parts[1] == next(
        d.encoded for d in issued.disclosures if d.name == "verification"
    )
    assert select_disclosures(issued.compact, []) == issued.issuer_jwt + "~"

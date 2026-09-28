# SPDX-License-Identifier: Apache-2.0
"""Property tests for the hash rule and the key rule.

Cases come from a seeded generator, so a failure replays with the same inputs.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Dict

import pytest

from conftest import ed25519_key_pair, p256_key_pair, passport_params, seeded
from grantex_agent_passport import (
    PassportError,
    create_key_binding_jwt,
    external_credential_hash,
    issue_passport,
    jwk_thumbprint,
    keys_equal,
)

ISSUER_KEYS = p256_key_pair("mock-issuer-2026")
HOLDER = p256_key_pair()
CASES = 200
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def issue() -> Any:
    return issue_passport(**passport_params(ISSUER_KEYS, HOLDER))


# -- hash rule ----------------------------------------------------------------


def test_hash_is_sha256_of_the_issuer_signed_jwt() -> None:
    issued = issue()
    expected = "sha-256:" + b64(hashlib.sha256(issued.issuer_jwt.encode("ascii")).digest())
    assert external_credential_hash(issued.compact) == expected
    assert external_credential_hash(issued.issuer_jwt + "~") == expected


def test_hash_ignores_disclosures_and_key_binding() -> None:
    rng = seeded(0x5D1A)
    issued = issue()
    expected = external_credential_hash(issued.compact)
    everything = [d.encoded for d in issued.disclosures]
    for i in range(CASES):
        subset = [d for d in rng.sample(everything, len(everything)) if rng.random() < 0.6]
        if rng.random() < 0.3 and subset:
            subset.append(subset[0])
        if rng.random() < 0.3:
            subset.append(b64(json.dumps(["s", "x", i]).encode()))
        compact = issued.issuer_jwt + "~" + "".join(d + "~" for d in subset)
        if rng.random() < 0.5:
            compact = create_key_binding_jwt(
                compact,
                holder_key=HOLDER.private_jwk,
                aud="https://merchant.example",
                nonce=f"n{i}",
                iat=1_790_000_000 + i,
            )
        assert external_credential_hash(compact) == expected


def test_hash_changes_with_any_character_of_the_jwt() -> None:
    rng = seeded(0x7E57)
    issued = issue()
    expected = external_credential_hash(issued.compact)
    jwt = issued.issuer_jwt
    for _ in range(CASES):
        at = rng.randrange(len(jwt))
        if jwt[at] == ".":
            continue
        replacement = jwt[at]
        while replacement == jwt[at]:
            replacement = rng.choice(ALPHABET)
        mutated = jwt[:at] + replacement + jwt[at + 1 :]
        assert external_credential_hash(mutated + "~") != expected
    assert external_credential_hash(issue().compact) != expected


@pytest.mark.parametrize("bad", ["", "~", "a.b~", "x.y.z ~", "é.b.c~"])
def test_hash_refuses_input_that_is_not_an_sd_jwt(bad: str) -> None:
    with pytest.raises(PassportError):
        external_credential_hash(bad)
    with pytest.raises(PassportError):
        external_credential_hash(issue().issuer_jwt)


# -- key rule -----------------------------------------------------------------


def test_thumbprint_matches_the_rfc_examples() -> None:
    rsa = {
        "kty": "RSA",
        "n": (
            "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFx"
            "uhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_R"
            "N5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvR"
            "L5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_x"
            "BniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw"
        ),
        "e": "AQAB",
        "alg": "RS256",
        "kid": "2011-04-29",
    }
    # RFC 7638 section 3.1
    assert jwk_thumbprint(rsa) == "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
    okp = {"kty": "OKP", "crv": "Ed25519", "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}
    # RFC 8037 appendix A.3
    assert jwk_thumbprint(okp) == "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k"


def test_thumbprint_ignores_optional_members_and_order() -> None:
    rng = seeded(0x7B)
    for i in range(40):
        pair = p256_key_pair() if rng.random() < 0.5 else ed25519_key_pair()
        base = jwk_thumbprint(pair.public_jwk)
        extras: Dict[str, Any] = {
            "kid": f"k{i}",
            "use": "sig",
            "alg": "ES256",
            "key_ops": ["verify"],
            "ext": True,
        }
        decorated = dict(pair.public_jwk)
        for key, value in extras.items():
            if rng.random() < 0.5:
                decorated[key] = value
        items = list(decorated.items())
        rng.shuffle(items)
        reordered = dict(items)
        assert jwk_thumbprint(reordered) == base
        assert keys_equal(reordered, pair.public_jwk)
        assert keys_equal(pair.private_jwk, pair.public_jwk)


def test_thumbprint_changes_with_any_required_member() -> None:
    rng = seeded(0x99)
    a = p256_key_pair()
    b = p256_key_pair()
    assert not keys_equal(a.public_jwk, b.public_jwk)
    assert not keys_equal(a.public_jwk, ed25519_key_pair().public_jwk)
    base = jwk_thumbprint(a.public_jwk)
    for _ in range(CASES):
        member = rng.choice(["x", "y"])
        raw = bytearray(base64.urlsafe_b64decode(a.public_jwk[member] + "=="))
        at = rng.randrange(len(raw))
        raw[at] ^= rng.randrange(1, 256)
        changed = dict(a.public_jwk, **{member: b64(bytes(raw))})
        assert jwk_thumbprint(changed) != base
    assert jwk_thumbprint(dict(a.public_jwk, crv="P-384")) != base


def test_thumbprint_refuses_incomplete_or_unknown_keys() -> None:
    a = p256_key_pair()
    no_y = {k: v for k, v in a.public_jwk.items() if k != "y"}
    with pytest.raises(PassportError):
        jwk_thumbprint(no_y)
    with pytest.raises(PassportError):
        jwk_thumbprint({"kty": "XYZ"})
    with pytest.raises(PassportError):
        jwk_thumbprint(dict(a.public_jwk, x=7))
    with pytest.raises(PassportError):
        keys_equal(no_y, a.public_jwk)

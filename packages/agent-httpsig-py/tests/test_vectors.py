# SPDX-License-Identifier: Apache-2.0
"""The shared vectors in spec/examples/agent-httpsig-vectors.json.

The TypeScript package (packages/agent-httpsig/tests/vectors.test.ts) runs
the same file, so the two libraries sign identically and refuse the same
requests with the same code and reason.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from grantex_agent_httpsig import (
    AGENT_PAYER_AUTH_TAG,
    COVERED_COMPONENTS,
    DEFAULT_CLOCK_SKEW_SECONDS,
    INLINE_PRESENTATION_MAX_OCTETS,
    MAX_SIGNATURE_WINDOW_SECONDS,
    SIGNATURE_PARAMETERS,
    HttpRequest,
    InMemoryNonceStore,
    content_digest,
    jwk_thumbprint,
    public_jwk,
    sign,
    verify,
)

from .conftest import VECTORS, vector_private_key


def test_profile_constants_match_the_vectors() -> None:
    profile = VECTORS["profile"]
    assert AGENT_PAYER_AUTH_TAG == profile["tag"]
    assert list(COVERED_COMPONENTS) == profile["covered_components"]
    assert list(SIGNATURE_PARAMETERS) == profile["parameters"]
    assert MAX_SIGNATURE_WINDOW_SECONDS == profile["max_window_seconds"]
    assert DEFAULT_CLOCK_SKEW_SECONDS == profile["default_clock_skew_seconds"]
    assert INLINE_PRESENTATION_MAX_OCTETS == profile["inline_presentation_max_octets"]


def test_vector_keys_and_thumbprints() -> None:
    key = vector_private_key("ed25519-1")
    assert public_jwk(key) == VECTORS["keys"]["ed25519-1"]["public_jwk"]
    assert jwk_thumbprint(key) == VECTORS["keys"]["ed25519-1"]["thumbprint"]
    p256 = VECTORS["keys"]["p256-1"]
    assert jwk_thumbprint(p256["public_jwk"]) == p256["thumbprint"]


@pytest.mark.parametrize("case", VECTORS["thumbprints"])
def test_thumbprints(case: dict[str, Any]) -> None:
    assert jwk_thumbprint(case["jwk"]) == case["thumbprint"]


@pytest.mark.parametrize("case", VECTORS["content_digest"])
def test_content_digest(case: dict[str, Any]) -> None:
    assert content_digest(case["body"]) == case["field"]


@pytest.mark.parametrize("v", VECTORS["sign"], ids=lambda v: v["name"])
def test_sign_vectors(v: dict[str, Any]) -> None:
    presentations = v["presentations"]
    req = v["request"]
    result = sign(
        HttpRequest(req["method"], req["url"], {}, req["body"]),
        key=vector_private_key(v["key"]),
        agent_passport=presentations["agent_passport"],
        agent_grant=presentations["agent_grant"],
        agent_trust=presentations.get("agent_trust"),
        created=v["params"]["created"],
        expires=v["params"]["expires"],
        nonce=v["params"]["nonce"],
        label=v["params"]["label"],
    )
    assert result.signature_base == v["signature_base"]
    assert [list(item) for item in result.headers.items()] == v["headers"]
    assert result.keyid == VECTORS["keys"][v["key"]]["thumbprint"]


def _verify_cases() -> list[dict[str, Any]]:
    cases = list(VECTORS["verify"])
    for v in VECTORS["ecdsa"]:
        cases.append(
            {
                "name": "ecdsa vector: " + v["name"],
                "key": v["key"],
                "key_known": True,
                "request": {**v["request"], "headers": v["headers"]},
                "expected_authority": "merchant.example",
                "now": v["params"]["created"] + 10,
                "seen_nonces": [],
                "expected": {"ok": True},
            }
        )
    return cases


@pytest.mark.parametrize("v", _verify_cases(), ids=lambda v: v["name"])
def test_verify_vectors(v: dict[str, Any]) -> None:
    store = InMemoryNonceStore(clock=lambda: v["now"])
    for keyid, nonce in v["seen_nonces"]:
        assert store.check_and_store(keyid, nonce, v["now"] + 3600) is True
    key = VECTORS["keys"][v["key"]]["public_jwk"]

    def resolve_key(keyid: str) -> Optional[dict[str, Any]]:
        return key if v["key_known"] else None

    r = v["request"]
    result = verify(
        HttpRequest(r["method"], r["url"], [tuple(h) for h in r["headers"]], r["body"]),
        expected_authority=v["expected_authority"],
        now=v["now"],
        nonce_store=store,
        resolve_key=resolve_key,
    )
    expected = v["expected"]
    if expected["ok"]:
        assert result.ok, (result.code, result.reason)
    else:
        assert (result.ok, result.code, result.reason) == (
            False,
            expected["code"],
            expected["reason"],
        )

# SPDX-License-Identifier: Apache-2.0
"""spec/examples/agent-httpsig-profile-vectors.json, byte for byte.

The TypeScript package runs the same file (tests/profile-vectors.test.ts).
"""

from __future__ import annotations

import json
from typing import Any, Dict

import pytest

from grantex_agent_httpsig import (
    HttpRequest,
    InMemoryNonceStore,
    build_agentic_consumer,
    build_agentic_payment_container,
    jwk_thumbprint,
    public_jwk,
    sign_with_profile,
    verify_tap_body_objects,
    verify_with_profile,
)

from .conftest import REPO_ROOT, vector_private_key

FILE: Dict[str, Any] = json.loads(
    (REPO_ROOT / "spec" / "examples" / "agent-httpsig-profile-vectors.json").read_text(encoding="utf-8")
)
KEY = vector_private_key(FILE["key"])


def _request(extra: Any = ()) -> HttpRequest:
    r = FILE["request"]
    return HttpRequest(r["method"], r["url"], [tuple(h) for h in r["headers"]] + [tuple(h) for h in extra], r["body"])


def test_vector_key() -> None:
    assert public_jwk(KEY) == FILE["public_jwk"]
    assert jwk_thumbprint(KEY) == FILE["thumbprint"]


@pytest.mark.parametrize("case", FILE["sign"], ids=lambda c: c["name"])
def test_profile_sign_vectors(case: Dict[str, Any]) -> None:
    signed = sign_with_profile(_request(), key=KEY, **case["options"])
    assert signed.signature_base == case["signature_base"]
    assert [list(h) for h in signed.headers.items()] == case["headers"]
    out = verify_with_profile(
        _request(case["headers"]),
        profile=case["options"]["profile"],
        expected_authority="merchant.example",
        now=case["options"]["created"] + 1,
        nonce_store=InMemoryNonceStore(),
        resolve_key=lambda _ref: FILE["public_jwk"],
    )
    assert out.ok, out.reason


def test_tap_body_object_vectors() -> None:
    t = FILE["tap_body_objects"]
    consumer = build_agentic_consumer(
        key=KEY, kid=t["kid"], nonce=t["nonce"], id_token=t["agenticConsumer"]["idToken"],
        contextual_data=t["agenticConsumer"]["contextualData"],
    )
    container = build_agentic_payment_container(
        key=KEY, kid=t["kid"], nonce=t["nonce"],
        payment_credentials_hash=t["agenticPaymentContainer"]["paymentCredentialsHash"],
    )
    assert consumer == t["agenticConsumer"]
    assert container == t["agenticPaymentContainer"]
    out = verify_tap_body_objects(t, nonce=t["nonce"], keyid=t["kid"], resolve_key=lambda _k: FILE["public_jwk"])
    assert out.consumer.verified and out.usable_for_payment

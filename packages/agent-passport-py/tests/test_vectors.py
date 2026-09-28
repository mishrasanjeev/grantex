# SPDX-License-Identifier: Apache-2.0
"""Shared vectors.

spec/examples/agent-passport-vectors.json is checked by this suite and by
packages/agent-passport/tests/vectors.test.ts, so both libraries accept and
refuse exactly the same inputs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from grantex_agent_passport import (
    KeyBindingRequirement,
    PassportError,
    external_credential_hash,
    jwk_thumbprint,
    keys_equal,
    verify_passport,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[3] / "spec" / "examples" / "agent-passport-vectors.json"
)
VECTORS: Dict[str, Any] = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def _verify(vector: Dict[str, Any]) -> Any:
    options = vector["options"]
    kb = options.get("keyBinding")
    return verify_passport(
        vector["compact"],
        issuer_keys=lambda iss: VECTORS["issuers"].get(iss, []),
        now=options["now"],
        expected_vct=options.get("expectedVct", "urn:grantex:agent-passport:1"),
        payments_rails=options.get("paymentsRails", False),
        allow_eddsa=options.get("allowEdDSA", False),
        clock_skew_seconds=options.get("clockSkewSeconds", 0),
        key_binding=None
        if kb is None
        else KeyBindingRequirement(
            aud=kb["aud"],
            nonce=kb["nonce"],
            max_age_seconds=kb.get("maxAgeSeconds", 300),
        ),
    )


@pytest.mark.parametrize(
    "vector", VECTORS["verify"], ids=[v["name"] for v in VECTORS["verify"]]
)
def test_verify_vector(vector: Dict[str, Any]) -> None:
    expected = vector["expect"]
    if expected["ok"]:
        result = _verify(vector)
        assert result.disclosed == expected["disclosed"]
        assert result.cnf_thumbprint == expected["cnfThumbprint"]
        assert result.external_credential_hash == expected["externalCredentialHash"]
        assert result.key_binding == expected.get("keyBinding")
    else:
        with pytest.raises(PassportError) as info:
            _verify(vector)
        assert (info.value.code, info.value.reason) == (
            expected["code"],
            expected["reason"],
        )


@pytest.mark.parametrize("vector", VECTORS["hash"], ids=[v["name"] for v in VECTORS["hash"]])
def test_hash_vector(vector: Dict[str, Any]) -> None:
    assert external_credential_hash(vector["input"]) == vector["hash"]


@pytest.mark.parametrize(
    "vector", VECTORS["thumbprints"], ids=[v["name"] for v in VECTORS["thumbprints"]]
)
def test_thumbprint_vector(vector: Dict[str, Any]) -> None:
    assert jwk_thumbprint(vector["jwk"]) == vector["thumbprint"]


@pytest.mark.parametrize(
    "vector", VECTORS["keysEqual"], ids=[v["name"] for v in VECTORS["keysEqual"]]
)
def test_keys_equal_vector(vector: Dict[str, Any]) -> None:
    assert keys_equal(vector["a"], vector["b"]) is vector["equal"]

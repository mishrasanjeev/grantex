"""verify_oacp_mandate and check_oacp_mandate_chain against the shared mandate
vectors (spec/examples/oacp/oacp-mandates-v1.json), the file the auth service
and the TypeScript SDK also run, plus the status-list path with a Status List
Token signed by a key generated here."""

from __future__ import annotations

import asyncio
import base64
import json
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from grantex.oacp import (
    OACP_MANDATE_REFUSAL_CODES,
    check_oacp_mandate_chain,
    oacp_checkout_hash,
    oacp_mandate_hash,
    verify_oacp_mandate,
)

VECTORS: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "oacp" / "oacp-mandates-v1.json").read_text(encoding="utf-8")
)
NOW = datetime.fromtimestamp(VECTORS["verify_at"], tz=timezone.utc)
BASE = dict(issuer=VECTORS["issuer"], jwks=VECTORS["jwks"], now=NOW, expected_audience=VECTORS["expected_audience"])


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def test_checkout_hash_matches_vectors() -> None:
    assert oacp_checkout_hash(VECTORS["checkout"]) == VECTORS["checkout_hash"]


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vector_case(case: Dict[str, Any]) -> None:
    options = dict(BASE)
    if case.get("expected_type"):
        options["expected_type"] = case["expected_type"]
    if case.get("expected_audience"):
        options["expected_audience"] = case["expected_audience"]
    result = asyncio.run(verify_oacp_mandate(case["mandate"], **options, status=case.get("status", 0)))
    if case["expect"] is None:
        assert result.valid, result
        assert result.status == "valid"
        assert result.mandate_hash == oacp_mandate_hash(case["mandate"])
    else:
        assert not result.valid
        assert result.refusal_code == case["expect"]
        assert result.refusal_code in OACP_MANDATE_REFUSAL_CODES


@pytest.mark.parametrize("chain", VECTORS["chains"], ids=[c["name"] for c in VECTORS["chains"]])
def test_vector_chain(chain: Dict[str, Any]) -> None:
    claims = {}
    for member in ("intent", "cart", "payment"):
        if chain.get(member):
            result = asyncio.run(verify_oacp_mandate(chain[member], **BASE, check_status=False))
            assert result.valid, (member, result)
            claims[member] = result.claims
    assert check_oacp_mandate_chain(**claims) == chain["expect"]


def test_status_list_is_read_and_fails_closed() -> None:
    intent = next(c for c in VECTORS["cases"] if c["name"] == "valid_intent")["mandate"]
    entry = json.loads(base64.urlsafe_b64decode(intent.split(".")[1] + "=="))["status"]["status_list"]
    key = ec.generate_private_key(ec.SECP256R1())
    numbers = key.public_key().public_numbers()
    jwks = {"keys": VECTORS["jwks"]["keys"] + [{
        "kty": "EC", "crv": "P-256", "kid": "status-test-es", "alg": "ES256", "use": "sig",
        "x": b64u(numbers.x.to_bytes(32, "big")), "y": b64u(numbers.y.to_bytes(32, "big")),
    }]}

    def token(status: int) -> str:
        data = bytearray(16)
        data[entry["idx"] // 4] |= status << ((entry["idx"] % 4) * 2)
        header = b64u(json.dumps({"alg": "ES256", "kid": "status-test-es", "typ": "statuslist+jwt"}).encode())
        claims = b64u(json.dumps({
            "iss": VECTORS["issuer"], "sub": entry["uri"], "iat": VECTORS["verify_at"] - 30,
            "exp": VECTORS["verify_at"] + 3600, "ttl": 30,
            "status_list": {"bits": 2, "lst": b64u(zlib.compress(bytes(data)))},
        }).encode())
        r, s = decode_dss_signature(key.sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
        return f"{header}.{claims}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"

    options = dict(BASE, jwks=jwks)
    for status, expected in ((0, None), (1, "mandate_revoked"), (2, "mandate_suspended")):
        async def fetch(uri: str, status: int = status) -> str:
            assert uri == entry["uri"]
            return token(status)

        result = asyncio.run(verify_oacp_mandate(intent, **options, status_list_fetcher=fetch))
        assert (None if result.valid else result.refusal_code) == expected
    assert asyncio.run(verify_oacp_mandate(intent, **options)).refusal_code == "revocation_status_unavailable"


EXTRA: Dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "oacp" / "oacp-mandates-v1-extra.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", EXTRA["cases"], ids=[c["name"] for c in EXTRA["cases"]])
def test_extra_vector_case(case: Dict[str, Any]) -> None:
    result = asyncio.run(verify_oacp_mandate(
        case["mandate"], issuer=EXTRA["issuer"], jwks=EXTRA["jwks"],
        now=datetime.fromtimestamp(EXTRA["verify_at"], tz=timezone.utc),
        expected_audience=EXTRA["expected_audience"], expected_type=case.get("expected_type"),
        status=case.get("status", 0),
    ))
    assert (None if result.valid else result.refusal_code) == case["expect"]


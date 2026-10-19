"""verify_oacp_artifact against the shared OACP vectors
(spec/examples/oacp/oacp-artifact-jws-v1.json) and Token Status List tokens
built here with keys generated for the test."""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional, TypeVar, Union

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from grantex.canonical import canonicalize
from grantex.oacp import (
    OACP_ARTIFACT_MAX_TTL_SECONDS,
    OACP_REFUSAL_CODES,
    OACP_TOKEN_STATUS,
    OacpStatusListError,
    create_oacp_jwks_fetcher,
    create_oacp_status_list_fetcher,
    decode_oacp_status_list,
    parse_oacp_timestamp,
    read_oacp_status,
    verify_oacp_artifact,
)

T = TypeVar("T")

VECTORS_PATH = (
    Path(__file__).resolve().parents[3] / "spec" / "examples" / "oacp" / "oacp-artifact-jws-v1.json"
)
VECTORS: Dict[str, Any] = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
ISSUER = "https://issuer.example"
NOW = datetime.fromisoformat(VECTORS["verify_at"].replace("Z", "+00:00"))
NOW_S = int(NOW.timestamp())
VALID = next(case for case in VECTORS["cases"] if case["name"] == "valid")
STATUS_URI: str = VECTORS["status_list"]["uri"]
STATUS_IDX: int = VECTORS["status_list"]["idx"]


def run(coro: Awaitable[T]) -> T:
    return asyncio.run(coro)  # type: ignore[arg-type]


def b64u(value: Union[str, bytes]) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_int(value: int, length: int) -> str:
    return b64u(value.to_bytes(length, "big"))


def compact(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


# Status lists are signed with keys generated for this run, published beside the vector keys.
STATUS_KEY = ec.generate_private_key(ec.SECP256R1())
RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
STRANGER_KEY = ec.generate_private_key(ec.SECP256R1())


def ec_jwk(key: ec.EllipticCurvePrivateKey, kid: str) -> Dict[str, Any]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "EC",
        "crv": "P-256",
        "x": b64u_int(numbers.x, 32),
        "y": b64u_int(numbers.y, 32),
        "kid": kid,
        "alg": "ES256",
        "use": "sig",
    }


def rsa_jwk(key: rsa.RSAPrivateKey, kid: str) -> Dict[str, Any]:
    numbers = key.public_key().public_numbers()
    return {
        "kty": "RSA",
        "n": b64u_int(numbers.n, (numbers.n.bit_length() + 7) // 8),
        "e": b64u_int(numbers.e, (numbers.e.bit_length() + 7) // 8),
        "kid": kid,
        "alg": "RS256",
        "use": "sig",
    }


JWKS: Dict[str, Any] = {
    "keys": [*VECTORS["jwks"]["keys"], ec_jwk(STATUS_KEY, "status-test-es"), rsa_jwk(RSA_KEY, "status-test-rs")]
}


def es256(key: ec.EllipticCurvePrivateKey, signing_input: str) -> bytes:
    r, s = decode_dss_signature(key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def lst(statuses: Mapping[int, int], size: int = 64, bits: int = 2) -> str:
    per_byte = 8 // bits
    data = bytearray(-(-size // per_byte))
    for idx, status in statuses.items():
        data[idx // per_byte] |= status << ((idx % per_byte) * bits)
    return b64u(zlib.compress(bytes(data)))


_UNSET = object()


def status_token(
    status: int,
    *,
    claims: Optional[Mapping[str, Any]] = None,
    header: Optional[Mapping[str, Any]] = None,
    key: Optional[ec.EllipticCurvePrivateKey] = None,
    alg: str = "ES256",
) -> str:
    head: Dict[str, Any] = {
        "alg": alg,
        "kid": "status-test-es" if alg == "ES256" else "status-test-rs",
        "typ": "statuslist+jwt",
        **(header or {}),
    }
    body: Dict[str, Any] = {
        "iss": ISSUER,
        "sub": STATUS_URI,
        "iat": NOW_S - 60,
        "exp": NOW_S + 3600,
        "ttl": 600,
        "status_list": {"bits": 2, "lst": lst({STATUS_IDX: status})},
    }
    for name, value in (claims or {}).items():
        if value is _UNSET:
            body.pop(name, None)
        else:
            body[name] = value
    signing_input = f"{b64u(compact(head))}.{b64u(compact(body))}"
    if alg == "ES256":
        signature = es256(key or STATUS_KEY, signing_input)
    else:
        signature = RSA_KEY.sign(signing_input.encode("ascii"), padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input}.{b64u(signature)}"


# The vector test key re-signs edited envelopes, so checks after the signature can be reached.
_PRIVATE = VECTORS["test_private_jwk"]
ARTIFACT_KEY = ec.derive_private_key(
    int.from_bytes(base64.urlsafe_b64decode(_PRIVATE["d"] + "=="), "big"), ec.SECP256R1()
)


def signed(envelope: Mapping[str, Any], payload: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    out = {name: value for name, value in envelope.items() if name != "signature"}
    if payload is not None:
        out["payload_hash"] = hashlib.sha256(canonicalize(payload).encode("utf-8")).hexdigest()
    header = b64u(compact({"alg": "ES256", "kid": out["issuer_key_id"], "typ": "oacp-artifact+jws"}))
    signing_input = f"{header}.{b64u(canonicalize(out))}"
    out["signature"] = f"{header}..{b64u(es256(ARTIFACT_KEY, signing_input))}"
    return out


def edited(**members: Any) -> Dict[str, Any]:
    envelope = copy.deepcopy(VALID["envelope"])
    envelope.update(members)
    return signed(envelope)


def verify(envelope: Any = None, payload: Any = None, **options: Any) -> Any:
    kwargs: Dict[str, Any] = {"issuer": ISSUER, "jwks": JWKS, "now": NOW}
    kwargs.update(options)
    return run(
        verify_oacp_artifact(
            VALID["envelope"] if envelope is None else envelope,
            VALID["payload"] if payload is None else payload,
            **kwargs,
        )
    )


# ─── OACP vectors ────────────────────────────────────────────────────────────


def test_canonicalises_payload_and_signing_input_as_the_vectors_do() -> None:
    assert canonicalize(VALID["payload"]) == VECTORS["payload_canonical"]
    unsigned = {k: v for k, v in VALID["envelope"].items() if k != "signature"}
    assert canonicalize(unsigned) == VECTORS["signing_payload_canonical"]
    assert hashlib.sha256(VECTORS["payload_canonical"].encode("utf-8")).hexdigest() == VECTORS["payload_hash"]


@pytest.mark.parametrize("vector", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vector(vector: Dict[str, Any]) -> None:
    result = verify(vector["envelope"], vector["payload"], check_status=False)
    if vector["expect"] == "valid":
        assert result.valid is True
        assert result.status == "not_checked"
        assert result.payload_hash == VECTORS["payload_hash"]
        assert result.refusal_code is None
    else:
        assert result.valid is False
        assert result.refusal_code == vector["expect"], result.message


def test_refusal_codes_are_in_check_order() -> None:
    assert len(OACP_REFUSAL_CODES) == 13
    assert OACP_REFUSAL_CODES[0] == "artifact_missing_or_invalid"
    assert OACP_REFUSAL_CODES[-1] == "revocation_status_unavailable"
    assert all(case["expect"] in OACP_REFUSAL_CODES for case in VECTORS["cases"] if case["expect"] != "valid")


def test_resigned_valid_envelope_still_verifies() -> None:
    result = verify(signed(VALID["envelope"]), check_status=False)
    assert result.valid is True
    assert result.artifact_id == "oacp_art_01TESTCATALOG"
    assert result.artifact_type == "catalog_snapshot"
    assert result.issuer_key_id == "oacp-test-2026-10-a"
    assert result.expires_at == VALID["envelope"]["expires_at"]


# ─── checks after the signature ──────────────────────────────────────────────


def test_refuses_an_artifact_naming_another_issuer() -> None:
    result = verify(issuer="https://other.example", check_status=False)
    assert result.refusal_code == "issuer_key_untrusted"


def test_refuses_when_the_jwks_holds_the_kid_twice() -> None:
    duplicated = {"keys": [*JWKS["keys"], VECTORS["jwks"]["keys"][0]]}
    result = verify(jwks=duplicated, check_status=False)
    assert result.refusal_code == "issuer_key_untrusted"
    assert "several keys" in result.message


def test_refuses_a_key_published_for_another_use() -> None:
    keys = [
        {**k, "use": "enc"} if k["kid"] == "oacp-test-2026-10-a" else k for k in JWKS["keys"]
    ]
    result = verify(jwks={"keys": keys}, check_status=False)
    assert result.refusal_code == "issuer_key_untrusted"


@pytest.mark.parametrize(
    "change",
    [
        {"alg": "RS256"},
        {"kty": "RSA"},
        {"crv": "P-384"},
        {"d": "AAAA"},
        {"x": "AAAA"},
    ],
)
def test_refuses_an_unusable_key(change: Dict[str, Any]) -> None:
    keys = [{**k, **change} if k["kid"] == "oacp-test-2026-10-a" else k for k in JWKS["keys"]]
    assert verify(jwks={"keys": keys}, check_status=False).refusal_code == "issuer_key_untrusted"


def test_refetches_a_jwks_source_once_for_an_unknown_kid() -> None:
    calls: List[Optional[bool]] = []

    async def source(refresh: Optional[bool] = None) -> Dict[str, Any]:
        calls.append(refresh)
        return JWKS if refresh else {"keys": []}

    result = verify(jwks=source, check_status=False)
    assert result.valid is True
    assert calls == [None, True]


def test_refuses_when_the_jwks_cannot_be_loaded() -> None:
    async def source(refresh: bool = False) -> Dict[str, Any]:
        raise OSError("offline")

    assert verify(jwks=source, check_status=False).refusal_code == "issuer_key_untrusted"


def test_refuses_an_expired_artifact() -> None:
    result = verify(now=datetime(2026, 10, 19, 16, 0, 1, tzinfo=timezone.utc), check_status=False)
    assert result.refusal_code == "artifact_expired_or_stale"


def test_accepts_at_the_expiry_instant_and_reads_naive_now_as_utc() -> None:
    assert verify(now=datetime(2026, 10, 19, 16, 0, 0, tzinfo=timezone.utc), check_status=False).valid
    assert verify(now=datetime(2026, 10, 19, 11, 0, 0), check_status=False).valid
    assert (
        verify(now=datetime(2026, 10, 19, 16, 0, 1), check_status=False).refusal_code
        == "artifact_expired_or_stale"
    )


def test_applies_a_stricter_ttl_override() -> None:
    result = verify(max_ttl_seconds={"catalog_snapshot": 60}, check_status=False)
    assert result.refusal_code == "artifact_ttl_exceeds_default"


def test_compares_each_scope_member_given_including_an_empty_buyer() -> None:
    ok = verify(
        check_status=False,
        expected_scope={"tenant_id": "cten_TEST01", "merchant_id": "mch_TEST01", "buyer_agent_id": ""},
    )
    assert ok.valid is True
    other = verify(check_status=False, expected_scope={"seller_agent_id": "seller_OTHER"})
    assert other.refusal_code == "artifact_scope_mismatch"


def test_refuses_non_object_inputs() -> None:
    assert run(
        verify_oacp_artifact(None, VALID["payload"], issuer=ISSUER, jwks=JWKS, now=NOW)
    ).refusal_code == "artifact_missing_or_invalid"
    assert verify(payload=[]).refusal_code == "artifact_missing_or_invalid"


@pytest.mark.parametrize(
    "safety_change",
    [{"public_safe": 1}, {"public_safe": "true"}, {"contains_private_data": 0}, {"contains_private_data": None}],
)
def test_safety_flags_must_be_json_booleans(safety_change: Dict[str, Any]) -> None:
    safety = {**VALID["envelope"]["safety"], **safety_change}
    result = verify(edited(safety=safety), check_status=False)
    assert result.refusal_code == "artifact_missing_or_invalid"


def test_refuses_unknown_type_and_bad_timestamps_after_the_signature() -> None:
    assert verify(edited(artifact_type="constructor"), check_status=False).refusal_code == "artifact_missing_or_invalid"
    assert verify(edited(issued_at="2026-10-19 10:00:00Z"), check_status=False).refusal_code == "artifact_missing_or_invalid"
    assert verify(edited(not_before=None), check_status=False).refusal_code == "artifact_missing_or_invalid"
    assert verify(edited(not_before="2026-10-19T12:00:00Z"), check_status=False).refusal_code == "artifact_not_yet_valid"
    assert verify(edited(not_before="2026-10-19T10:30:00Z"), check_status=False).valid is True
    assert verify(edited(issued_at="2026-10-19T17:00:00Z"), check_status=False).refusal_code == "artifact_ttl_exceeds_default"


@pytest.mark.parametrize("name", ["apiKey", "Webhook-Secret", "raw jwt", "accessToken"])
def test_refuses_private_or_enabling_payload_fields(name: str) -> None:
    payload = {**VALID["payload"], "nested": [{"inner": {name: "redacted"}}]}
    envelope = signed(VALID["envelope"], payload)
    result = verify(envelope, payload, check_status=False)
    assert result.refusal_code == "artifact_missing_or_invalid"
    assert "private" in result.message


def test_parse_oacp_timestamp() -> None:
    assert parse_oacp_timestamp("1970-01-01T00:00:00Z") == 0
    assert parse_oacp_timestamp("2026-10-19T11:00:00.000Z") == NOW_S * 1000
    assert parse_oacp_timestamp("2026-10-19T16:30:00+05:30") == NOW_S * 1000
    assert parse_oacp_timestamp("1970-01-01T00:00:00.0019Z") == 1
    assert parse_oacp_timestamp("1969-12-31T23:59:59Z") == -1000
    assert parse_oacp_timestamp("2024-02-29T00:00:00Z") is not None
    # Date.UTC (and the other SDKs) read years 0-99 as 1900-1999.
    assert parse_oacp_timestamp("0050-01-01T00:00:00Z") == parse_oacp_timestamp("1950-01-01T00:00:00Z")
    for bad in [
        "2026-02-29T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-10-19T24:00:00Z",
        "2026-10-19T23:59:60Z",
        "2026-10-19t11:00:00Z",
        "2026-10-19T11:00:00",
        "2026-10-19T11:00:00Z\n",
        "2026-10-19T11:00:00.1234567890Z",
        "2026-10-19T11:00:00+24:00",
        "٢026-10-19T11:00:00Z",
        20261019,
        None,
    ]:
        assert parse_oacp_timestamp(bad) is None, bad


# ─── Token Status List check ─────────────────────────────────────────────────


def with_list(token: Union[str, Callable[[], str]]) -> Dict[str, Any]:
    async def fetcher(uri: str) -> str:
        assert uri == STATUS_URI
        return token if isinstance(token, str) else token()

    return {"status_list_fetcher": fetcher}


def test_accepts_a_valid_entry() -> None:
    result = verify(**with_list(status_token(OACP_TOKEN_STATUS.VALID)))
    assert result.valid is True
    assert result.status == "valid"
    assert result.artifact_id == "oacp_art_01TESTCATALOG"


def test_accepts_a_list_signed_with_an_rs256_key_from_the_same_jwks() -> None:
    result = verify(**with_list(status_token(0, alg="RS256")))
    assert result.valid is True
    assert result.status == "valid"


def test_refuses_an_invalid_entry_as_revoked() -> None:
    assert verify(**with_list(status_token(OACP_TOKEN_STATUS.INVALID))).refusal_code == "artifact_revoked"


def test_refuses_a_suspended_entry_as_suspended() -> None:
    assert verify(**with_list(status_token(OACP_TOKEN_STATUS.SUSPENDED))).refusal_code == "artifact_suspended"


def test_fails_closed_on_an_unknown_status_value() -> None:
    assert verify(**with_list(status_token(3))).refusal_code == "revocation_status_unavailable"


def test_fails_closed_when_the_list_is_unreachable() -> None:
    def unreachable() -> str:
        raise ConnectionRefusedError("ECONNREFUSED")

    assert verify(**with_list(unreachable)).refusal_code == "revocation_status_unavailable"


def test_fails_closed_without_a_status_list_fetcher() -> None:
    result = verify()
    assert result.refusal_code == "revocation_status_unavailable"
    assert "fetcher" in result.message


BROKEN: List[Any] = [
    ("signed by a key outside the jwks", lambda: status_token(0, key=STRANGER_KEY)),
    ("for another list", lambda: status_token(0, claims={"sub": "https://issuer.example/status/oacp/lst_OTHER"})),
    ("from another issuer", lambda: status_token(0, claims={"iss": "https://other.example"})),
    ("expired", lambda: status_token(0, claims={"exp": NOW_S - 1})),
    ("without exp or ttl", lambda: status_token(0, claims={"exp": _UNSET, "ttl": _UNSET})),
    ("older than its ttl", lambda: status_token(0, claims={"exp": _UNSET, "iat": NOW_S - 601})),
    ("issued in the future", lambda: status_token(0, claims={"iat": NOW_S + 3600, "exp": NOW_S + 7200})),
    ("with a boolean iat", lambda: status_token(0, claims={"iat": True})),
    ("with a zero ttl", lambda: status_token(0, claims={"ttl": 0})),
    ("with the wrong typ", lambda: status_token(0, header={"typ": "JWT"})),
    ("with crit", lambda: status_token(0, header={"crit": ["exp"]})),
    ("too short for the index", lambda: status_token(0, claims={"status_list": {"bits": 2, "lst": lst({}, 4)}})),
    ("with a bad bit width", lambda: status_token(0, claims={"status_list": {"bits": 3, "lst": lst({})}})),
    ("with a boolean bit width", lambda: status_token(0, claims={"status_list": {"bits": True, "lst": lst({})}})),
    ("not zlib data", lambda: status_token(0, claims={"status_list": {"bits": 2, "lst": b64u("not zlib")}})),
    ("not a jws", lambda: "not-a-jws"),
]


@pytest.mark.parametrize("label,token", BROKEN, ids=[label for label, _ in BROKEN])
def test_fails_closed_on_a_broken_list(label: str, token: Callable[[], str]) -> None:
    result = verify(**with_list(token()))
    assert result.valid is False
    assert result.refusal_code == "revocation_status_unavailable", result.message


def test_catches_an_edited_status_reference_with_the_signature_first() -> None:
    envelope = {**VALID["envelope"], "revocation_status_url": "https://issuer.example/status/oacp/lst_OTHER"}
    result = verify(envelope, **with_list(status_token(0)))
    assert result.refusal_code == "detached_jws_verification_failed"


@pytest.mark.parametrize(
    "reference",
    [
        {"idx": True, "uri": STATUS_URI},
        {"idx": -1, "uri": STATUS_URI},
        {"idx": "7", "uri": STATUS_URI},
        {"idx": 7.5, "uri": STATUS_URI},
        {"idx": 7, "uri": "http://issuer.example/status/oacp/lst_01TEST"},
    ],
)
def test_refuses_a_malformed_signed_status_reference(reference: Dict[str, Any]) -> None:
    envelope = edited(status={"status_list": reference}, revocation_status_url=reference["uri"])
    result = verify(envelope, **with_list(status_token(0)))
    assert result.refusal_code == "revocation_status_unavailable"
    assert "malformed" in result.message


def test_loopback_http_status_uri_only_when_allowed() -> None:
    uri = "http://127.0.0.1:3001/status/oacp/lst_01TEST"
    envelope = edited(status={"status_list": {"idx": STATUS_IDX, "uri": uri}}, revocation_status_url=uri)
    token = status_token(0, claims={"sub": uri})

    async def fetcher(_uri: str) -> str:
        return token

    assert verify(envelope, status_list_fetcher=fetcher).refusal_code == "revocation_status_unavailable"
    assert verify(envelope, status_list_fetcher=fetcher, allow_loopback_http=True).status == "valid"


def test_read_oacp_status_directly() -> None:
    read = read_oacp_status(
        token=status_token(2), uri=STATUS_URI, idx=STATUS_IDX, jwks=JWKS, issuer=ISSUER, now=NOW
    )
    assert read.status == OACP_TOKEN_STATUS.SUSPENDED
    assert read.ttl_seconds == 600
    no_ttl = read_oacp_status(
        token=status_token(0, claims={"ttl": _UNSET}), uri=STATUS_URI, idx=0, jwks=JWKS, issuer=ISSUER, now=NOW
    )
    assert no_ttl.ttl_seconds is None
    with pytest.raises(OacpStatusListError):
        read_oacp_status(token=status_token(0), uri=STATUS_URI, idx=64, jwks=JWKS, issuer=ISSUER, now=NOW)


# ─── decode_oacp_status_list ─────────────────────────────────────────────────


def test_reads_entries_from_the_least_significant_bits_of_each_byte() -> None:
    status_list = decode_oacp_status_list({"bits": 2, "lst": lst({0: 1, 1: 2, 5: 1}, 8)})
    assert status_list.size == 8
    assert [status_list.status_at(i) for i in range(8)] == [1, 2, 0, 0, 0, 1, 0, 0]
    with pytest.raises(OacpStatusListError):
        status_list.status_at(8)
    with pytest.raises(OacpStatusListError):
        status_list.status_at(True)  # type: ignore[arg-type]


def test_matches_the_draft_1_bit_example() -> None:
    # §4.1 example: statuses 1,0,0,1,1,1,0,1 / 1,1,0,0,0,1,0,1 -> bytes 0xB9 0xA3.
    status_list = decode_oacp_status_list({"bits": 1, "lst": b64u(zlib.compress(bytes([0xB9, 0xA3])))})
    assert [status_list.status_at(i) for i in range(16)] == [1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1]


@pytest.mark.parametrize("bits", [4, 8])
def test_wider_entries(bits: int) -> None:
    status_list = decode_oacp_status_list({"bits": bits, "lst": lst({0: 3, 3: 2}, 4, bits)})
    assert [status_list.status_at(i) for i in range(4)] == [3, 0, 0, 2]


def test_refuses_lists_inflating_past_the_bound_and_truncated_streams() -> None:
    bomb = b64u(zlib.compress(bytes(16 * 1024 * 1024 + 1), 9))
    with pytest.raises(OacpStatusListError, match="ZLIB"):
        decode_oacp_status_list({"bits": 1, "lst": bomb})
    exact = b64u(zlib.compress(bytes(16 * 1024 * 1024), 9))
    assert decode_oacp_status_list({"bits": 8, "lst": exact}).size == 16 * 1024 * 1024
    truncated = b64u(zlib.compress(bytes([1, 2, 3]))[:-2])
    with pytest.raises(OacpStatusListError, match="ZLIB"):
        decode_oacp_status_list({"bits": 8, "lst": truncated})
    padded = b64u(zlib.compress(bytes([1, 2, 3]))) + "=="
    with pytest.raises(OacpStatusListError, match="base64url"):
        decode_oacp_status_list({"bits": 8, "lst": padded})


# ─── fetchers ────────────────────────────────────────────────────────────────


def mock_client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def response(body: str, status: int = 200, content_type: str = "application/statuslist+jwt") -> httpx.Response:
    return httpx.Response(status, headers={"content-type": content_type}, content=body.encode("utf-8"))


def test_status_list_fetcher_refuses_outside_prefixes_plain_http_and_queries() -> None:
    fetcher = create_oacp_status_list_fetcher(
        ["https://issuer.example/status/oacp/"], client=mock_client(lambda request: response("x"))
    )
    with pytest.raises(ValueError, match="outside"):
        run(fetcher("https://attacker.example/status/oacp/lst_01TEST"))
    with pytest.raises(ValueError, match="https"):
        run(fetcher("http://issuer.example/status/oacp/lst_01TEST"))
    with pytest.raises(ValueError, match="query"):
        run(fetcher("https://issuer.example/status/oacp/lst_01TEST?x=1"))
    with pytest.raises(ValueError, match="query"):
        run(fetcher("https://user@issuer.example/status/oacp/lst_01TEST"))
    for escaping in (
        "https://issuer.example/status/oacp/../../admin/lst",
        "https://issuer.example/status/oacp/%2e%2E/lst",
        "https://issuer.example/status/oacp/%2e%2e%2f%2e%2e%2fadmin",
        "https://issuer.example/status/oacp/./lst_01TEST",
    ):
        with pytest.raises(ValueError, match="dot segments"):
            run(fetcher(escaping))


def test_revocation_artifacts_may_live_24_hours() -> None:
    assert OACP_ARTIFACT_MAX_TTL_SECONDS["revocation"] == 86400


def test_status_list_fetcher_requires_200_and_the_statuslist_media_type() -> None:
    requests: List[httpx.Request] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": "https://issuer.example/status/oacp/lst_02TEST"})

    fetcher = create_oacp_status_list_fetcher(["https://issuer.example/status/oacp/"], client=mock_client(redirect))
    with pytest.raises(OSError, match="302"):
        run(fetcher(STATUS_URI))
    assert len(requests) == 1  # the redirect is not followed
    json_fetcher = create_oacp_status_list_fetcher(
        ["https://issuer.example/status/oacp/"],
        client=mock_client(lambda request: response("{}", content_type="application/json")),
    )
    with pytest.raises(OSError, match="content type"):
        run(json_fetcher(STATUS_URI))


def test_status_list_fetcher_refuses_an_oversized_body() -> None:
    fetcher = create_oacp_status_list_fetcher(
        ["https://issuer.example/status/oacp/"],
        client=mock_client(lambda request: response("a" * (1024 * 1024 + 1))),
    )
    with pytest.raises(OSError, match="larger"):
        run(fetcher(STATUS_URI))


def test_status_list_fetcher_reuses_a_list_for_its_ttl_and_clear_drops_it() -> None:
    calls: List[str] = []
    token = status_token(0, claims={"exp": int(time.time()) + 3600})

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        assert request.headers["accept"].find("application/statuslist+jwt") >= 0
        return response(token + "\n")

    async def scenario() -> None:
        fetcher = create_oacp_status_list_fetcher(["https://issuer.example/status/oacp/"], client=mock_client(handler))
        assert await fetcher(STATUS_URI) == token
        assert await fetcher(STATUS_URI) == token
        assert len(calls) == 1
        fetcher.clear()
        await fetcher(STATUS_URI)
        assert len(calls) == 2
        uncached = create_oacp_status_list_fetcher(
            ["https://issuer.example/status/oacp/"], client=mock_client(handler), max_cache_seconds=0
        )
        await uncached(STATUS_URI)
        await uncached(STATUS_URI)
        assert len(calls) == 4

    run(scenario())
    assert calls[0] == STATUS_URI


def test_status_list_fetcher_end_to_end_with_the_verifier() -> None:
    fetcher = create_oacp_status_list_fetcher(
        ["https://issuer.example/status/oacp/"], client=mock_client(lambda request: response(status_token(1)))
    )
    assert verify(status_list_fetcher=fetcher).refusal_code == "artifact_revoked"


def test_status_list_fetcher_needs_https_prefixes() -> None:
    with pytest.raises(ValueError, match="at least one"):
        create_oacp_status_list_fetcher([])
    with pytest.raises(ValueError, match="https"):
        create_oacp_status_list_fetcher(["http://issuer.example/status/oacp/"])
    create_oacp_status_list_fetcher(["http://localhost:3001/status/oacp/"], allow_loopback_http=True)


def test_jwks_fetcher_reads_the_pinned_issuer_jwks_uri_and_caches_it() -> None:
    urls: List[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        return response(json.dumps(JWKS), content_type="application/json; charset=utf-8")

    async def scenario() -> None:
        jwks = create_oacp_jwks_fetcher(ISSUER, client=mock_client(handler))
        result = await verify_oacp_artifact(
            VALID["envelope"], VALID["payload"], issuer=ISSUER, jwks=jwks, now=NOW, check_status=False
        )
        assert result.valid is True
        await jwks()
        # A refresh inside the cooldown is served from the cache.
        await jwks(refresh=True)

    run(scenario())
    assert urls == ["https://issuer.example/.well-known/jwks.json"]


def test_jwks_fetcher_refuses_a_wrong_media_type_and_non_jwks() -> None:
    wrong_type = create_oacp_jwks_fetcher(
        ISSUER, client=mock_client(lambda request: response(json.dumps(JWKS), content_type="text/html"))
    )
    with pytest.raises(OSError, match="content type"):
        run(wrong_type())
    not_jwks = create_oacp_jwks_fetcher(
        ISSUER, client=mock_client(lambda request: response("[]", content_type="application/jwk-set+json"))
    )
    with pytest.raises(ValueError, match="not a JWK Set"):
        run(not_jwks())
    assert verify(jwks=not_jwks, check_status=False).refusal_code == "issuer_key_untrusted"


def test_jwks_fetcher_refuses_an_http_issuer_unless_loopback_http_is_allowed() -> None:
    with pytest.raises(ValueError, match="https"):
        create_oacp_jwks_fetcher("http://issuer.example")
    with pytest.raises(ValueError, match="https"):
        create_oacp_jwks_fetcher("http://127.0.0.1:3001")
    fetcher = create_oacp_jwks_fetcher("http://127.0.0.1:3001", allow_loopback_http=True)
    assert fetcher.jwks_uri == "http://127.0.0.1:3001/.well-known/jwks.json"
    custom = create_oacp_jwks_fetcher(ISSUER, jwks_uri="https://keys.issuer.example/jwks.json")
    assert custom.jwks_uri == "https://keys.issuer.example/jwks.json"


def test_fetch_deadline_covers_a_slow_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    from grantex.oacp import _fetchers

    monkeypatch.setattr(_fetchers, "OACP_FETCH_TIMEOUT_SECONDS", 0.05)

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return response(status_token(0))

    fetcher = create_oacp_status_list_fetcher(
        ["https://issuer.example/status/oacp/"],
        client=httpx.AsyncClient(transport=httpx.MockTransport(slow)),
    )
    with pytest.raises(OSError, match="did not answer"):
        run(fetcher(STATUS_URI))
    assert verify(status_list_fetcher=fetcher).refusal_code == "revocation_status_unavailable"

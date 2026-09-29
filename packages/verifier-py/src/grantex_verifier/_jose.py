# SPDX-License-Identifier: Apache-2.0
"""Compact JWS (RFC 7515 section 7.1) for the registry's and issuers' tokens.

RS256 (RFC 7518 section 3.3, RSASSA-PKCS1-v1_5 with SHA-256, keys of at least
2048 bits), ES256 (RFC 7518 section 3.4, R || S, 64 octets) and EdDSA
(RFC 8037 section 3.1, Ed25519). The algorithm list is always the caller's,
never the token's (RFC 8725 section 3.1), and a key is only ever taken from
the key set the caller passes: a header that names or carries a key (``jku``,
``jwk``, ``x5u``, ``x5c``; RFC 7515 sections 4.1.2 to 4.1.6) or asks for an
extension (``crit``, section 4.1.11) is refused.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

FOREIGN_KEY_HEADERS = ("jku", "jwk", "x5u", "x5c")
PRIVATE_MEMBERS = ("d", "p", "q", "dp", "dq", "qi", "oth", "k")
_KTY_FOR_ALG = {"RS256": "RSA", "ES256": "EC", "EdDSA": "OKP"}
_B64URL = re.compile(r"[A-Za-z0-9_-]*")
MIN_RSA_BITS = 2048


class JoseError(Exception):
    """A token that cannot be trusted; ``reason`` names the rule it broke."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def b64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not _B64URL.fullmatch(value) or len(value) % 4 == 1:
        raise JoseError("bad_encoding", "not base64url without padding")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _reject_constant(name: str) -> Any:
    # JSON (RFC 8259) has no NaN or Infinity.
    raise ValueError("invalid JSON constant " + name)


def json_object(data: bytes) -> Dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as cause:
        raise JoseError("bad_encoding", "not a JSON object") from cause
    if not isinstance(value, dict):
        raise JoseError("bad_encoding", "not a JSON object")
    return value


@dataclass(frozen=True)
class Jws:
    header: Dict[str, Any]
    payload: Dict[str, Any]
    signing_input: bytes
    signature: bytes


def parse(token: Any) -> Jws:
    """Split and decode a compact JWS without checking its signature."""
    if not isinstance(token, str):
        raise JoseError("bad_encoding", "not a compact JWS")
    parts = token.split(".")
    if len(parts) != 3:
        raise JoseError("bad_encoding", "not a compact JWS")
    header = json_object(b64url_decode(parts[0]))
    payload = json_object(b64url_decode(parts[1]))
    return Jws(header, payload, (parts[0] + "." + parts[1]).encode("ascii"), b64url_decode(parts[2]))


def check_header(header: Mapping[str, Any], typ: str, algorithms: Sequence[str]) -> str:
    """Exact ``typ`` (RFC 8725 section 3.11), an allowed ``alg``, a ``kid``,
    no key in the header and no ``crit``. Returns the algorithm."""
    if header.get("typ") != typ:
        raise JoseError("wrong_typ", "typ must be exactly " + typ)
    alg = header.get("alg")
    if not isinstance(alg, str) or alg not in algorithms:
        raise JoseError("alg_not_allowed", "alg must be one of " + ", ".join(algorithms))
    for name in FOREIGN_KEY_HEADERS:
        if name in header:
            raise JoseError("header_key_not_allowed", name + " must not be present")
    if "crit" in header:
        raise JoseError("crit_not_supported", "crit is not supported")
    kid = header.get("kid")
    if not isinstance(kid, str) or kid == "" or len(kid) > 256:
        raise JoseError("kid_missing", "kid is required")
    return alg


def _public_key(jwk: Mapping[str, Any], alg: str) -> Any:
    kty = _KTY_FOR_ALG[alg]
    if jwk.get("kty") != kty:
        return None
    try:
        if kty == "RSA":
            n = int.from_bytes(b64url_decode(jwk["n"]), "big")
            e = int.from_bytes(b64url_decode(jwk["e"]), "big")
            key = rsa.RSAPublicNumbers(e, n).public_key()
            # RFC 7518 section 3.3: a key of 2048 bits or larger MUST be used.
            return key if key.key_size >= MIN_RSA_BITS else None
        if kty == "EC":
            if jwk.get("crv") != "P-256":
                return None
            x, y = b64url_decode(jwk["x"]), b64url_decode(jwk["y"])
            if len(x) != 32 or len(y) != 32:
                return None
            numbers = ec.EllipticCurvePublicNumbers(
                int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
            )
            return numbers.public_key()
        if jwk.get("crv") != "Ed25519":
            return None
        raw = b64url_decode(jwk["x"])
        return Ed25519PublicKey.from_public_bytes(raw) if len(raw) == 32 else None
    except (KeyError, TypeError, ValueError, JoseError):
        # A key that cannot be imported is not a candidate; the caller refuses
        # when no candidate verifies.
        return None


def _verify_with(key: Any, alg: str, jws: Jws) -> bool:
    try:
        if alg == "RS256":
            key.verify(jws.signature, jws.signing_input, padding.PKCS1v15(), hashes.SHA256())
        elif alg == "ES256":
            if len(jws.signature) != 64:
                return False
            r = int.from_bytes(jws.signature[:32], "big")
            s = int.from_bytes(jws.signature[32:], "big")
            key.verify(encode_dss_signature(r, s), jws.signing_input, ec.ECDSA(hashes.SHA256()))
        else:
            key.verify(jws.signature, jws.signing_input)
    except InvalidSignature:
        # The one expected failure: the signature does not verify.
        return False
    return True


def verify_with_keys(jws: Jws, alg: str, keys: Sequence[Mapping[str, Any]]) -> None:
    """Verify with the key of the set whose ``kid`` is the header's.

    The key's type must match the algorithm and its ``alg``, when present,
    must equal it. Raises JoseError when there is no such key or the
    signature does not verify.
    """
    kid = jws.header.get("kid")
    candidates = [
        k
        for k in keys
        if isinstance(k, Mapping)
        and k.get("kid") == kid
        and ("alg" not in k or k.get("alg") == alg)
        and not any(m in k for m in PRIVATE_MEMBERS)
    ]
    imported = [key for key in (_public_key(k, alg) for k in candidates) if key is not None]
    if not imported:
        raise JoseError("key_not_found", "no key in the trusted set for kid " + repr(kid))
    if not any(_verify_with(key, alg, jws) for key in imported):
        raise JoseError("signature_mismatch", "the signature does not verify")


def jwk_set_keys(value: Any) -> Optional[Sequence[Mapping[str, Any]]]:
    """The ``keys`` of a JWK Set (RFC 7517 section 5), or None."""
    if isinstance(value, Mapping) and isinstance(value.get("keys"), list):
        return [k for k in value["keys"] if isinstance(k, Mapping)]
    return None

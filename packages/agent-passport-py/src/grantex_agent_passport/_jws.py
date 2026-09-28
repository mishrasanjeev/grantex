# SPDX-License-Identifier: Apache-2.0
"""Compact JWS (RFC 7515 section 7.1) with the profile's two algorithms.

ES256 (RFC 7518 section 3.4, P-256, R || S signature) and EdDSA (RFC 8037
section 3.1, Ed25519).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Tuple

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

from ._b64 import b64url_decode, b64url_encode, b64url_json, json_compact
from ._errors import malformed
from ._jwk import has_private_members, import_public_key, key_kind

ALG_FOR_KIND = {"P-256": "ES256", "Ed25519": "EdDSA"}
KIND_FOR_ALG = {"ES256": "P-256", "EdDSA": "Ed25519"}

# Header members that carry or point at a key (RFC 7515 sections 4.1.2 to
# 4.1.6). Issuer keys come only from the relying party's resolver, never from
# the token, so a token that names one is refused.
KEY_HEADER_MEMBERS = ("jku", "jwk", "x5u", "x5c")


@dataclass(frozen=True)
class ParsedJws:
    header: Dict[str, Any]
    payload: Dict[str, Any]
    signing_input: str
    signature: bytes


def parse_jws(jws: str) -> Optional[ParsedJws]:
    """Split and decode a compact JWS without checking its signature, or return None."""
    segments = jws.split(".")
    if len(segments) != 3:
        return None
    h, p, s = segments
    header = b64url_json(h)
    payload = b64url_json(p)
    signature = b64url_decode(s)
    if header is None or payload is None or signature is None:
        return None
    if not isinstance(header[0], dict) or not isinstance(payload[0], dict):
        return None
    return ParsedJws(header[0], payload[0], f"{h}.{p}", signature)


def decode_jws_unverified(jws: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Decode a compact JWS without checking it. For tests and diagnostics only."""
    parsed = parse_jws(jws)
    if parsed is None:
        raise malformed("bad_encoding", "not a compact JWS")
    return parsed.header, parsed.payload


def sign_jws(
    header: Mapping[str, Any], payload: Mapping[str, Any], private_jwk: Mapping[str, Any]
) -> str:
    """Sign header and payload as given with a private P-256 or Ed25519 JWK."""
    kind = key_kind(private_jwk)
    d = b64url_decode(private_jwk["d"]) if isinstance(private_jwk.get("d"), str) else None
    if kind is None or d is None:
        raise malformed("bad_key", "signing key must be a private P-256 or Ed25519 JWK")
    signing_input = (
        b64url_encode(json_compact(dict(header)).encode("utf-8"))
        + "."
        + b64url_encode(json_compact(dict(payload)).encode("utf-8"))
    )
    data = signing_input.encode("ascii")
    try:
        if kind == "Ed25519":
            signature = Ed25519PrivateKey.from_private_bytes(d).sign(data)
        else:
            key = ec.derive_private_key(int.from_bytes(d, "big"), ec.SECP256R1())
            r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
            signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    except ValueError as cause:
        raise malformed("bad_key", "signing key cannot be imported") from cause
    return f"{signing_input}.{b64url_encode(signature)}"


def verify_signature(alg: str, jwk: Mapping[str, Any], jws: ParsedJws) -> bool:
    """Check a signature. False for a wrong signature, a wrong key type or a key that cannot be imported."""
    if has_private_members(jwk) or key_kind(jwk) != KIND_FOR_ALG.get(alg):
        return False
    key = import_public_key(jwk)
    if key is None or len(jws.signature) != 64:
        # RFC 7518 section 3.4: an ES256 signature is R || S, 64 octets; Ed25519 is 64 octets too.
        return False
    data = jws.signing_input.encode("ascii")
    try:
        if isinstance(key, Ed25519PublicKey):
            key.verify(jws.signature, data)
        else:
            r = int.from_bytes(jws.signature[:32], "big")
            s = int.from_bytes(jws.signature[32:], "big")
            key.verify(encode_dss_signature(r, s), data, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        # The one expected failure: the signature does not verify, so the caller refuses.
        return False
    return True


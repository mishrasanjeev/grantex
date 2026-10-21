# SPDX-License-Identifier: Apache-2.0
"""JWK helpers and the key rule.

Two keys are the same key when their RFC 7638 thumbprints are equal. The
thumbprint covers the required members only (RFC 7638 section 3.2; RFC 8037
section 2 for OKP keys), so kid, alg, use and private members never change it.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Mapping, Optional, Union

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ._b64 import b64url_decode, b64url_encode
from ._errors import malformed

PublicKey = Union[ec.EllipticCurvePublicKey, Ed25519PublicKey]

# Required members per key type, already in lexicographic order.
_REQUIRED_MEMBERS = {
    "EC": ("crv", "kty", "x", "y"),
    "OKP": ("crv", "kty", "x"),
    "RSA": ("e", "kty", "n"),
    "oct": ("k", "kty"),
}

# Members that make a JWK private (RFC 7518 sections 6.2.2, 6.3.2 and 6.4.1; RFC 8037 section 2).
_PRIVATE_MEMBERS = ("d", "p", "q", "dp", "dq", "qi", "oth", "k")

# Printable ASCII without '"' and '\': JSON serialises such a string the same
# way in every language, so both libraries hash identical bytes.
_PLAIN_MEMBER = re.compile(r"[\x20\x21\x23-\x5b\x5d-\x7e]*")


def jwk_thumbprint(jwk: Mapping[str, Any]) -> str:
    """RFC 7638 JWK SHA-256 thumbprint, base64url without padding."""
    kty = jwk.get("kty") if isinstance(jwk, Mapping) else None
    if not isinstance(kty, str) or kty not in _REQUIRED_MEMBERS:
        raise malformed("bad_key", "JWK has no supported kty")
    parts = []
    for member in _REQUIRED_MEMBERS[kty]:
        value = jwk.get(member)
        if not isinstance(value, str) or not _PLAIN_MEMBER.fullmatch(value):
            raise malformed("bad_key", f"JWK member {member} is missing or not a plain string")
        parts.append(f"{json.dumps(member)}:{json.dumps(value)}")
    # RFC 7638 section 3: required members only, lexicographic order, no whitespace, UTF-8.
    canonical = "{" + ",".join(parts) + "}"
    return b64url_encode(hashlib.sha256(canonical.encode("utf-8")).digest())


def keys_equal(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
    """The key rule: two JWKs are the same key when their thumbprints are equal."""
    return jwk_thumbprint(a) == jwk_thumbprint(b)


def has_private_members(jwk: Mapping[str, Any]) -> bool:
    return any(member in jwk for member in _PRIVATE_MEMBERS)


def key_kind(jwk: Any) -> Optional[str]:
    """'P-256' or 'Ed25519' with coordinates of the right length, else None."""
    if not isinstance(jwk, Mapping):
        return None
    x = b64url_decode(jwk["x"]) if isinstance(jwk.get("x"), str) else None
    if jwk.get("kty") == "EC" and jwk.get("crv") == "P-256":
        y = b64url_decode(jwk["y"]) if isinstance(jwk.get("y"), str) else None
        return "P-256" if x is not None and y is not None and len(x) == 32 and len(y) == 32 else None
    if jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519":
        return "Ed25519" if x is not None and len(x) == 32 else None
    return None


def import_public_key(jwk: Mapping[str, Any]) -> Optional[PublicKey]:
    """Import the public part of a P-256 or Ed25519 JWK, or return None (bad point, wrong type)."""
    kind = key_kind(jwk)
    if kind is None:
        return None
    x = b64url_decode(jwk["x"])
    assert x is not None  # key_kind checked it
    if kind == "Ed25519":
        return Ed25519PublicKey.from_public_bytes(x)
    y = b64url_decode(jwk["y"])
    assert y is not None
    numbers = ec.EllipticCurvePublicNumbers(
        int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
    )
    try:
        return numbers.public_key()
    except ValueError:
        # A point that is not on the curve: the caller refuses the key.
        return None

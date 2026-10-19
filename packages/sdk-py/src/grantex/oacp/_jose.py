"""The small amount of JOSE the OACP verifier needs.

Strict base64url (RFC 7515 §2, no padding, canonical), duplicate-free JSON
headers and claims sets, key selection from a JWK Set (RFC 7517) and signature
checks for ES256 (RFC 7518 §3.4, IEEE P1363 ``r || s``) and RS256 (RFC 7518
§3.3), on ``cryptography`` alone. The TypeScript SDK implements the same rules
in ``oacp/jose.ts``.
"""

from __future__ import annotations

import base64
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple, Union

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

__all__ = [
    "JS_WHITESPACE",
    "KeyLookup",
    "OacpPublicKey",
    "decode_base64url_strict",
    "decode_json_segment",
    "encode_base64url",
    "is_base64url_shaped",
    "is_plain_object",
    "is_safe_integer",
    "loads_json_rejecting_duplicates",
    "select_verification_key",
    "verify_jws_signature",
]

OacpPublicKey = Union[ec.EllipticCurvePublicKey, rsa.RSAPublicKey]

#: The characters ECMAScript ``String.prototype.trim`` and ``\\s`` treat as
#: white space (ASCII and Unicode Zs, line terminators and the BOM), so text is
#: trimmed and member names folded exactly as the TypeScript SDK does.
JS_WHITESPACE = (
    "\t\n\v\f\r          "
    "        　﻿"
)

_B64URL_CHARS = re.compile(r"[A-Za-z0-9_-]*", re.ASCII)
_MAX_SAFE_INTEGER = 2**53 - 1
_KEY_TYPE = {"ES256": "EC", "RS256": "RSA"}


def is_plain_object(value: Any) -> bool:
    """A JSON object: a ``dict`` (never a list, ``None`` or a scalar)."""
    return isinstance(value, dict)


def is_safe_integer(value: Any) -> bool:
    """ECMAScript ``Number.isSafeInteger``: an integral number of at most 2**53 - 1.

    ``bool`` is not a number here, although Python treats ``True`` as ``1``.
    An integral ``float`` (``7.0``, which JSON may spell ``7e0``) counts, as
    it does in JavaScript, so both SDKs accept the same documents.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= _MAX_SAFE_INTEGER
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER
    return False


def is_base64url_shaped(value: str) -> bool:
    """True when ``value`` uses only base64url characters and has a length base64url can produce."""
    return _B64URL_CHARS.fullmatch(value) is not None and len(value) % 4 != 1


def encode_base64url(value: Union[str, bytes]) -> str:
    """Unpadded base64url of ``value`` (UTF-8 for text)."""
    data = value.encode("utf-8") if isinstance(value, str) else value
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def decode_base64url_strict(value: Any) -> Optional[bytes]:
    """Decodes unpadded base64url, or returns ``None`` when the text is not the
    one canonical encoding of its bytes (stray padding bits, padding, other
    characters)."""
    if not isinstance(value, str) or not is_base64url_shaped(value):
        return None
    try:
        data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError):
        return None
    return data if encode_base64url(data) == value else None


class _DuplicateMember(ValueError):
    pass


def _pairs_rejecting_duplicates(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, item in pairs:
        if key in out:
            raise _DuplicateMember(f"duplicate member name {key!r}")
        out[key] = item
    return out


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def loads_json_rejecting_duplicates(text: str) -> Any:
    """``JSON.parse`` semantics: no repeated member names, no ``NaN`` or ``Infinity``.

    Raises ``ValueError`` for anything else.
    """
    return json.loads(
        text,
        object_pairs_hook=_pairs_rejecting_duplicates,
        parse_constant=_reject_constant,
    )


def decode_json_segment(segment: str) -> Optional[Dict[str, Any]]:
    """A JOSE header or claims set: a base64url JSON object without repeated member names."""
    data = decode_base64url_strict(segment)
    if data is None:
        return None
    try:
        # A WHATWG TextDecoder drops one leading byte order mark; so does utf-8-sig.
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    try:
        value = loads_json_rejecting_duplicates(text)
    except (ValueError, RecursionError):
        return None
    return value if is_plain_object(value) else None


@dataclass(frozen=True)
class KeyLookup:
    """The outcome of :func:`select_verification_key`: a key, or why there is none."""

    key: Optional[OacpPublicKey]
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.key is not None


def _refuse(reason: str) -> KeyLookup:
    return KeyLookup(key=None, reason=reason)


def select_verification_key(jwks: Any, kid: str, alg: str) -> KeyLookup:
    """The one key in ``jwks`` with ``kid``, usable for ``alg``.

    ``use`` absent or ``sig``, ``alg`` absent or equal, ``kty`` matching the
    algorithm, P-256 with 32-byte coordinates for ES256, a modulus of at least
    2048 bits for RS256, and no private members.
    """
    if not isinstance(jwks, Mapping) or not isinstance(jwks.get("keys"), list):
        return _refuse("the JWK Set has no keys array")
    matches = [
        key
        for key in jwks["keys"]
        if isinstance(key, Mapping) and isinstance(key.get("kid"), str) and key["kid"] == kid
    ]
    if not matches:
        return _refuse(f"no key with kid {json.dumps(kid)}")
    if len(matches) > 1:
        return _refuse(f"several keys with kid {json.dumps(kid)}")
    jwk = matches[0]
    if "use" in jwk and jwk["use"] != "sig":
        return _refuse("the key is not a signing key")
    if "alg" in jwk and jwk["alg"] != alg:
        return _refuse(f"the key is not for {alg}")
    expected_kty = _KEY_TYPE.get(alg)
    if expected_kty is None or jwk.get("kty") != expected_kty:
        return _refuse(f"the key type is not {expected_kty}")
    if "d" in jwk or "p" in jwk:
        return _refuse("the JWK Set publishes private key material")
    try:
        if alg == "ES256":
            if jwk.get("crv") != "P-256":
                return _refuse("the key is not on P-256")
            x = decode_base64url_strict(jwk.get("x"))
            y = decode_base64url_strict(jwk.get("y"))
            if x is None or y is None or len(x) != 32 or len(y) != 32:
                return _refuse("the key coordinates are not 32 bytes")
            numbers = ec.EllipticCurvePublicNumbers(
                int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
            )
            return KeyLookup(key=numbers.public_key())
        n = decode_base64url_strict(jwk.get("n"))
        e = decode_base64url_strict(jwk.get("e"))
        if n is None or e is None or len(n) < 256:
            return _refuse("the RSA key is malformed or shorter than 2048 bits")
        rsa_numbers = rsa.RSAPublicNumbers(int.from_bytes(e, "big"), int.from_bytes(n, "big"))
        return KeyLookup(key=rsa_numbers.public_key())
    except (ValueError, TypeError, OverflowError):
        return _refuse("the key cannot be imported")


def verify_jws_signature(alg: str, key: OacpPublicKey, signing_input: str, signature: bytes) -> bool:
    """Checks a JWS signature over the ASCII signing input."""
    try:
        data = signing_input.encode("ascii")
        if alg == "ES256":
            if len(signature) != 64 or not isinstance(key, ec.EllipticCurvePublicKey):
                return False
            der = encode_dss_signature(
                int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
            )
            key.verify(der, data, ec.ECDSA(hashes.SHA256()))
            return True
        if alg == "RS256" and isinstance(key, rsa.RSAPublicKey):
            key.verify(signature, data, padding.PKCS1v15(), hashes.SHA256())
            return True
        return False
    except (InvalidSignature, ValueError, TypeError):
        return False

"""Detached JWS signatures over an evidence package root and anchor (ES256 or RS256).

The signed payload is the RFC 8785 form of ``{"anchor": <anchor audit hash or
null>, "root": <package root>}``, so a verified signature attests both the
package and the audit-chain entry that recorded it.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any, Dict, Mapping, Optional, Union

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

from ._canonical import canonicalize
from ._result import VerificationCode as Code
from ._result import VerificationFailure

__all__ = ["SIGNATURE_TYPE", "sign_root", "signed_payload", "verify_signature"]

SIGNATURE_TYPE = "grantex-evidence-package+jws"

PrivateKey = Union[ec.EllipticCurvePrivateKey, rsa.RSAPrivateKey]


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> Optional[bytes]:
    """Strict base64url: no padding, and the text must be the canonical encoding."""
    if "=" in text:
        return None
    try:
        raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        return None
    return raw if _b64url(raw) == text else None


def signed_payload(root: str, anchor_hash: Optional[str]) -> bytes:
    """The bytes a package signature covers."""
    return canonicalize({"anchor": anchor_hash, "root": root}).encode("utf-8")


def sign_root(
    root: str, private_key: PrivateKey, kid: str, anchor_hash: Optional[str] = None
) -> Dict[str, str]:
    """Return a ``signature`` member: a detached JWS over the root and anchor hash.

    ES256 for a P-256 key, RS256 for an RSA key (2048 bits or more).
    """
    if isinstance(private_key, ec.EllipticCurvePrivateKey):
        if not isinstance(private_key.curve, ec.SECP256R1):
            raise ValueError("ES256 requires a P-256 key")
        alg = "ES256"
    elif isinstance(private_key, rsa.RSAPrivateKey):
        if private_key.key_size < 2048:
            raise ValueError("RS256 requires an RSA key of at least 2048 bits")
        alg = "RS256"
    else:
        raise ValueError("unsupported private key type")
    header = {"alg": alg, "kid": kid, "typ": SIGNATURE_TYPE}
    header_b64 = _b64url(
        json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signing_input = f"{header_b64}.{_b64url(signed_payload(root, anchor_hash))}".encode("ascii")
    if isinstance(private_key, ec.EllipticCurvePrivateKey):
        der = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    else:
        signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return {"alg": alg, "jws": f"{header_b64}..{_b64url(signature)}", "kid": kid}


def _invalid(message: str, path: str = "signature.jws") -> VerificationFailure:
    return VerificationFailure(Code.SIGNATURE_INVALID, message, field_path=path)


def _int(value: Any) -> Optional[int]:
    if not isinstance(value, str):
        return None
    raw = _b64url_decode(value)
    return None if raw is None or not raw else int.from_bytes(raw, "big")


def _public_key(jwk: Mapping[str, Any], alg: str) -> Union[ec.EllipticCurvePublicKey, rsa.RSAPublicKey]:
    if jwk.get("use", "sig") != "sig" or jwk.get("alg", alg) != alg:
        raise _invalid("key is not usable for this algorithm", "signature.kid")
    if alg == "ES256":
        x = _b64url_decode(jwk.get("x", "")) if isinstance(jwk.get("x"), str) else None
        y = _b64url_decode(jwk.get("y", "")) if isinstance(jwk.get("y"), str) else None
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or not x or not y:
            raise _invalid("ES256 requires an EC P-256 key", "signature.kid")
        if len(x) != 32 or len(y) != 32:
            raise _invalid("malformed EC key", "signature.kid")
        try:
            return ec.EllipticCurvePublicNumbers(
                int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()
            ).public_key()
        except ValueError:
            raise _invalid("EC key point is not on P-256", "signature.kid") from None
    n = _int(jwk.get("n"))
    e = _int(jwk.get("e"))
    if jwk.get("kty") != "RSA" or n is None or e is None:
        raise _invalid("RS256 requires an RSA key", "signature.kid")
    if n.bit_length() < 2048:
        raise _invalid("RSA key is shorter than 2048 bits", "signature.kid")
    try:
        return rsa.RSAPublicNumbers(e, n).public_key()
    except ValueError:
        raise _invalid("RS256 requires an RSA key", "signature.kid") from None


def verify_signature(
    signature: Mapping[str, Any], root: str, anchor_hash: Optional[str], jwks: Mapping[str, Any]
) -> None:
    """Verify a ``signature`` member against the root and anchor hash with keys from a JWKS."""
    alg = signature["alg"]
    kid = signature["kid"]
    header_b64, _, signature_b64 = signature["jws"].partition("..")
    header_raw = _b64url_decode(header_b64)
    signature_raw = _b64url_decode(signature_b64)
    if header_raw is None or signature_raw is None:
        raise _invalid("JWS is not canonical base64url")
    try:
        header = json.loads(header_raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise _invalid("JWS header is not JSON") from None
    if header != {"alg": alg, "kid": kid, "typ": SIGNATURE_TYPE}:
        raise _invalid("JWS header must be exactly alg, kid and typ matching the signature")

    keys = jwks.get("keys") if isinstance(jwks, Mapping) else None
    if not isinstance(keys, list):
        raise VerificationFailure(
            Code.SIGNATURE_KEY_UNKNOWN, "key set has no keys", field_path="signature.kid"
        )
    matching = [k for k in keys if isinstance(k, Mapping) and k.get("kid") == kid]
    if len(matching) != 1:
        raise VerificationFailure(
            Code.SIGNATURE_KEY_UNKNOWN,
            f"key set has {len(matching)} keys with kid {kid}",
            field_path="signature.kid",
        )
    public_key = _public_key(matching[0], alg)
    signing_input = f"{header_b64}.{_b64url(signed_payload(root, anchor_hash))}".encode("ascii")
    try:
        if isinstance(public_key, ec.EllipticCurvePublicKey):
            if len(signature_raw) != 64:
                raise _invalid("ES256 signature must be 64 bytes")
            der = encode_dss_signature(
                int.from_bytes(signature_raw[:32], "big"),
                int.from_bytes(signature_raw[32:], "big"),
            )
            public_key.verify(der, signing_input, ec.ECDSA(hashes.SHA256()))
        else:
            public_key.verify(signature_raw, signing_input, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise _invalid("signature does not verify") from None

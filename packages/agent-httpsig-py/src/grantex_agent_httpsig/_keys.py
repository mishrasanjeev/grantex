# SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"""Agent keys as JWKs.

P-256 (RFC 7518 section 6.2) and Ed25519 (RFC 8037 section 2), their RFC
7638 thumbprints, and the two RFC 9421 algorithms the profile allows
(sections 3.3.4 and 3.3.6).
"""

from __future__ import annotations

import base64
import hashlib
import re
from typing import Any, Mapping, Optional, Tuple, Union

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

from ._errors import AgentHttpSigError

ECDSA_P256_SHA256 = "ecdsa-p256-sha256"
ED25519 = "ed25519"
#: RFC 9421 section 3.3.1: RSASSA-PSS, SHA-512, MGF1 with SHA-512, 64-octet salt.
RSA_PSS_SHA512 = "rsa-pss-sha512"
#: The smallest RSA modulus accepted, in bits.
MIN_RSA_MODULUS_BITS = 2048
_MAX_RSA_MODULUS_BITS = 8192
_PSS = padding.PSS(mgf=padding.MGF1(hashes.SHA512()), salt_length=64)

PrivateKey = Union[ec.EllipticCurvePrivateKey, ed25519.Ed25519PrivateKey, rsa.RSAPrivateKey]
PublicKey = Union[ec.EllipticCurvePublicKey, ed25519.Ed25519PublicKey, rsa.RSAPublicKey]

_B64URL = re.compile(r"[A-Za-z0-9_-]*")
_P256_ORDER = int("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode_b64url(value: Any, member: str, octets: int) -> bytes:
    """base64url without padding (RFC 7515 section 2), decoded strictly."""
    if not isinstance(value, str) or not _B64URL.fullmatch(value) or len(value) % 4 == 1:
        raise AgentHttpSigError("JWK member " + member + " is not base64url")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(data) != octets or _b64url(data) != value:
        raise AgentHttpSigError(
            "JWK member %s is not %d octets of canonical base64url" % (member, octets)
        )
    return data


def _decode_b64url_int(value: Any, member: str, max_octets: int) -> int:
    """A positive big-endian integer in canonical base64url (no leading zero octet)."""
    if not isinstance(value, str) or not value or not _B64URL.fullmatch(value) or len(value) % 4 == 1:
        raise AgentHttpSigError("JWK member " + member + " is not base64url")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if not data or len(data) > max_octets or data[0] == 0 or _b64url(data) != value:
        raise AgentHttpSigError("JWK member %s is not a canonical base64url integer" % member)
    return int.from_bytes(data, "big")


def _rsa_public_numbers(jwk: Mapping[str, Any]) -> rsa.RSAPublicNumbers:
    n = _decode_b64url_int(jwk.get("n"), "n", _MAX_RSA_MODULUS_BITS // 8)
    e = _decode_b64url_int(jwk.get("e"), "e", 8)
    if n.bit_length() < MIN_RSA_MODULUS_BITS:
        raise AgentHttpSigError("an RSA key must have at least a %d-bit modulus" % MIN_RSA_MODULUS_BITS)
    if e < 3 or e % 2 == 0:
        raise AgentHttpSigError("an RSA public exponent must be odd and at least 3")
    return rsa.RSAPublicNumbers(e, n)


def algorithm_for(jwk: Mapping[str, Any]) -> str:
    """The algorithm for a key, from its kty and crv (RFC 9421 section 3.2 step 6.3)."""
    allowed: Tuple[str, ...]
    if jwk.get("kty") == "EC" and jwk.get("crv") == "P-256":
        _decode_b64url(jwk.get("x"), "x", 32)
        _decode_b64url(jwk.get("y"), "y", 32)
        alg, allowed = ECDSA_P256_SHA256, ("ES256",)
    elif jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519":
        _decode_b64url(jwk.get("x"), "x", 32)
        if "y" in jwk:
            raise AgentHttpSigError("an Ed25519 JWK has no y")
        alg, allowed = ED25519, ("EdDSA", "Ed25519")
    elif jwk.get("kty") == "RSA":
        _rsa_public_numbers(jwk)
        alg, allowed = RSA_PSS_SHA512, ("PS512",)
    else:
        raise AgentHttpSigError(
            "only P-256 (kty EC), Ed25519 (kty OKP) and RSA (kty RSA) keys are supported"
        )
    # Section 3.2 step 6.5: an algorithm named in the key must agree.
    if "alg" in jwk and jwk["alg"] not in allowed:
        raise AgentHttpSigError("JWK alg %r does not match its key type" % (jwk["alg"],))
    return alg


def public_jwk(jwk: Mapping[str, Any]) -> dict[str, str]:
    """The public members of a P-256, Ed25519 or RSA JWK."""
    alg = algorithm_for(jwk)
    if alg == RSA_PSS_SHA512:
        return {"kty": "RSA", "n": jwk["n"], "e": jwk["e"]}
    if alg == ECDSA_P256_SHA256:
        return {"kty": "EC", "crv": "P-256", "x": jwk["x"], "y": jwk["y"]}
    return {"kty": "OKP", "crv": "Ed25519", "x": jwk["x"]}


def jwk_thumbprint(jwk: Mapping[str, Any]) -> str:
    """RFC 7638 section 3.

    SHA-256 over the required members in lexicographic order with no
    whitespace (crv, kty, x, y for EC, section 3.2; crv, kty, x for OKP, RFC
    8037 Appendix A.3), base64url without padding.
    """
    alg = algorithm_for(jwk)
    if alg == RSA_PSS_SHA512:
        # RFC 7638 section 3.2: e, kty, n for RSA.
        canonical = '{"e":"%s","kty":"RSA","n":"%s"}' % (jwk["e"], jwk["n"])
    elif alg == ECDSA_P256_SHA256:
        canonical = '{"crv":"P-256","kty":"EC","x":"%s","y":"%s"}' % (jwk["x"], jwk["y"])
    else:
        canonical = '{"crv":"Ed25519","kty":"OKP","x":"%s"}' % (jwk["x"],)
    return _b64url(hashlib.sha256(canonical.encode("utf-8")).digest())


def private_jwk_from_key(key: PrivateKey) -> dict[str, str]:
    """The private JWK of a ``cryptography`` P-256, Ed25519 or RSA private key."""
    if isinstance(key, rsa.RSAPrivateKey):
        if key.key_size < MIN_RSA_MODULUS_BITS:
            raise AgentHttpSigError("an RSA key must have at least a %d-bit modulus" % MIN_RSA_MODULUS_BITS)
        priv = key.private_numbers()
        pubn = priv.public_numbers

        def enc(v: int) -> str:
            return _b64url(v.to_bytes((v.bit_length() + 7) // 8, "big"))

        return {
            "kty": "RSA", "n": enc(pubn.n), "e": enc(pubn.e), "d": enc(priv.d),
            "p": enc(priv.p), "q": enc(priv.q), "dp": enc(priv.dmp1), "dq": enc(priv.dmq1), "qi": enc(priv.iqmp),
        }
    if isinstance(key, ed25519.Ed25519PrivateKey):
        d = key.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
        x = key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return {"kty": "OKP", "crv": "Ed25519", "x": _b64url(x), "d": _b64url(d)}
    if isinstance(key, ec.EllipticCurvePrivateKey) and isinstance(key.curve, ec.SECP256R1):
        numbers = key.private_numbers()
        pub = numbers.public_numbers
        return {
            "kty": "EC",
            "crv": "P-256",
            "x": _b64url(pub.x.to_bytes(32, "big")),
            "y": _b64url(pub.y.to_bytes(32, "big")),
            "d": _b64url(numbers.private_value.to_bytes(32, "big")),
        }
    raise AgentHttpSigError("only P-256, Ed25519 and RSA private keys are supported")


def private_key_object(jwk: Mapping[str, Any]) -> Tuple[PrivateKey, str]:
    """A private key whose public half is the JWK's own x (and y), or n and e."""
    alg = algorithm_for(jwk)
    if alg == RSA_PSS_SHA512:
        pubn = _rsa_public_numbers(jwk)
        try:
            members = {m: _decode_b64url_int(jwk.get(m), m, _MAX_RSA_MODULUS_BITS // 8)
                       for m in ("d", "p", "q", "dp", "dq", "qi")}
            rsa_key = rsa.RSAPrivateNumbers(
                members["p"], members["q"], members["d"], members["dp"], members["dq"], members["qi"], pubn,
            ).private_key()
        except ValueError as exc:
            raise AgentHttpSigError("the private JWK cannot be loaded") from exc
        return rsa_key, alg
    d = _decode_b64url(jwk.get("d"), "d", 32)
    key: PrivateKey
    try:
        if alg == ED25519:
            key = ed25519.Ed25519PrivateKey.from_private_bytes(d)
        else:
            key = ec.derive_private_key(int.from_bytes(d, "big"), ec.SECP256R1())
    except ValueError as exc:
        # Signing with a key that cannot be loaded is refused, never attempted.
        raise AgentHttpSigError("the private JWK cannot be loaded") from exc
    derived = private_jwk_from_key(key)
    if derived["x"] != jwk["x"] or (alg == ECDSA_P256_SHA256 and derived["y"] != jwk["y"]):
        raise AgentHttpSigError("the private JWK does not match its public members")
    return key, alg


def public_key_object(jwk: Any) -> Optional[Tuple[PublicKey, str]]:
    """A public key, or None when the JWK is not a usable public P-256, Ed25519 or RSA key."""
    if not isinstance(jwk, Mapping):
        return None
    # A resolver that hands back private material is misconfigured; refuse it.
    if "d" in jwk:
        return None
    try:
        alg = algorithm_for(jwk)
        if alg == RSA_PSS_SHA512:
            key: PublicKey = _rsa_public_numbers(jwk).public_key()
        elif alg == ED25519:
            key = ed25519.Ed25519PublicKey.from_public_bytes(
                _decode_b64url(jwk["x"], "x", 32)
            )
        else:
            key = ec.EllipticCurvePublicNumbers(
                int.from_bytes(_decode_b64url(jwk["x"], "x", 32), "big"),
                int.from_bytes(_decode_b64url(jwk["y"], "y", 32), "big"),
                ec.SECP256R1(),
            ).public_key()
    except ValueError:
        # A key that cannot be loaded (for example a point off the curve) is
        # unusable; the caller denies the request. AgentHttpSigError is a
        # ValueError too.
        return None
    return key, alg


def sign_bytes(key: PrivateKey, alg: str, base: Union[str, bytes]) -> bytes:
    """HTTP_SIGN (RFC 9421 section 3.3.4 or 3.3.6). ECDSA output is r || s, not DER."""
    data = base.encode("ascii") if isinstance(base, str) else bytes(base)
    if isinstance(key, rsa.RSAPrivateKey):
        return key.sign(data, _PSS, hashes.SHA512())
    if isinstance(key, ed25519.Ed25519PrivateKey):
        return key.sign(data)
    r, s = decode_dss_signature(key.sign(data, ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify_bytes(
    key: PublicKey, alg: str, base: Union[str, bytes], signature: bytes
) -> bool:
    """HTTP_VERIFY (RFC 9421 sections 3.3.1, 3.3.4, 3.3.6).

    ECDSA and Ed25519 signatures are 64 octets; RSA-PSS ones are the modulus length.
    """
    data = base.encode("ascii") if isinstance(base, str) else bytes(base)
    if isinstance(key, rsa.RSAPublicKey):
        if len(signature) != (key.key_size + 7) // 8:
            return False
        try:
            key.verify(signature, data, _PSS, hashes.SHA512())
        except InvalidSignature:
            return False
        return True
    if len(signature) != 64:
        return False
    try:
        if isinstance(key, ed25519.Ed25519PublicKey):
            key.verify(signature, data)
        else:
            r = int.from_bytes(signature[:32], "big")
            s = int.from_bytes(signature[32:], "big")
            if not (0 < r < _P256_ORDER and 0 < s < _P256_ORDER):
                return False
            key.verify(encode_dss_signature(r, s), data, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return False
    return True


def verify_signature_value(jwk: Mapping[str, Any], base: str, signature: bytes) -> bool:
    """Verifies an RFC 9421 signature value over a signature base with a public JWK.

    P-256 or Ed25519. False for any key it cannot use.
    """
    pub = public_key_object(jwk)
    return pub is not None and verify_bytes(pub[0], pub[1], base, signature)

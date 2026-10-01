"""The agent's side of key possession: thumbprints, key generation and the
proof over a registry challenge (spec/agent-keys.md §1 and §4.2).
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Dict, Mapping, Optional, Tuple, Union

import jwt
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from ..resources._agent_keys import KeyChallenge
from ._errors import ADAPTER_INVALID, IssuerAdapterError

KEY_PROOF_TYP = "agent-key-proof+jwt"
#: The algorithms a registry proof may use (spec §4.2): asymmetric only.
PROOF_ALGORITHMS = ("ES256", "ES384", "ES512", "EdDSA", "RS256")

# RFC 7638 §3.2 and RFC 8037 §2: the members that identify a key, by type.
_REQUIRED_MEMBERS = {"EC": ("crv", "kty", "x", "y"), "RSA": ("e", "kty", "n"), "OKP": ("crv", "kty", "x")}
_PRIVATE_MEMBERS = ("d", "p", "q", "dp", "dq", "qi", "oth", "k")


def jwk_thumbprint(jwk: Mapping[str, Any]) -> str:
    """The RFC 7638 SHA-256 thumbprint of a public JWK, unpadded base64url.

    Only the required members count, ordered by name with no whitespace; a
    private member or an unsupported key type is refused.
    """
    kty = jwk.get("kty")
    members = _REQUIRED_MEMBERS.get(str(kty))
    if members is None:
        raise IssuerAdapterError(ADAPTER_INVALID, f"no registry thumbprint for key type {kty!r}")
    if any(member in jwk for member in _PRIVATE_MEMBERS):
        raise IssuerAdapterError(ADAPTER_INVALID, "a private JWK has no thumbprint; pass the public key")
    try:
        subset = {member: jwk[member] for member in members}
    except KeyError as exc:
        raise IssuerAdapterError(ADAPTER_INVALID, f"JWK is missing {exc.args[0]!r}") from exc
    if not all(isinstance(value, str) for value in subset.values()):
        raise IssuerAdapterError(ADAPTER_INVALID, "JWK members must be strings")
    canonical = json.dumps(subset, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    return base64.urlsafe_b64encode(hashlib.sha256(canonical.encode("utf-8")).digest()).decode("ascii").rstrip("=")


def public_jwk(jwk: Mapping[str, Any]) -> Dict[str, Any]:
    """The public members of a JWK (the thumbprint members only)."""
    kty = str(jwk.get("kty"))
    members = _REQUIRED_MEMBERS.get(kty)
    if members is None:
        raise IssuerAdapterError(ADAPTER_INVALID, f"unsupported key type {kty!r}")
    return {member: jwk[member] for member in members if member in jwk}


def generate_agent_key(alg: str = "ES256") -> Tuple[Dict[str, Any], Dict[str, Any], str]:
    """A fresh agent key: ``(private_jwk, public_jwk, thumbprint)``.

    ES256 (P-256) is the default and the only choice for agents that declare
    a payments rail (spec §3); EdDSA (Ed25519) is also available.
    """
    if alg == "ES256":
        private = ec.generate_private_key(ec.SECP256R1())
        private_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private))
    elif alg == "EdDSA":
        private_ed = ed25519.Ed25519PrivateKey.generate()
        private_jwk = json.loads(jwt.algorithms.OKPAlgorithm.to_jwk(private_ed))
    else:
        raise IssuerAdapterError(ADAPTER_INVALID, f"generate_agent_key supports ES256 and EdDSA, not {alg!r}")
    pub = public_jwk(private_jwk)
    return private_jwk, pub, jwk_thumbprint(pub)


PrivateKey = Union[str, bytes, Mapping[str, Any], Any]


def _signing_key(private_key: PrivateKey) -> Any:
    if isinstance(private_key, Mapping):
        if "d" not in private_key:
            raise IssuerAdapterError(ADAPTER_INVALID, "the proof needs the agent's private JWK")
        return jwt.PyJWK(dict(private_key)).key
    return private_key


def sign_key_proof(
    challenge: Union[KeyChallenge, Mapping[str, Any]],
    private_key: PrivateKey,
    *,
    now: Optional[int] = None,
) -> str:
    """Sign a registry challenge with the agent's key (spec §4.2).

    ``private_key`` is a private JWK, a PEM string or a ``cryptography`` key
    object. The header carries ``typ`` ``agent-key-proof+jwt`` and the key's
    thumbprint as ``kid``; the claims are ``aud``, ``sub``, ``nonce`` and
    ``iat``. The algorithm is the challenge's, and must be asymmetric.
    """
    if not isinstance(challenge, KeyChallenge):
        challenge = KeyChallenge.from_dict(dict(challenge))
    if challenge.typ != KEY_PROOF_TYP:
        raise IssuerAdapterError(ADAPTER_INVALID, f"challenge typ is {challenge.typ!r}, not {KEY_PROOF_TYP}")
    if challenge.alg not in PROOF_ALGORITHMS:
        raise IssuerAdapterError(ADAPTER_INVALID, f"challenge alg {challenge.alg!r} is not a proof algorithm")
    claims = {
        "aud": challenge.audience,
        "sub": challenge.subject,
        "nonce": challenge.challenge,
        "iat": int(time.time()) if now is None else now,
    }
    headers = {"typ": KEY_PROOF_TYP, "kid": challenge.thumbprint}
    return jwt.encode(claims, _signing_key(private_key), algorithm=challenge.alg, headers=headers)

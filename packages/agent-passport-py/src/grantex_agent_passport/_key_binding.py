# SPDX-License-Identifier: Apache-2.0
"""Key Binding JWT (RFC 9901 section 4.3).

The holder proves possession of the cnf key for one relying party (aud) and
one request (nonce), over exactly the disclosures it presents (sd_hash).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional

from ._b64 import is_safe_int
from ._errors import PassportError, malformed
from ._jwk import has_private_members, key_kind
from ._jws import ALG_FOR_KIND, KEY_HEADER_MEMBERS, parse_jws, sign_jws, verify_signature
from ._sd_jwt import decode_disclosure, sha256_b64url, split_sd_jwt

#: RFC 9901 section 4.3: the typ of a KB-JWT.
KB_JWT_TYP = "kb+jwt"

#: How old a KB-JWT may be when no max_age_seconds is given.
DEFAULT_KB_MAX_AGE_SECONDS = 300


@dataclass(frozen=True)
class KeyBindingRequirement:
    """What a relying party requires of the KB-JWT."""

    #: The relying party's identifier, compared with aud.
    aud: str
    #: The nonce this relying party issued for the request.
    nonce: str
    #: Oldest acceptable iat, in seconds before now.
    max_age_seconds: int = DEFAULT_KB_MAX_AGE_SECONDS


def create_key_binding_jwt(
    sd_jwt: str,
    *,
    holder_key: Mapping[str, Any],
    aud: str,
    nonce: str,
    iat: Optional[int] = None,
) -> str:
    """Append a KB-JWT to an SD-JWT: SD-JWT+KB (RFC 9901 section 4).

    sd_jwt ends with '~' and has no KB-JWT yet (see select_disclosures);
    holder_key is the private key of the passport's cnf claim.
    """
    split = split_sd_jwt(sd_jwt)
    if split.kb_jwt != "" or not sd_jwt.endswith("~") or parse_jws(split.issuer_jwt) is None:
        raise malformed(
            "not_sd_jwt",
            "a KB-JWT is made over an SD-JWT that ends with ~ and has no KB-JWT yet",
        )
    for encoded in split.disclosures:
        decode_disclosure(encoded)
    kind = key_kind(holder_key)
    if kind is None or not isinstance(holder_key.get("d"), str):
        raise malformed("bad_key", "the holder key must be a private P-256 or Ed25519 JWK")
    if not isinstance(aud, str) or aud == "" or not isinstance(nonce, str) or nonce == "":
        raise malformed("bad_claim", "aud and nonce are non-empty strings")
    issued_at = int(time.time()) if iat is None else iat
    # RFC 9901 section 4.3.1: sd_hash over the US-ASCII bytes of the SD-JWT as presented,
    # the issuer-signed JWT and the selected disclosures, each followed by '~'.
    payload = {"iat": issued_at, "aud": aud, "nonce": nonce, "sd_hash": sha256_b64url(sd_jwt)}
    header = {"alg": ALG_FOR_KIND[kind], "typ": KB_JWT_TYP}
    return sd_jwt + sign_jws(header, payload, holder_key)


def verify_key_binding(
    *,
    compact: str,
    kb_jwt: str,
    cnf_jwk: Mapping[str, Any],
    requirement: KeyBindingRequirement,
    now: float,
    clock_skew_seconds: float,
    allow_eddsa: bool,
) -> Dict[str, Any]:
    """Verify the KB-JWT of a presentation against the cnf key (RFC 9901 section 7.3).

    The caller has already verified the issuer-signed JWT and the cnf key.
    """
    if kb_jwt == "":
        raise PassportError(
            "key_unproven", "key_binding_missing", "this relying party requires a Key Binding JWT"
        )

    def unproven(message: str) -> PassportError:
        return PassportError("key_unproven", "kb_malformed", message)

    jws = parse_jws(kb_jwt)
    if jws is None:
        raise unproven("the KB-JWT is not a compact JWS")
    header, payload = jws.header, jws.payload
    if header.get("typ") != KB_JWT_TYP:
        raise unproven("the KB-JWT typ must be kb+jwt")
    if any(m in header for m in KEY_HEADER_MEMBERS) or "crit" in header:
        # The KB-JWT is checked against the cnf key only (RFC 9901 section 7.3 step 5.3).
        raise unproven("the KB-JWT header must not name a key or critical extensions")
    kind = key_kind(cnf_jwk)
    alg = header.get("alg")
    if kind is None or alg != ALG_FOR_KIND[kind]:
        raise unproven("the KB-JWT alg does not fit the cnf key")
    if alg == "EdDSA" and not allow_eddsa:
        raise PassportError(
            "passport_not_accepted", "eddsa_not_enabled", "EdDSA is not enabled (allow_eddsa)"
        )
    kb_iat: Any = payload.get("iat")
    if (
        not is_safe_int(kb_iat)
        or not isinstance(payload.get("aud"), str)
        or not isinstance(payload.get("nonce"), str)
        or not isinstance(payload.get("sd_hash"), str)
    ):
        raise unproven("the KB-JWT needs iat, aud (a string), nonce and sd_hash")
    if has_private_members(cnf_jwk) or not verify_signature(alg, cnf_jwk, jws):
        raise PassportError(
            "key_binding_mismatch", "kb_signature_mismatch", "the KB-JWT is not signed by the cnf key"
        )
    if payload["aud"] != requirement.aud:
        raise PassportError("audience_mismatch", "audience_mismatch", "the KB-JWT is for another audience")
    if payload["nonce"] != requirement.nonce:
        raise PassportError("key_unproven", "nonce_mismatch", "the KB-JWT nonce is not the one issued")
    max_age = requirement.max_age_seconds
    if kb_iat > now + clock_skew_seconds or kb_iat < now - max_age - clock_skew_seconds:
        raise PassportError("key_unproven", "kb_stale", "the KB-JWT iat is outside the accepted window")
    presented = compact[: len(compact) - len(kb_jwt)]
    if payload["sd_hash"] != sha256_b64url(presented):
        raise PassportError(
            "key_binding_mismatch", "sd_hash_mismatch", "the KB-JWT was made over other disclosures"
        )
    return {"aud": payload["aud"], "nonce": payload["nonce"], "iat": int(kb_iat)}

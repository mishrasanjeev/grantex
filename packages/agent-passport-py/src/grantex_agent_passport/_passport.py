# SPDX-License-Identifier: Apache-2.0
"""The Agent Passport: an SD-JWT VC with vct urn:grantex:agent-passport:1.

spec/agent-passport-1.0.md is the normative description; this module and the
TypeScript package implement it and share the vectors in
spec/examples/agent-passport-vectors.json.
"""

from __future__ import annotations

import math
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from ._b64 import b64url_encode, is_object, is_safe_int
from ._errors import PassportError, malformed
from ._jwk import has_private_members, import_public_key, jwk_thumbprint, key_kind
from ._jws import (
    ALG_FOR_KIND,
    KEY_HEADER_MEMBERS,
    KIND_FOR_ALG,
    parse_jws,
    sign_jws,
    verify_signature,
)
from ._key_binding import KeyBindingRequirement, verify_key_binding
from ._sd_jwt import (
    SD_ALG,
    disclosure_digest,
    encode_disclosure,
    external_credential_hash,
    process_disclosures,
    split_sd_jwt,
)

#: draft-ietf-oauth-sd-jwt-vc section 2.2.1: the typ of an SD-JWT VC (media type application/dc+sd-jwt).
PASSPORT_TYP = "dc+sd-jwt"

#: The credential type of an Agent Passport (draft-ietf-oauth-sd-jwt-vc section 2.2.2.1).
PASSPORT_VCT = "urn:grantex:agent-passport:1"

#: exp may be at most one year (365 days) after iat.
MAX_PASSPORT_LIFETIME_SECONDS = 365 * 86_400

#: The selectively disclosable claims of the profile, in issuing order.
DISCLOSABLE_CLAIMS = ("provider", "agent", "verification", "attestation_id")

# Top-level claims that are never disclosures: the ones draft-ietf-oauth-sd-jwt-vc
# section 2.2.2.3 forbids, plus sub and iat, which the profile keeps in the clear.
_NOT_DISCLOSABLE = {
    "iss",
    "nbf",
    "exp",
    "cnf",
    "vct",
    "vct#integrity",
    "aka_vcts",
    "status",
    "sub",
    "iat",
    "_sd_alg",
}

# W3C DID Core section 3.1 (DID Syntax), the whole string, nothing after it:
#   did                = "did:" method-name ":" method-specific-id
#   method-name        = 1*method-char
#   method-char        = %x61-7A / DIGIT
#   method-specific-id = *( *idchar ":" ) 1*idchar
#   idchar             = ALPHA / DIGIT / "." / "-" / "_" / pct-encoded
#   pct-encoded        = "%" HEXDIG HEXDIG
# A DID URL (path, query or fragment) is not a DID. Used with fullmatch, so a
# trailing newline does not pass as it would with "$".
_IDCHAR = r"(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})"
_DID = re.compile(rf"did:[a-z0-9]+:(?:{_IDCHAR}*:)*{_IDCHAR}+", re.ASCII)

IssuerKeyResolver = Callable[[str], Sequence[Mapping[str, Any]]]

#: Answers the Token Status List value at (uri, idx) of a passport's status
#: reference: "valid", "invalid" or "suspended" (draft-ietf-oauth-status-list
#: section 7.1: VALID 0x00, INVALID 0x01, SUSPENDED 0x02). The relying party's
#: status-list component fetches and verifies the Status List Token (section 8.3)
#: and raises when it has no fresh one.
StatusResolver = Callable[[str, int], str]

#: The status_checked_by value by which a caller states it checks status itself.
STATUS_CHECKED_BY_CALLER = "caller"


@dataclass(frozen=True)
class IssuedDisclosure:
    salt: str
    name: str
    value: Any
    encoded: str
    digest: str


@dataclass(frozen=True)
class IssuedPassport:
    #: The SD-JWT with every disclosure, ending with '~'.
    compact: str
    issuer_jwt: str
    disclosures: List[IssuedDisclosure]


@dataclass(frozen=True)
class VerifiedDisclosure:
    digest: str
    salt: str
    name: Optional[str]
    value: Any


@dataclass(frozen=True)
class VerifiedPassport:
    header: Dict[str, Any]
    #: The issuer-signed payload as signed (digests, not claims).
    payload: Dict[str, Any]
    iss: str
    sub: str
    iat: int
    exp: int
    vct: str
    #: The Token Status List reference, checked for shape only. Not resolved here:
    #: the relying party resolves it and refuses a revoked or suspended passport
    #: (passport_revoked) or a stale list (status_stale) before accepting.
    status: Dict[str, Any]
    cnf_jwk: Dict[str, Any]
    cnf_thumbprint: str
    #: Every claim after processing the disclosures, without _sd and _sd_alg.
    claims: Dict[str, Any]
    #: The profile's disclosable claims that were presented.
    disclosed: Dict[str, Any]
    disclosures: List[VerifiedDisclosure]
    external_credential_hash: str
    key_binding: Optional[Dict[str, Any]] = None
    #: "resolver" when verify_passport resolved status and it was VALID; "caller"
    #: when the caller passed status_checked_by="caller" and checks it itself.
    status_checked_by: str = "resolver"


def _is_https_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("https://") and len(value) > len("https://")


def _is_did(value: Any) -> bool:
    return isinstance(value, str) and _DID.fullmatch(value) is not None


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _is_status_reference(value: Any) -> bool:
    if not is_object(value) or not is_object(value.get("status_list")):
        return False
    uri = value["status_list"].get("uri")
    idx = value["status_list"].get("idx")
    # draft-ietf-oauth-status-list section 6.2: idx a non-negative integer, uri a string.
    return isinstance(uri, str) and uri != "" and is_safe_int(idx) and idx >= 0


def _check_profile_claims(claims: Mapping[str, Any]) -> None:
    """Shape of the profile claims (spec/agent-passport-1.0.md, "Claims"). Extra members are allowed."""

    def bad(name: str) -> PassportError:
        return malformed("bad_claim", f"claim {name} does not have the profile's shape")

    if "provider" in claims:
        p = claims["provider"]
        if (
            not is_object(p)
            or not _is_did(p.get("did"))
            or ("legal_identifiers" in p and not isinstance(p["legal_identifiers"], list))
            or ("name" in p and not isinstance(p["name"], str))
        ):
            raise bad("provider")
    if "agent" in claims:
        a = claims["agent"]
        if (
            not is_object(a)
            or not isinstance(a.get("software_name"), str)
            or a["software_name"] == ""
            or not isinstance(a.get("software_version"), str)
            or a["software_version"] == ""
            or ("cimd_uri" in a and not _is_https_url(a["cimd_uri"]))
            or ("categories" in a and not _is_string_list(a["categories"]))
            or ("declared_limits" in a and not is_object(a["declared_limits"]))
        ):
            raise bad("agent")
    if "verification" in claims:
        v = claims["verification"]
        if (
            not is_object(v)
            or not isinstance(v.get("level"), str)
            or v["level"] == ""
            or ("types" in v and not _is_string_list(v["types"]))
            or ("performed_at" in v and not is_safe_int(v["performed_at"]))
        ):
            raise bad("verification")
    if "attestation_id" in claims:
        value = claims["attestation_id"]
        if not isinstance(value, str) or value == "":
            raise bad("attestation_id")


def _check_cnf(cnf: Any, payments_rails: bool) -> Dict[str, Any]:
    """cnf (RFC 7800 section 3.2): a public P-256 or Ed25519 JWK."""
    if not is_object(cnf) or not is_object(cnf.get("jwk")):
        raise malformed("cnf_missing", "cnf.jwk is required")
    jwk: Dict[str, Any] = cnf["jwk"]
    if has_private_members(jwk):
        raise malformed("cnf_private_key", "cnf.jwk carries private key members")
    kind = key_kind(jwk)
    if kind is None or import_public_key(jwk) is None:
        raise malformed("cnf_unsupported_key", "cnf.jwk must be a P-256 or Ed25519 public key")
    if payments_rails and kind != "P-256":
        raise PassportError(
            "passport_not_accepted", "cnf_not_p256", "payments rails require a P-256 cnf key"
        )
    return jwk


def _check_lifetime(iat: float, exp: float) -> None:
    if exp <= iat:
        raise malformed("bad_claim", "exp must be after iat")
    if exp - iat > MAX_PASSPORT_LIFETIME_SECONDS:
        raise PassportError(
            "passport_not_accepted", "lifetime_exceeds_one_year", "exp is more than one year after iat"
        )


def _new_salt() -> str:
    # RFC 9901 section 9.3: at least 128 bits of randomness per salt.
    return b64url_encode(os.urandom(16))


def issue_passport(
    *,
    issuer_key: Mapping[str, Any],
    iss: str,
    sub: str,
    cnf_jwk: Mapping[str, Any],
    iat: int,
    exp: int,
    status: Mapping[str, Any],
    claims: Mapping[str, Any],
    vct: str = PASSPORT_VCT,
) -> IssuedPassport:
    """Issue an Agent Passport. For the mock issuer and tests; accredited issuers run their own issuance."""
    kind = key_kind(issuer_key)
    if kind is None or not isinstance(issuer_key.get("d"), str):
        raise malformed("bad_key", "the issuer key must be a private P-256 or Ed25519 JWK")
    if not _is_https_url(iss):
        raise malformed("bad_claim", "iss must be the issuer entity_id, an https URL")
    if not _is_did(sub):
        raise malformed("bad_claim", "sub must be the agent DID")
    if not is_safe_int(iat) or not is_safe_int(exp):
        raise malformed("bad_claim", "iat and exp are integers")
    _check_lifetime(iat, exp)
    if not _is_status_reference(status):
        raise malformed("bad_claim", "status must be a Token Status List reference")
    cnf = _check_cnf({"jwk": dict(cnf_jwk)}, False)

    disclosures: List[IssuedDisclosure] = []
    for name, value in claims.items():
        # An absent claim: None is skipped, as the TypeScript package skips null and undefined.
        if value is None:
            continue
        if name in _NOT_DISCLOSABLE or name in ("_sd", "..."):
            raise malformed(
                "disclosure_name_not_allowed", f"claim {name} cannot be selectively disclosed"
            )
        salt = _new_salt()
        encoded = encode_disclosure(salt, name, value)
        disclosures.append(IssuedDisclosure(salt, name, value, encoded, disclosure_digest(encoded)))

    header: Dict[str, Any] = {"alg": ALG_FOR_KIND[kind], "typ": PASSPORT_TYP}
    if isinstance(issuer_key.get("kid"), str):
        header["kid"] = issuer_key["kid"]
    payload: Dict[str, Any] = {
        "iss": iss,
        "sub": sub,
        "iat": iat,
        "exp": exp,
        "vct": vct,
        "cnf": {"jwk": cnf},
        "status": dict(status),
        # RFC 9901 section 4.2.4.1: sorted digests do not reveal the claims' original order.
        "_sd": sorted(d.digest for d in disclosures),
        "_sd_alg": SD_ALG,
    }
    issuer_jwt = sign_jws(header, payload, issuer_key)
    compact = issuer_jwt + "~" + "".join(d.encoded + "~" for d in disclosures)
    return IssuedPassport(compact, issuer_jwt, disclosures)


def _check_number(name: str, value: Any, minimum: float) -> float:
    # A NaN, infinite or non-number time would make the comparisons below pass
    # or fail silently: refuse the call instead. bool is an int subclass, so it
    # is refused by name.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number >= {minimum}")
    number: float = value
    if not math.isfinite(number) or number < minimum:
        raise ValueError(f"{name} must be a finite number >= {minimum}")
    return number


def _check_status_options(status_resolver: Any, status_checked_by: Any) -> None:
    """Exactly one status decision: a resolver, or the caller's statement that it checks status.

    Fail closed: without either, a revoked or suspended passport would be
    returned as verified to a relying party that forgot the status step.
    """
    if status_resolver is not None and status_checked_by is not None:
        raise ValueError("pass either status_resolver or status_checked_by, not both")
    if status_resolver is None and status_checked_by is None:
        raise ValueError(
            "verify_passport needs a status decision: pass status_resolver to resolve the"
            " Token Status List reference, or status_checked_by='caller' if you check it yourself"
        )
    if status_resolver is not None and not callable(status_resolver):
        raise ValueError("status_resolver must be a function (uri, idx) -> status")
    if status_checked_by is not None and status_checked_by != STATUS_CHECKED_BY_CALLER:
        raise ValueError("status_checked_by must be 'caller'")


def _resolve_status(resolver: StatusResolver, uri: str, idx: int) -> None:
    """draft-ietf-oauth-status-list section 7.1 values; anything else is a refusal."""
    try:
        value = resolver(uri, idx)
    except Exception as cause:
        # Section 8.3: when the Status List Token cannot be fetched or validated,
        # no statement about the status can be made and the token is rejected.
        raise PassportError(
            "status_stale", "status_unresolved", "the status resolver failed"
        ) from cause
    # An exact str match only: an unknown or mistyped answer is never read as VALID.
    if type(value) is str and value == "valid":
        return
    if type(value) is str and value == "invalid":
        raise PassportError("passport_revoked", "status_invalid", "the passport is revoked (INVALID)")
    if type(value) is str and value == "suspended":
        raise PassportError(
            "passport_revoked", "status_suspended", "the passport is suspended (SUSPENDED)"
        )
    raise PassportError(
        "status_stale", "status_unknown", "the status resolver returned an unknown status"
    )


def _resolve_issuer_keys(resolver: IssuerKeyResolver, iss: str) -> List[Any]:
    try:
        keys = resolver(iss)
    except Exception as cause:
        # Fail closed: without the issuer's keys nothing can be verified. The cause is chained.
        raise PassportError(
            "passport_invalid_signature",
            "issuer_key_resolution_failed",
            "the issuer key resolver failed",
        ) from cause
    if not isinstance(keys, (list, tuple)):
        raise PassportError(
            "passport_invalid_signature",
            "issuer_key_resolution_failed",
            "the issuer key resolver must return a list of JWKs",
        )
    return list(keys)


def verify_passport(
    compact: str,
    *,
    issuer_keys: IssuerKeyResolver,
    now: Optional[float] = None,
    expected_vct: str = PASSPORT_VCT,
    payments_rails: bool = False,
    allow_eddsa: bool = False,
    clock_skew_seconds: float = 0,
    key_binding: Optional[KeyBindingRequirement] = None,
    status_resolver: Optional[StatusResolver] = None,
    status_checked_by: Optional[str] = None,
) -> VerifiedPassport:
    """Verify an Agent Passport (or a presentation of one) and return its claims.

    issuer_keys returns the issuer's public keys from the relying party's own
    trust configuration (the registry); keys are never taken from the token
    (PRD section 13). Every failure raises PassportError; nothing is returned
    unless every rule of the profile holds.

    Status (spec/agent-passport-1.0.md section 4) is required: pass
    status_resolver, which answers the Token Status List value for the
    passport's (uri, idx); anything but "valid" is refused (passport_revoked
    for "invalid" or "suspended", status_stale when it raises or answers
    anything else). Or pass status_checked_by="caller" to state that you
    resolve ``status`` yourself before accepting. With neither, or both, the
    call raises ValueError.
    """
    _check_status_options(status_resolver, status_checked_by)
    at = _check_number("now", int(time.time()) if now is None else now, 0)
    skew = _check_number("clock_skew_seconds", clock_skew_seconds, 0)
    if key_binding is not None:
        _check_number("key_binding.max_age_seconds", key_binding.max_age_seconds, 0)

    split = split_sd_jwt(compact)
    jws = parse_jws(split.issuer_jwt)
    if jws is None:
        raise malformed("bad_encoding", "the issuer-signed JWT is not a compact JWS")
    header, payload = jws.header, jws.payload

    # Header: typ (SD-JWT VC section 2.2.1), alg, no key in the token, no crit.
    if header.get("typ") != PASSPORT_TYP:
        raise malformed("wrong_typ", f"typ must be {PASSPORT_TYP}")
    alg = header.get("alg")
    if alg not in ("ES256", "EdDSA"):
        raise malformed("alg_not_allowed", "alg must be ES256 (or EdDSA)")
    if alg == "EdDSA" and not allow_eddsa:
        raise PassportError(
            "passport_not_accepted", "eddsa_not_enabled", "EdDSA is not enabled (allow_eddsa)"
        )
    if any(m in header for m in KEY_HEADER_MEMBERS):
        # PRD section 13: issuer keys come only from the injected resolver; never fetch or trust a key the token names.
        raise malformed(
            "header_key_not_allowed",
            "the header names a key; issuer keys come only from the resolver",
        )
    # RFC 7515 section 4.1.11: no extension is understood here, so crit cannot be honoured.
    if "crit" in header:
        raise malformed("crit_not_supported", "crit is not supported")
    kid = header.get("kid")
    if "kid" in header and not isinstance(kid, str):
        raise malformed("bad_encoding", "kid is a string")

    # The issuer identifies which keys to use; the signature is checked before any other claim is read.
    iss = payload.get("iss")
    if not _is_https_url(iss):
        raise malformed("bad_claim", "iss must be the issuer entity_id, an https URL")
    assert isinstance(iss, str)
    keys = _resolve_issuer_keys(issuer_keys, iss)
    matching = [
        k
        for k in keys
        if is_object(k)
        and ("kid" not in header or k.get("kid") == kid)
        and ("alg" not in k or k["alg"] == alg)
    ]
    if any(has_private_members(k) for k in matching):
        # A private key from the resolver is a misconfiguration: refuse rather than use it.
        raise PassportError(
            "passport_invalid_signature", "issuer_key_invalid", "the resolver returned a private key"
        )
    candidates = [k for k in matching if key_kind(k) == KIND_FOR_ALG[alg]]
    if not candidates:
        raise PassportError(
            "passport_invalid_signature", "issuer_key_not_found", "no issuer key for this passport"
        )
    if any(import_public_key(k) is None for k in candidates):
        # Right type and length but not a point on the curve: a broken trust configuration.
        raise PassportError(
            "passport_invalid_signature", "issuer_key_invalid", "the resolver returned an unusable key"
        )
    if not any(verify_signature(alg, k, jws) for k in candidates):
        raise PassportError(
            "passport_invalid_signature", "signature_mismatch", "the issuer signature does not verify"
        )

    # Registered claims.
    vct = payload.get("vct")
    if not isinstance(vct, str):
        raise malformed("bad_claim", "vct is required")
    if vct != expected_vct:
        raise PassportError("passport_not_accepted", "wrong_vct", f"vct must be {expected_vct}")
    sub: Any = payload.get("sub")
    if not _is_did(sub):
        raise malformed("bad_claim", "sub must be the agent DID")
    iat: Any = payload.get("iat")
    exp: Any = payload.get("exp")
    if not is_safe_int(iat) or not is_safe_int(exp):
        raise malformed("bad_claim", "iat and exp are integers")
    nbf: Any = payload.get("nbf")
    if "nbf" in payload and not is_safe_int(nbf):
        raise malformed("bad_claim", "nbf is an integer")
    status: Any = payload.get("status")
    if not _is_status_reference(status):
        raise malformed("bad_claim", "status must be a Token Status List reference")
    if "_sd_alg" in payload and payload["_sd_alg"] != SD_ALG:
        raise malformed("sd_alg_not_supported", f"_sd_alg must be {SD_ALG}")
    _check_lifetime(iat, exp)
    if iat > at + skew or (is_safe_int(nbf) and nbf > at + skew):
        raise PassportError("passport_expired", "not_yet_valid", "the passport is not valid yet")
    if at >= exp + skew:
        raise PassportError("passport_expired", "expired", "the passport has expired")

    cnf_jwk = _check_cnf(payload.get("cnf"), payments_rails)

    claims, decoded = process_disclosures(payload, split.disclosures, _NOT_DISCLOSABLE)
    _check_profile_claims(claims)

    kb_result: Optional[Dict[str, Any]] = None
    if key_binding is None:
        if split.kb_jwt != "":
            raise malformed(
                "unexpected_key_binding",
                "the presentation has a KB-JWT but no key binding was requested",
            )
    else:
        kb_result = verify_key_binding(
            compact=compact,
            kb_jwt=split.kb_jwt,
            cnf_jwk=cnf_jwk,
            requirement=key_binding,
            now=at,
            clock_skew_seconds=skew,
            allow_eddsa=allow_eddsa,
        )

    # Status last: every other rule holds, so the resolver (often a network
    # fetch) is only asked about a passport that would otherwise be accepted.
    if status_resolver is not None:
        _resolve_status(
            status_resolver, status["status_list"]["uri"], status["status_list"]["idx"]
        )

    return VerifiedPassport(
        header=header,
        payload=payload,
        iss=iss,
        sub=str(sub),
        iat=int(iat),
        exp=int(exp),
        vct=vct,
        status=dict(status),
        cnf_jwk=cnf_jwk,
        cnf_thumbprint=jwk_thumbprint(cnf_jwk),
        claims=claims,
        disclosed={name: claims[name] for name in DISCLOSABLE_CLAIMS if name in claims},
        disclosures=[VerifiedDisclosure(d.digest, d.salt, d.name, d.value) for d in decoded],
        external_credential_hash=external_credential_hash(compact),
        key_binding=kb_result,
        status_checked_by="resolver" if status_resolver is not None else STATUS_CHECKED_BY_CALLER,
    )

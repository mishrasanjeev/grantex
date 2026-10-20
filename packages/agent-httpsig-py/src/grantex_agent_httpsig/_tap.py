# SPDX-License-Identifier: Apache-2.0
"""Visa Trusted Agent Protocol body objects, and the Grantex consent record.

The TAP specification defines two signed objects carried in the request body
next to the message signature: ``agenticConsumer`` (consumer recognition:
nonce, idToken, contextualData, kid, alg, signature) and
``agenticPaymentContainer`` (nonce, kid, alg, signature, and optionally
paymentCredentialsHash, cardMetadata, credentialHash, payload, browsingIOU).
Each object's ``nonce`` must equal the message signature's nonce and its
``kid`` should equal the signature's keyid. A consumer object that fails is a
soft failure; a payment container that fails must not be used for payment.

UNCONFIRMED by the published specification, so configurable here: where in
the body the objects are posted (``members``), and the canonicalization the
object signature covers (default RFC 8785 JCS of the object without
``signature``, base64url signature; pass ``canonicalize`` to change it). Only
ES256 and EdDSA are signed and verified; TAP's PS256 examples are reported as
``algorithm_unsupported``.

``grantexConsentRecord`` is a Grantex extension, not part of TAP: the granted
Grantex consent the agent acts under, bound to the same nonce, without any
principal identifier. Mirrors ``packages/agent-httpsig/src/tap.ts``.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from ._errors import AgentHttpSigError
from ._keys import private_key_object, public_key_object, sign_bytes, verify_bytes

JwkLike = Mapping[str, Any]
Canonicalizer = Callable[[Mapping[str, Any]], bytes]

DEFAULT_TAP_BODY_MEMBERS: Mapping[str, str] = {
    "consumer": "agenticConsumer",
    "payment_container": "agenticPaymentContainer",
    "consent_record": "grantexConsentRecord",
}
GRANTEX_CONSENT_RECORD_TYPE = "grantex-consent-record"

_JWS_ALG = {"ecdsa-p256-sha256": "ES256", "ed25519": "EdDSA"}
_ALG_FOR_JWS = {v: k for k, v in _JWS_ALG.items()}


def canonical_json(value: Any) -> str:
    """RFC 8785 JCS for strings, integers, booleans, null, lists and objects.

    Members are sorted by UTF-16 code units (section 3.2.3). Floats are
    refused: their RFC 8785 form is the ECMAScript one, which Python's repr
    does not always match.
    """
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise AgentHttpSigError("floats are not signed; use integers (minor units)")
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, Mapping):
        items = sorted(value.items(), key=lambda kv: str(kv[0]).encode("utf-16-be"))
        return "{" + ",".join(
            json.dumps(str(k), ensure_ascii=False) + ":" + canonical_json(v) for k, v in items
        ) + "}"
    raise AgentHttpSigError("JSON has no representation for %s" % type(value).__name__)


def jcs_canonicalizer(unsigned: Mapping[str, Any]) -> bytes:
    """Default (UNCONFIRMED): RFC 8785 JCS, UTF-8."""
    return canonical_json(unsigned).encode("utf-8")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _non_empty(value: Any) -> bool:
    return isinstance(value, str) and value != ""


def sign_tap_object(
    fields: Mapping[str, Any],
    *,
    key: JwkLike,
    kid: str,
    canonicalize: Optional[Canonicalizer] = None,
) -> Dict[str, Any]:
    """Signs a TAP body object: adds ``kid``, ``alg`` (JWS name) and ``signature``."""
    if not _non_empty(kid):
        raise AgentHttpSigError("kid is required")
    if "signature" in fields:
        raise AgentHttpSigError("the object is already signed")
    private_key, alg = private_key_object(key)
    unsigned = dict(fields)
    unsigned["kid"] = kid
    unsigned["alg"] = _JWS_ALG[alg]
    data = (canonicalize or jcs_canonicalizer)(unsigned)
    unsigned["signature"] = _b64url(sign_bytes(private_key, alg, data))
    return unsigned


def build_agentic_consumer(
    *,
    key: JwkLike,
    kid: str,
    nonce: str,
    id_token: str,
    contextual_data: Optional[Mapping[str, Any]] = None,
    canonicalize: Optional[Canonicalizer] = None,
) -> Dict[str, Any]:
    """The ``agenticConsumer`` object (consumer recognition)."""
    if not _non_empty(nonce):
        raise AgentHttpSigError("nonce is required")
    if not _non_empty(id_token) or len(id_token.split(".")) != 3:
        raise AgentHttpSigError("id_token must be a compact JWT")
    fields: Dict[str, Any] = {"nonce": nonce, "idToken": id_token}
    if contextual_data is not None:
        country = contextual_data.get("countryCode")
        if country is not None and not re.fullmatch(r"[A-Z]{2}", str(country)):
            raise AgentHttpSigError("countryCode is ISO 3166-1 alpha-2")
        zip_code = contextual_data.get("zip")
        if zip_code is not None and not 1 <= len(str(zip_code)) <= 16:
            raise AgentHttpSigError("zip is 1 to 16 characters")
        fields["contextualData"] = dict(contextual_data)
    return sign_tap_object(fields, key=key, kid=kid, canonicalize=canonicalize)


def build_agentic_payment_container(
    *,
    key: JwkLike,
    kid: str,
    nonce: str,
    payment_credentials_hash: Optional[str] = None,
    card_metadata: Optional[Mapping[str, Any]] = None,
    credential_hash: Optional[str] = None,
    payload: Any = None,
    browsing_iou: Optional[Mapping[str, Any]] = None,
    canonicalize: Optional[Canonicalizer] = None,
) -> Dict[str, Any]:
    """The ``agenticPaymentContainer`` object. ``payload`` must already be encrypted."""
    if not _non_empty(nonce):
        raise AgentHttpSigError("nonce is required")
    fields: Dict[str, Any] = {"nonce": nonce}
    for name, value in (
        ("paymentCredentialsHash", payment_credentials_hash),
        ("cardMetadata", card_metadata),
        ("credentialHash", credential_hash),
        ("payload", payload),
        ("browsingIOU", browsing_iou),
    ):
        if value is not None:
            fields[name] = value
    return sign_tap_object(fields, key=key, kid=kid, canonicalize=canonicalize)


def build_grantex_consent_record(
    consent: Mapping[str, Any], *, nonce: str, now: Optional[datetime] = None
) -> Dict[str, Any]:
    """The ``grantexConsentRecord`` object for a granted, unexpired Grantex consent.

    ``consent`` uses the commerce consent record's names in either form
    (``id``, ``merchantId`` / ``merchant_id``, ``agentId``, ``passportType``,
    ``status``, ``approvedScopes``, ``maxAmount``, ``currency``,
    ``consentTextVersion``, ``presentedPayloadHash``, ``approvedAt``,
    ``expiresAt``). Raises for a consent that is not granted, has no
    approved scopes, or has expired.
    """

    def get(camel: str, snake: str) -> Any:
        return consent.get(camel, consent.get(snake))

    if not _non_empty(nonce):
        raise AgentHttpSigError("nonce is required")
    if get("status", "status") != "granted":
        raise AgentHttpSigError("only a granted consent can be presented")
    scopes = get("approvedScopes", "approved_scopes")
    if not scopes:
        raise AgentHttpSigError("the consent has no approved scopes")
    raw_expiry = get("expiresAt", "expires_at")
    try:
        expires = (
            raw_expiry if isinstance(raw_expiry, datetime)
            else datetime.fromisoformat(str(raw_expiry).replace("Z", "+00:00"))
        )
    except ValueError:
        raise AgentHttpSigError("expiresAt is not a timestamp") from None
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= (now or datetime.now(timezone.utc)):
        raise AgentHttpSigError("the consent has expired")
    expires_text = expires.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return {
        "type": GRANTEX_CONSENT_RECORD_TYPE,
        "consent_id": get("id", "id"),
        "merchant_id": get("merchantId", "merchant_id"),
        "agent_id": get("agentId", "agent_id"),
        "passport_type": get("passportType", "passport_type"),
        "scopes": list(scopes),
        "max_amount": get("maxAmount", "max_amount"),
        "currency": get("currency", "currency"),
        "consent_text_version": get("consentTextVersion", "consent_text_version"),
        "presented_payload_hash": get("presentedPayloadHash", "presented_payload_hash"),
        "approved_at": get("approvedAt", "approved_at"),
        "expires_at": expires_text,
        "nonce": nonce,
    }


def with_tap_body_objects(
    body: Mapping[str, Any],
    *,
    consumer: Optional[Mapping[str, Any]] = None,
    payment_container: Optional[Mapping[str, Any]] = None,
    consent_record: Optional[Mapping[str, Any]] = None,
    members: Mapping[str, str] = DEFAULT_TAP_BODY_MEMBERS,
) -> Dict[str, Any]:
    """Places the objects in a JSON object body under the configured members."""
    out = dict(body)
    for name, obj in (
        ("consumer", consumer),
        ("payment_container", payment_container),
        ("consent_record", consent_record),
    ):
        if obj is None:
            continue
        if members[name] in out:
            raise AgentHttpSigError("the body already has a %s member" % members[name])
        out[members[name]] = dict(obj)
    return out


@dataclass(frozen=True)
class TapObjectCheck:
    present: bool
    verified: bool
    problems: List[str] = field(default_factory=list)


@dataclass(frozen=True)
class TapBodyVerification:
    #: Soft: a consumer object that is not verified may be inaccurate.
    consumer: TapObjectCheck
    #: Hard: not verified means the container must not be used for payment.
    payment_container: TapObjectCheck
    usable_for_payment: bool
    consent_record_present: bool
    consent_record_nonce_matches: bool
    consent_id: Optional[str]


def _check_object(
    value: Any,
    required: Sequence[str],
    nonce: str,
    keyid: str,
    resolve_key: Callable[[str], Optional[JwkLike]],
    canonicalize: Canonicalizer,
) -> TapObjectCheck:
    if value is None:
        return TapObjectCheck(False, False)
    if (
        not isinstance(value, Mapping)
        or any(name not in value for name in required)
        or not _non_empty(value.get("kid"))
        or not _non_empty(value.get("signature"))
    ):
        return TapObjectCheck(True, False, ["missing_fields"])
    problems: List[str] = []
    if value.get("nonce") != nonce:
        problems.append("nonce_mismatch")
    if value.get("kid") != keyid:
        problems.append("kid_mismatch")
    alg_name = value.get("alg")
    expected = _ALG_FOR_JWS.get(alg_name) if isinstance(alg_name, str) else None
    if expected is None:
        problems.append("algorithm_unsupported")
        return TapObjectCheck(True, False, problems)
    jwk = resolve_key(value["kid"])
    pub = None if jwk is None else public_key_object(jwk)
    if pub is None or pub[1] != expected:
        problems.append("key_unavailable")
        return TapObjectCheck(True, False, problems)
    unsigned = {k: v for k, v in value.items() if k != "signature"}
    try:
        text = str(value["signature"])
        signature = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        signature = b""
    if not verify_bytes(pub[0], pub[1], canonicalize(unsigned), signature):
        problems.append("signature_invalid")
    return TapObjectCheck(True, not problems, problems)


def verify_tap_body_objects(
    body: Any,
    *,
    nonce: str,
    keyid: str,
    resolve_key: Callable[[str], Optional[JwkLike]],
    members: Mapping[str, str] = DEFAULT_TAP_BODY_MEMBERS,
    canonicalize: Optional[Canonicalizer] = None,
) -> TapBodyVerification:
    """Checks the TAP body objects of a parsed JSON body.

    Call it only after the message signature verified under the ``tap``
    profile, with that signature's ``nonce`` and ``keyid``.
    """
    root: Mapping[str, Any] = body if isinstance(body, Mapping) else {}
    canon = canonicalize or jcs_canonicalizer
    consumer = _check_object(
        root.get(members["consumer"]), ("nonce", "idToken", "kid", "alg", "signature"),
        nonce, keyid, resolve_key, canon,
    )
    container = _check_object(
        root.get(members["payment_container"]), ("nonce", "kid", "alg", "signature"),
        nonce, keyid, resolve_key, canon,
    )
    record = root.get(members["consent_record"])
    is_record = isinstance(record, Mapping)
    return TapBodyVerification(
        consumer=consumer,
        payment_container=container,
        usable_for_payment=container.present and container.verified,
        consent_record_present=record is not None,
        consent_record_nonce_matches=is_record and record.get("nonce") == nonce,  # type: ignore[union-attr]
        consent_id=(
            record.get("consent_id")  # type: ignore[union-attr]
            if is_record and isinstance(record.get("consent_id"), str)  # type: ignore[union-attr]
            else None
        ),
    )


__all__ = [
    "DEFAULT_TAP_BODY_MEMBERS",
    "GRANTEX_CONSENT_RECORD_TYPE",
    "TapBodyVerification",
    "TapObjectCheck",
    "build_agentic_consumer",
    "build_agentic_payment_container",
    "build_grantex_consent_record",
    "canonical_json",
    "jcs_canonicalizer",
    "sign_tap_object",
    "verify_tap_body_objects",
    "with_tap_body_objects",
]

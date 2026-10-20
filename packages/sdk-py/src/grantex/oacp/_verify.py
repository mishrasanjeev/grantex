"""Relying-party verification of OACP artifacts (profile ``oacp-artifact-jws-v1``).

An OACP artifact is an envelope and a payload. The envelope carries
``payload_hash``, the lowercase hex SHA-256 of the RFC 8785 canonical payload,
and ``signature``, a detached compact JWS (RFC 7515 Appendix F) whose
protected header is exactly ``{"alg":"ES256","kid":<issuer_key_id>,
"typ":"oacp-artifact+jws"}`` and whose payload is the RFC 8785 canonical
envelope without ``signature``. Signing the whole envelope binds the scope,
expiry, status entry and safety block as well as the payload hash.

:func:`verify_oacp_artifact` runs the checks in a fixed order and stops at the
first failure, so every implementation (this SDK, ``verifyOacpArtifact`` in
TypeScript, ``VerifyOacpArtifact`` in Go, the auth service) refuses a given
artifact with the same code:

1. ``signature`` is a detached JWS: three base64url parts, empty middle
   (``signature_missing_or_placeholder``);
2. ``signature_alg`` is ES256 (``signature_algorithm_unsupported``);
3. the payload hashes to ``payload_hash`` (``payload_hash_mismatch``);
4. the header is exactly alg/kid/typ with ES256, ``oacp-artifact+jws`` and
   ``kid == issuer_key_id`` (``detached_jws_verification_failed``);
5. the envelope names the pinned issuer and the JWK Set holds exactly one
   usable P-256 key with that kid (``issuer_key_untrusted``);
6. the ES256 signature verifies (``detached_jws_verification_failed``);
7. artifact type, safety block, private fields, timestamps, TTL and scope
   (``artifact_missing_or_invalid``, ``artifact_not_yet_valid``,
   ``artifact_expired_or_stale``, ``artifact_ttl_exceeds_default``,
   ``artifact_scope_mismatch``);
8. the Token Status List entry is VALID (``artifact_revoked``,
   ``artifact_suspended``, or ``revocation_status_unavailable`` when the list
   cannot be fetched or verified: fail closed).

Shared test vectors: ``spec/examples/oacp/oacp-artifact-jws-v1.json``.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Mapping, Optional, Tuple

from ..canonical import canonicalize
from ._fetchers import OacpJwksSource, OacpStatusListSource, url_scheme_allowed
from ._jose import (
    JS_WHITESPACE,
    decode_base64url_strict,
    decode_json_segment,
    encode_base64url,
    is_base64url_shaped,
    is_plain_object,
    is_safe_integer,
    select_verification_key,
    verify_jws_signature,
)
from ._status_list import OACP_TOKEN_STATUS, _read_status
from ._time import epoch_millis, parse_oacp_timestamp

__all__ = [
    "OACP_ARTIFACT_JWS_TYP",
    "OACP_ARTIFACT_MAX_TTL_SECONDS",
    "OACP_FORBIDDEN_PAYLOAD_FIELDS",
    "OACP_PROFILE",
    "OACP_REFUSAL_CODES",
    "OACP_SCOPE_MEMBERS",
    "OACP_SIGNATURE_ALG",
    "OacpVerification",
    "verify_oacp_artifact",
]

OACP_ARTIFACT_JWS_TYP = "oacp-artifact+jws"
OACP_SIGNATURE_ALG = "ES256"
OACP_PROFILE = "oacp-artifact-jws-v1"

#: Longest ``signature`` accepted, in characters.
_MAX_SIGNATURE_LENGTH = 4096

#: Every refusal code :func:`verify_oacp_artifact` returns, in check order.
OACP_REFUSAL_CODES: Tuple[str, ...] = (
    "artifact_missing_or_invalid",
    "signature_missing_or_placeholder",
    "signature_algorithm_unsupported",
    "payload_hash_mismatch",
    "detached_jws_verification_failed",
    "issuer_key_untrusted",
    "artifact_not_yet_valid",
    "artifact_expired_or_stale",
    "artifact_ttl_exceeds_default",
    "artifact_scope_mismatch",
    "artifact_revoked",
    "artifact_suspended",
    "revocation_status_unavailable",
)

#: The longest lifetime (``expires_at - issued_at``) each artifact type may
#: have, in seconds, as the auth service pins them.
OACP_ARTIFACT_MAX_TTL_SECONDS: Mapping[str, int] = MappingProxyType(
    {
        "merchant_capability": 24 * 60 * 60,
        "seller_agent_capability": 6 * 60 * 60,
        "catalog_snapshot": 6 * 60 * 60,
        "offer": 15 * 60,
        "price": 5 * 60,
        "inventory": 60,
        "policy": 6 * 60 * 60,
        "public_discovery": 15 * 60,
        "mandate_capability": 2 * 60,
        "commitment_evidence": 5 * 60,
        "revocation": 24 * 60 * 60,
        "protocol_adapter": 24 * 60 * 60,
    }
)

#: Payload member names that would carry private or enabling data, compared
#: after folding camelCase, hyphens and spaces to snake_case.
OACP_FORBIDDEN_PAYLOAD_FIELDS: frozenset[str] = frozenset(
    {
        "access_token", "api_key", "authorization", "bank_account", "card_number",
        "checkout_payment_enabled", "credential", "credentials", "customer_identifier",
        "live_payment_enabled", "live_provider_enabled", "merchant_private_api_key",
        "merchant_private_api_url", "password", "private_key", "production_allowlist",
        "public_discovery_enabled", "raw_connector_payload", "raw_jwt",
        "raw_provider_payload", "secret", "token", "webhook_secret",
    }
)

#: The envelope members ``expected_scope`` may pin, in comparison order.
OACP_SCOPE_MEMBERS: Tuple[str, ...] = ("tenant_id", "merchant_id", "seller_agent_id", "buyer_agent_id")

_CAMEL = re.compile(r"([a-z0-9])([A-Z])", re.ASCII)
_SEPARATORS = re.compile("[-" + re.escape(JS_WHITESPACE) + "]+")


@dataclass(frozen=True)
class OacpVerification:
    """The outcome of :func:`verify_oacp_artifact`.

    When ``valid`` is true, ``refusal_code`` and ``message`` are ``None`` and
    ``status`` is ``"valid"`` after a Token Status List check or
    ``"not_checked"`` when ``check_status`` was false. When ``valid`` is
    false, ``refusal_code`` is one of :data:`OACP_REFUSAL_CODES`, ``message``
    says why, ``artifact_id`` is the envelope's id when it has one, and the
    other members are ``None``.
    """

    valid: bool
    refusal_code: Optional[str] = None
    message: Optional[str] = None
    artifact_id: Optional[str] = None
    artifact_type: Optional[str] = None
    issuer_key_id: Optional[str] = None
    payload_hash: Optional[str] = None
    expires_at: Optional[str] = None
    status: Optional[str] = None


def _normalize_key(key: str) -> str:
    return _SEPARATORS.sub("_", _CAMEL.sub(r"\1_\2", key)).lower()


def _has_forbidden_field(value: Any) -> bool:
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, (list, tuple)):
            stack.extend(current)
        elif is_plain_object(current):
            for key, child in current.items():
                if isinstance(key, str) and _normalize_key(key) in OACP_FORBIDDEN_PAYLOAD_FIELDS:
                    return True
                stack.append(child)
    return False


def _strict_equal(a: Any, b: Any) -> bool:
    """ECMAScript ``===`` for JSON scalars: ``True`` is not ``1``, ``1`` is ``1.0``."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and bool(a == b)


async def _load_jwks(source: OacpJwksSource, refresh: bool) -> Any:
    if callable(source):
        return await (source(refresh=True) if refresh else source())
    return source


async def verify_oacp_artifact(
    envelope: Any,
    payload: Any,
    *,
    issuer: str,
    jwks: OacpJwksSource,
    now: Optional[datetime] = None,
    expected_scope: Optional[Mapping[str, Any]] = None,
    status_list_fetcher: Optional[OacpStatusListSource] = None,
    check_status: bool = True,
    max_ttl_seconds: Optional[Mapping[str, int]] = None,
    allow_loopback_http: bool = False,
) -> OacpVerification:
    """Verifies an OACP artifact. Never raises for a bad artifact: the result says why it is refused.

    ``issuer`` is the pinned issuer identifier (``envelope["issuer"]`` must
    equal it). ``jwks`` is the issuer's JWK Set, or an async callable bound to
    its pinned JWKS URI (:func:`create_oacp_jwks_fetcher`); a callable is
    asked once more with ``refresh=True`` when the first set has no usable key
    for the kid. ``now`` is the time to verify at (default now; a naive
    ``datetime`` is read as UTC). ``expected_scope`` pins any of
    :data:`OACP_SCOPE_MEMBERS` (members left out or ``None`` are not
    compared). ``status_list_fetcher`` fetches the Token Status List the
    envelope points at (:func:`create_oacp_status_list_fetcher`); without one
    the artifact is refused with ``revocation_status_unavailable`` unless
    ``check_status`` is false, which only offline signature checks (test
    vectors, archives) should use. ``max_ttl_seconds`` overrides
    :data:`OACP_ARTIFACT_MAX_TTL_SECONDS` per artifact type.
    ``allow_loopback_http`` accepts an http status URI on a loopback host
    (local development only).
    """
    artifact_id: Optional[str] = None
    if is_plain_object(envelope):
        candidate = envelope.get("artifact_id")
        if isinstance(candidate, str) and candidate:
            artifact_id = candidate

    def refuse(code: str, message: str) -> OacpVerification:
        return OacpVerification(valid=False, refusal_code=code, message=message, artifact_id=artifact_id)

    if not is_plain_object(envelope):
        return refuse("artifact_missing_or_invalid", "The envelope is not a JSON object.")
    if not is_plain_object(payload):
        return refuse("artifact_missing_or_invalid", "The payload is not a JSON object.")

    # 1. A detached compact JWS: BASE64URL(header) || '..' || BASE64URL(signature).
    signature = envelope.get("signature")
    if not isinstance(signature, str) or len(signature) > _MAX_SIGNATURE_LENGTH:
        return refuse("signature_missing_or_placeholder", "The artifact has no detached JWS signature.")
    parts = signature.split(".")
    if (
        len(parts) != 3
        or parts[1] != ""
        or not parts[0]
        or not parts[2]
        or not is_base64url_shaped(parts[0])
        or not is_base64url_shaped(parts[2])
    ):
        return refuse("signature_missing_or_placeholder", "The signature is not a detached compact JWS.")
    header_segment, _, signature_segment = parts

    # 2. The profile has one algorithm.
    if not _strict_equal(envelope.get("signature_alg"), OACP_SIGNATURE_ALG):
        return refuse("signature_algorithm_unsupported", "The artifact signature algorithm is not ES256.")

    # 3. The payload is the one the envelope commits to.
    try:
        payload_hash = hashlib.sha256(canonicalize(payload).encode("utf-8")).hexdigest()
    except Exception:
        return refuse("artifact_missing_or_invalid", "The payload has no RFC 8785 canonical form.")
    if not _strict_equal(envelope.get("payload_hash"), payload_hash):
        return refuse("payload_hash_mismatch", "The payload does not hash to the envelope payload_hash.")

    # 4. The protected header is exactly the profile's.
    header = decode_json_segment(header_segment)
    issuer_key_id = envelope.get("issuer_key_id")
    if (
        header is None
        or sorted(header.keys()) != ["alg", "kid", "typ"]
        or not _strict_equal(header["alg"], OACP_SIGNATURE_ALG)
        or not _strict_equal(header["typ"], OACP_ARTIFACT_JWS_TYP)
        or not isinstance(issuer_key_id, str)
        or not _strict_equal(header["kid"], issuer_key_id)
    ):
        return refuse(
            "detached_jws_verification_failed",
            "The JWS protected header is not the OACP artifact header.",
        )

    # 5. The pinned issuer's key.
    if not _strict_equal(envelope.get("issuer"), issuer):
        return refuse("issuer_key_untrusted", "The artifact names an issuer other than the pinned one.")
    try:
        key_set = await _load_jwks(jwks, False)
    except Exception:
        return refuse("issuer_key_untrusted", "The issuer JWK Set is unavailable.")
    key = select_verification_key(key_set, issuer_key_id, "ES256")
    if key.key is None and callable(jwks):
        try:
            refreshed = await _load_jwks(jwks, True)
            key_set, key = refreshed, select_verification_key(refreshed, issuer_key_id, "ES256")
        except Exception:
            pass  # keep the first answer
    if key.key is None:
        return refuse("issuer_key_untrusted", f"The issuer key is not trusted: {key.reason}.")

    # 6. ES256 over BASE64URL(header) || '.' || BASE64URL(JCS(envelope without signature)).
    unsigned = {name: value for name, value in envelope.items() if name != "signature"}
    try:
        signing_input = f"{header_segment}.{encode_base64url(canonicalize(unsigned))}"
    except Exception:
        return refuse("detached_jws_verification_failed", "The envelope has no RFC 8785 canonical form.")
    signature_bytes = decode_base64url_strict(signature_segment)
    if signature_bytes is None or not verify_jws_signature("ES256", key.key, signing_input, signature_bytes):
        return refuse("detached_jws_verification_failed", "The detached JWS does not verify.")

    # 7. Type, safety, private fields, time, TTL and scope.
    artifact_type = envelope.get("artifact_type")
    max_ttl: Optional[int] = None
    if isinstance(artifact_type, str):
        override = max_ttl_seconds.get(artifact_type) if max_ttl_seconds is not None else None
        max_ttl = override if override is not None else OACP_ARTIFACT_MAX_TTL_SECONDS.get(artifact_type)
    if not isinstance(artifact_type, str) or max_ttl is None or artifact_id is None:
        return refuse("artifact_missing_or_invalid", "The artifact type or id is missing or unknown.")
    safety = envelope.get("safety")
    if (
        not is_plain_object(safety)
        or safety.get("public_safe") is not True
        or safety.get("contains_private_data") is not False
    ):
        return refuse("artifact_missing_or_invalid", "The artifact safety metadata is not public-safe.")
    if _has_forbidden_field(payload):
        return refuse("artifact_missing_or_invalid", "The payload contains private or enabling fields.")
    now_ms = epoch_millis(now if now is not None else datetime.now(timezone.utc))
    issued_at = parse_oacp_timestamp(envelope.get("issued_at"))
    expires_at = parse_oacp_timestamp(envelope.get("expires_at"))
    has_not_before = "not_before" in envelope
    not_before = parse_oacp_timestamp(envelope["not_before"]) if has_not_before else None
    if issued_at is None or expires_at is None or (has_not_before and not_before is None):
        return refuse("artifact_missing_or_invalid", "The artifact timestamps are invalid.")
    if not_before is not None and now_ms < not_before:
        return refuse("artifact_not_yet_valid", "The artifact is not yet valid.")
    if now_ms > expires_at:
        return refuse("artifact_expired_or_stale", "The artifact has expired.")
    ttl_seconds = (expires_at - issued_at) // 1000
    if ttl_seconds < 0 or ttl_seconds > max_ttl:
        return refuse("artifact_ttl_exceeds_default", "The artifact lifetime exceeds the pinned default.")
    if expected_scope:
        for member in OACP_SCOPE_MEMBERS:
            expected = expected_scope.get(member)
            if expected is not None and not _strict_equal(envelope.get(member), expected):
                return refuse("artifact_scope_mismatch", f"The artifact {member} is outside the expected scope.")

    def accept(status: str) -> OacpVerification:
        return OacpVerification(
            valid=True,
            artifact_id=artifact_id,
            artifact_type=artifact_type,
            issuer_key_id=issuer_key_id,
            payload_hash=payload_hash,
            expires_at=envelope["expires_at"],
            status=status,
        )

    if check_status is False:
        return accept("not_checked")

    # 8. Token Status List (draft-ietf-oauth-status-list §6.2, §8.3), fail closed.
    status_member = envelope.get("status")
    reference: Any = status_member.get("status_list") if is_plain_object(status_member) else None
    if not is_plain_object(reference):
        return refuse("revocation_status_unavailable", "The envelope has no status list entry.")
    idx = reference.get("idx")
    uri = reference.get("uri")
    if (
        not isinstance(uri, str)
        or not is_safe_integer(idx)
        or idx < 0
        or not _strict_equal(envelope.get("revocation_status_url"), uri)
        or not url_scheme_allowed(uri, allow_loopback_http is True)
    ):
        return refuse("revocation_status_unavailable", "The envelope status list entry is malformed.")
    if status_list_fetcher is None:
        return refuse("revocation_status_unavailable", "No status list fetcher is configured.")
    try:
        token = await status_list_fetcher(uri)
        status = _read_status(
            token=token, uri=uri, idx=int(idx), jwks=key_set, issuer=issuer, now_ms=now_ms
        ).status
    except Exception as exc:
        return refuse("revocation_status_unavailable", f"The status list cannot be read: {exc}")
    if status == OACP_TOKEN_STATUS.INVALID:
        return refuse("artifact_revoked", "The artifact is revoked.")
    if status == OACP_TOKEN_STATUS.SUSPENDED:
        return refuse("artifact_suspended", "The artifact is suspended.")
    if status != OACP_TOKEN_STATUS.VALID:
        return refuse("revocation_status_unavailable", f"The status list holds an unknown status {status}.")
    return accept("valid")

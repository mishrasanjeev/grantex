"""Relying-party verification of OACP mandates (profile ``oacp.mandate.v1``).

Grantex issues Intent, Cart and Payment mandates as compact ES256 JWTs
(RFC 7519, RFC 7518 section 3.4) signed by its OACP issuer key (``oacp-`` kid in
the issuer JWK Set), with ``typ`` ``oacp-intent-mandate+jwt``,
``oacp-cart-mandate+jwt`` or ``oacp-payment-mandate+jwt``. The claims carry
AP2 v0.2 member names where AP2 has one (``checkout_hash``,
``transaction_id``, constraints, ``cnf``, ``payee``) and every mandate names
its entry on the OACP Token Status List (``status.status_list``,
draft-ietf-oauth-status-list section 6.1).

:func:`verify_oacp_mandate` mirrors ``verifyOacpMandate`` in TypeScript and
the auth service verifier, stopping at the first failure with the same code:
``mandate_malformed``, ``mandate_algorithm_unsupported``,
``mandate_type_mismatch``, ``issuer_key_untrusted``,
``mandate_signature_invalid``, ``mandate_issuer_mismatch``,
``mandate_claims_invalid``, ``mandate_not_yet_valid``, ``mandate_expired``,
``mandate_lifetime_exceeded``, ``mandate_audience_mismatch``, then the status
list (``mandate_revoked``, ``mandate_suspended``,
``revocation_status_unavailable``: fail closed).
:func:`check_oacp_mandate_chain` checks verified mandates against each other
(``mandate_chain_mismatch``).

Shared test vectors: ``spec/examples/oacp/oacp-mandates-v1.json``.
"""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Mapping, Optional, Tuple, Union

from ..canonical import canonicalize
from ._fetchers import OacpJwksSource, OacpStatusListSource, url_scheme_allowed
from ._jose import (
    decode_base64url_strict,
    decode_json_segment,
    is_plain_object,
    is_safe_integer,
    select_verification_key,
    verify_jws_signature,
)
from ._status_list import OACP_TOKEN_STATUS, _read_status

OACP_MANDATE_TYPES: Tuple[str, ...] = ("intent", "cart", "payment")
OACP_MANDATE_TYP: Dict[str, str] = {
    "intent": "oacp-intent-mandate+jwt",
    "cart": "oacp-cart-mandate+jwt",
    "payment": "oacp-payment-mandate+jwt",
}
OACP_MANDATE_VERSION = "oacp.mandate.v1"
OACP_MANDATE_MAX_LIFETIME_SECONDS = 600
OACP_MANDATE_CLOCK_SKEW_SECONDS = 60
OACP_PAYMENT_RAILS: Tuple[str, ...] = ("plural", "upi_autopay", "card_network_token")
OACP_MANDATE_REFUSAL_CODES: Tuple[str, ...] = (
    "mandate_malformed",
    "mandate_algorithm_unsupported",
    "mandate_type_mismatch",
    "issuer_key_untrusted",
    "mandate_signature_invalid",
    "mandate_issuer_mismatch",
    "mandate_claims_invalid",
    "mandate_not_yet_valid",
    "mandate_expired",
    "mandate_lifetime_exceeded",
    "mandate_audience_mismatch",
    "revocation_status_unavailable",
    "mandate_revoked",
    "mandate_suspended",
)

_B64URL = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
_HASH_B64URL = re.compile(r"[A-Za-z0-9_-]{43}", re.ASCII)
_CURRENCY = re.compile(r"[A-Z]{3}", re.ASCII)
_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}", re.ASCII)
_AMR = re.compile(r"[a-z][a-z0-9_]{0,31}", re.ASCII)
_TOKEN_TYPE = re.compile(r"[a-z][a-z0-9_]{0,63}", re.ASCII)
_HEX64 = re.compile(r"[a-f0-9]{64}", re.ASCII)


@dataclass(frozen=True)
class OacpMandateVerification:
    """The outcome of :func:`verify_oacp_mandate`.

    When ``valid`` is true, ``claims`` holds the verified claims, ``mandate_hash``
    the lowercase hex SHA-256 of the compact JWT (the ledger's ``mandate_hash``)
    and ``status`` is ``"valid"`` or ``"not_checked"``. When false,
    ``refusal_code`` is one of :data:`OACP_MANDATE_REFUSAL_CODES`.
    """

    valid: bool
    refusal_code: Optional[str] = None
    message: Optional[str] = None
    mandate_type: Optional[str] = None
    jti: Optional[str] = None
    kid: Optional[str] = None
    mandate_hash: Optional[str] = None
    claims: Optional[Dict[str, Any]] = None
    status: Optional[str] = None


def oacp_checkout_hash(checkout: Any) -> str:
    """AP2 ``checkout_hash``: unpadded base64url SHA-256 of the RFC 8785 checkout."""
    digest = hashlib.sha256(canonicalize(checkout).encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def oacp_mandate_hash(mandate: str) -> str:
    """Lowercase hex SHA-256 of a compact mandate JWT."""
    return hashlib.sha256(mandate.encode("ascii")).hexdigest()


def _full(pattern: "re.Pattern[str]", value: Any) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _non_negative_int(value: Any) -> bool:
    return is_safe_integer(value) and value >= 0


def _amount(value: Any) -> bool:
    return is_plain_object(value) and _non_negative_int(value.get("value")) and _full(_CURRENCY, value.get("currency"))


def _iso(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _common_valid(c: Mapping[str, Any]) -> bool:
    status: Any = c.get("status")
    entry: Any = status.get("status_list") if is_plain_object(status) else None
    amr: Any = c.get("amr")
    return (
        isinstance(c.get("iss"), str)
        and _full(_REF, c.get("sub"))
        and _full(_REF, c.get("aud"))
        and _non_negative_int(c.get("iat"))
        and _non_negative_int(c.get("exp"))
        and _full(_REF, c.get("jti"))
        and c.get("mandate_version") == OACP_MANDATE_VERSION
        and _full(_REF, c.get("tenant_id"))
        and _full(_REF, c.get("merchant_id"))
        and c.get("aud") == c.get("merchant_id")
        and _full(_REF, c.get("buyer_agent_id"))
        and c.get("presence") in ("human_present", "human_not_present")
        and isinstance(amr, list)
        and all(_full(_AMR, m) for m in amr)
        and _full(_REF, c.get("passport_ref"))
        and _full(_REF, c.get("consent_ref"))
        and is_plain_object(entry)
        and len(entry) == 2
        and isinstance(entry.get("uri"), str)
        and _non_negative_int(entry.get("idx"))
    )


def _type_valid(mandate_type: str, c: Mapping[str, Any]) -> bool:
    if mandate_type == "intent":
        i: Any = c.get("intent")
        cnf: Any = c.get("cnf")
        return (
            is_plain_object(i)
            and _full(_HASH_B64URL, i.get("description_hash"))
            and _amount(i.get("max_amount"))
            and isinstance(i.get("merchants"), list)
            and all(isinstance(m, str) and m for m in i["merchants"])
            and c.get("merchant_id") in i["merchants"]
            and _iso(i.get("expires_at"))
            and isinstance(i.get("constraints"), list)
            and all(is_plain_object(x) and isinstance(x.get("type"), str) for x in i["constraints"])
            and (cnf is None and "cnf" not in c or is_plain_object(cnf) and is_plain_object(cnf.get("jwk")))
        )
    if mandate_type == "cart":
        cart: Any = c.get("cart")
        if not is_plain_object(cart):
            return False
        items: Any = cart.get("line_items")
        ok = (
            _full(_HASH_B64URL, cart.get("checkout_hash"))
            and _full(_REF, cart.get("checkout_id"))
            and isinstance(items, list)
            and len(items) > 0
            and all(
                is_plain_object(item)
                and isinstance(item.get("id"), str)
                and item["id"] != ""
                and is_safe_integer(item.get("quantity"))
                and item["quantity"] >= 1
                and _full(_HASH_B64URL, item.get("digest"))
                for item in items
            )
            and _amount(cart.get("total"))
            and _full(_REF, c.get("intent_mandate_jti"))
        )
        if not ok:
            return False
        w: Any = c.get("webauthn")
        if c.get("presence") == "human_present":
            return (
                is_plain_object(w)
                and _full(_HEX64, w.get("digest"))
                and w.get("challenge") == cart.get("checkout_hash")
                and isinstance(w.get("rp_id"), str)
                and isinstance(w.get("origin"), str)
                and w.get("user_verified") is True
                and isinstance(w.get("asserted_at"), str)
                and _full(_HEX64, w.get("credential_ref"))
                and "passkey" in c.get("amr", [])
            )
        return "webauthn" not in c
    p: Any = c.get("payment")
    if not is_plain_object(p):
        return False
    binding: Any = p.get("token_binding")
    payee: Any = p.get("payee")
    return (
        _full(_HASH_B64URL, p.get("transaction_id"))
        and _non_negative_int(p.get("amount"))
        and _full(_CURRENCY, p.get("currency"))
        and is_plain_object(payee)
        and payee.get("id") == c.get("merchant_id")
        and p.get("rail") in OACP_PAYMENT_RAILS
        and is_plain_object(binding)
        and _full(_TOKEN_TYPE, binding.get("type"))
        and _full(_REF, binding.get("id"))
        and _full(_REF, p.get("cart_mandate_jti"))
    )


async def _load_jwks(source: OacpJwksSource, refresh: bool) -> Any:
    if callable(source):
        return await (source(refresh=True) if refresh else source())
    return source


async def verify_oacp_mandate(
    mandate: Any,
    *,
    issuer: str,
    jwks: OacpJwksSource,
    now: Optional[datetime] = None,
    expected_type: Optional[str] = None,
    expected_audience: Optional[str] = None,
    status_list_fetcher: Optional[OacpStatusListSource] = None,
    status: Union[int, str, None] = None,
    check_status: bool = True,
    allow_loopback_http: bool = False,
) -> OacpMandateVerification:
    """Verifies one OACP mandate. Never raises; a refusal carries its code.

    ``status`` is a status the relying party already read (0, 1, 2 or
    ``"unavailable"``) and is used instead of ``status_list_fetcher``.
    """
    mandate_type: Optional[str] = None

    def refuse(code: str, message: str) -> OacpMandateVerification:
        return OacpMandateVerification(valid=False, refusal_code=code, message=message, mandate_type=mandate_type)

    # 1.
    parts = mandate.split(".") if isinstance(mandate, str) and len(mandate) <= 32768 else []
    if len(parts) != 3 or not all(_full(_B64URL, part) for part in parts):
        return refuse("mandate_malformed", "The mandate is not a compact JWS.")
    header_segment, payload_segment, signature_segment = parts

    # 2.
    header = decode_json_segment(header_segment)
    if header is None:
        return refuse("mandate_malformed", "The header is not a JSON object.")
    if header.get("alg") != "ES256":
        return refuse("mandate_algorithm_unsupported", "The mandate algorithm is not ES256.")
    if len(header) != 3 or not isinstance(header.get("kid"), str) or "typ" not in header:
        return refuse("mandate_malformed", "The header is not exactly alg, kid and typ.")
    mandate_type = next((t for t in OACP_MANDATE_TYPES if OACP_MANDATE_TYP[t] == header.get("typ")), None)
    if mandate_type is None or (expected_type is not None and mandate_type != expected_type):
        return refuse("mandate_type_mismatch", "The mandate typ is not the expected OACP mandate type.")

    # 3.
    kid = header["kid"]
    if not kid.startswith("oacp-"):
        return refuse("issuer_key_untrusted", "The kid is not an OACP issuer key.")
    try:
        key_set = await _load_jwks(jwks, False)
    except Exception:  # noqa: BLE001 - any failure of the source is an untrusted key
        return refuse("issuer_key_untrusted", "The issuer JWK Set is unavailable.")
    key = select_verification_key(key_set, kid, "ES256")
    if not key.ok and callable(jwks):
        try:
            key_set = await _load_jwks(jwks, True)
            key = select_verification_key(key_set, kid, "ES256")
        except Exception:  # noqa: BLE001 - keep the first answer
            pass
    if not key.ok or key.key is None:
        return refuse("issuer_key_untrusted", f"The issuer key is not trusted: {key.reason}.")

    # 4.
    signature = decode_base64url_strict(signature_segment)
    if signature is None or not verify_jws_signature("ES256", key.key, f"{header_segment}.{payload_segment}", signature):
        return refuse("mandate_signature_invalid", "The mandate signature does not verify.")

    # 5.
    claims = decode_json_segment(payload_segment)
    if claims is None:
        return refuse("mandate_malformed", "The claims are not a JSON object.")

    # 6.
    if claims.get("iss") != issuer:
        return refuse("mandate_issuer_mismatch", "The mandate names another issuer.")

    # 7.
    if not _common_valid(claims) or not _type_valid(mandate_type, claims):
        return refuse("mandate_claims_invalid", f"The {mandate_type} mandate claims are missing or malformed.")

    # 8.
    moment = now if now is not None else datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    now_s = int(moment.timestamp())
    iat, exp = claims["iat"], claims["exp"]
    if iat > now_s + OACP_MANDATE_CLOCK_SKEW_SECONDS:
        return refuse("mandate_not_yet_valid", "The mandate is not yet valid.")
    if now_s >= exp:
        return refuse("mandate_expired", "The mandate has expired.")
    if exp <= iat or exp - iat > OACP_MANDATE_MAX_LIFETIME_SECONDS:
        return refuse("mandate_lifetime_exceeded", "The mandate lifetime exceeds the profile maximum.")

    # 9.
    if expected_audience is not None and claims.get("aud") != expected_audience:
        return refuse("mandate_audience_mismatch", "The mandate is for another merchant.")

    accepted = dict(
        valid=True,
        mandate_type=mandate_type,
        jti=claims["jti"],
        kid=kid,
        mandate_hash=oacp_mandate_hash(mandate),
        claims=dict(claims),
    )
    if not check_status:
        return OacpMandateVerification(**accepted, status="not_checked")

    # 10.
    entry: Any = claims["status"]["status_list"]
    uri, idx = entry["uri"], entry["idx"]
    if not url_scheme_allowed(uri, allow_loopback_http):
        return refuse("revocation_status_unavailable", "The mandate does not name an https status list.")
    read: Union[int, str]
    if status is not None:
        read = status
    elif status_list_fetcher is None:
        return refuse("revocation_status_unavailable", "No status list fetcher is configured.")
    else:
        try:
            token = await status_list_fetcher(uri)
            read = _read_status(token=token, uri=uri, idx=idx, jwks=key_set, issuer=issuer, now_ms=now_s * 1000).status
        except Exception as err:  # noqa: BLE001 - fail closed on any read failure
            return refuse("revocation_status_unavailable", f"The status list cannot be read: {err}")
    if read == OACP_TOKEN_STATUS.INVALID and not isinstance(read, bool):
        return refuse("mandate_revoked", "The mandate is revoked.")
    if read == OACP_TOKEN_STATUS.SUSPENDED and not isinstance(read, bool):
        return refuse("mandate_suspended", "The mandate is suspended.")
    if isinstance(read, bool) or read != OACP_TOKEN_STATUS.VALID:
        return refuse("revocation_status_unavailable", "The mandate status could not be established.")
    return OacpMandateVerification(**accepted, status="valid")


def check_oacp_mandate_chain(
    *,
    intent: Optional[Mapping[str, Any]] = None,
    cart: Optional[Mapping[str, Any]] = None,
    payment: Optional[Mapping[str, Any]] = None,
) -> Optional[str]:
    """Checks verified mandate claims against each other.

    Returns ``None`` when consistent, else ``"mandate_chain_mismatch"``.
    """

    def same(a: Mapping[str, Any], b: Mapping[str, Any]) -> bool:
        return all(a.get(k) == b.get(k) for k in ("tenant_id", "merchant_id", "sub", "buyer_agent_id", "consent_ref", "iss"))

    if intent is not None and cart is not None:
        if not same(intent, cart) or cart.get("intent_mandate_jti") != intent.get("jti"):
            return "mandate_chain_mismatch"
        cap = (intent.get("intent") or {}).get("max_amount") or {}
        total = (cart.get("cart") or {}).get("total") or {}
        if total.get("currency") != cap.get("currency") or not isinstance(total.get("value"), int) or total["value"] > cap.get("value", -1):
            return "mandate_chain_mismatch"
        if cart.get("merchant_id") not in ((intent.get("intent") or {}).get("merchants") or []):
            return "mandate_chain_mismatch"
        if cart.get("exp", 0) > intent.get("exp", 0):
            return "mandate_chain_mismatch"
        if intent.get("presence") == "human_present" and cart.get("presence") != "human_present":
            return "mandate_chain_mismatch"
    if cart is not None and payment is not None:
        p = payment.get("payment") or {}
        c = cart.get("cart") or {}
        total = c.get("total") or {}
        if not same(cart, payment) or p.get("cart_mandate_jti") != cart.get("jti"):
            return "mandate_chain_mismatch"
        if (
            p.get("transaction_id") != c.get("checkout_hash")
            or p.get("amount") != total.get("value")
            or p.get("currency") != total.get("currency")
            or payment.get("presence") != cart.get("presence")
            or payment.get("exp", 0) > cart.get("exp", 0)
        ):
            return "mandate_chain_mismatch"
    if intent is not None and payment is not None and cart is None:
        return "mandate_chain_mismatch"
    return None

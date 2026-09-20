"""Offline verification of decision grants (PRD G-3).

Verification here proves that a decision grant is authentic, unexpired and
approves exactly the action about to be performed on the current case
version, and, for four eyes, that two different people approved it. It does
**not** prove that the grant has not been used: that needs the issuer's
atomic consumption (:meth:`grantex.Grantex.decisions.consume`), which
``enforce()`` performs before it allows the call.

The token profile is specified in ``spec/decision-grant.md``.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple, Union

import jwt

from .._errors import GrantexTokenError
from ..denials import DecisionSubReason
from ._action import ActionValidationError, DecisionAction, is_action_hash

__all__ = [
    "DECISION_GRANT_AUDIENCE",
    "DECISION_GRANT_TYP",
    "DecisionGrant",
    "DecisionGrantError",
    "DecisionGrantSet",
    "FourEyes",
    "verify_decision_grant",
    "verify_decision_grants",
]

DECISION_GRANT_TYP = "decision+jwt"
DECISION_GRANT_AUDIENCE = "urn:grantex:decision"

_JTI_RE = re.compile(r"^dgnt_[0-9A-HJKMNP-TV-Z]{26}\Z")
_MAX_TOKEN_LENGTH = 16_384

KeyResolver = Callable[[Mapping[str, Any]], Any]
"""Returns the verification key for a token's protected header."""


class DecisionGrantError(Exception):
    """A decision grant is absent, unusable or does not match the call.

    ``sub_reason`` is a :class:`grantex.denials.DecisionSubReason` value.
    """

    def __init__(self, sub_reason: str, message: str) -> None:
        super().__init__(message)
        self.sub_reason = sub_reason


@dataclass(frozen=True)
class FourEyes:
    approvals_required: int
    position: int
    first_jti: Optional[str] = None
    first_sub: Optional[str] = None


@dataclass(frozen=True)
class DecisionGrant:
    """The verified claims of one decision grant."""

    token: str
    jti: str
    iss: str
    sub: str
    dev: str
    idp: str
    approver_auth: str
    amr: Tuple[str, ...]
    auth_time: int
    action: DecisionAction
    action_hash: str
    connector: str
    case_version: str
    dwell_ms: int
    decision_request: str
    iat: int
    exp: int
    memo_hash: str
    policy_score_hash: str
    dwell_source: str = "server"
    acr: Optional[str] = None
    memo_ref: Optional[str] = None
    policy_score_ref: Optional[str] = None
    four_eyes: Optional[FourEyes] = None


@dataclass(frozen=True)
class DecisionGrantSet:
    """Decision grants that together authorise one action."""

    grants: Tuple[DecisionGrant, ...]
    action: DecisionAction
    action_hash: str
    case_version: str
    approvals_required: int

    @property
    def tokens(self) -> Tuple[str, ...]:
        return tuple(g.token for g in self.grants)

    @property
    def jtis(self) -> Tuple[str, ...]:
        return tuple(g.jti for g in self.grants)


def _as_action(value: Union[DecisionAction, Mapping[str, Any]]) -> DecisionAction:
    if isinstance(value, DecisionAction):
        return value
    try:
        return DecisionAction.from_dict(value)
    except ActionValidationError as exc:
        raise DecisionGrantError(
            DecisionSubReason.MALFORMED, f"expected action is invalid: {exc}"
        ) from exc


_KEY_TYPES = {"RS256": "RSA", "ES256": "EC"}
_UNKNOWN_KID_COOLDOWN_SECONDS = 30.0


def _default_key_resolver(jwks_uri: str) -> KeyResolver:
    """Resolves the key named by ``kid`` in the issuer's JWKS, of the type the
    algorithm needs (RSA for RS256, P-256 EC for ES256); an unknown ``kid``
    refetches the set at most once per cooldown."""
    from jwt.algorithms import ECAlgorithm, RSAAlgorithm

    from .._verify import _get_jwks

    def resolve(header: Mapping[str, Any]) -> Any:
        kid = header.get("kid")
        alg = header.get("alg")
        if not isinstance(kid, str) or not kid:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant has no kid")
        kty = _KEY_TYPES.get(alg) if isinstance(alg, str) else None
        if kty is None:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant algorithm {alg!r} is not allowed")

        def select(keys: Sequence[Mapping[str, Any]]) -> Optional[Mapping[str, Any]]:
            matches = [k for k in keys if k.get("kid") == kid and k.get("kty") == kty]
            if len(matches) > 1:
                raise DecisionGrantError(DecisionSubReason.MALFORMED, f"JWKS has several keys with kid {kid!r}")
            if matches and kty == "EC" and matches[0].get("crv") != "P-256":
                return None
            return matches[0] if matches else None

        try:
            entry = _get_jwks(jwks_uri)
            matched = select(entry.keys)
            if matched is None and time.monotonic() - entry.fetched_at >= _UNKNOWN_KID_COOLDOWN_SECONDS:
                entry = _get_jwks(jwks_uri, force_refresh=True)
                matched = select(entry.keys)
        except GrantexTokenError as exc:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, f"issuer keys unavailable: {exc}") from exc
        if matched is None:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, f"no {kty} key with kid {kid!r} in the issuer's JWKS")
        try:
            return (RSAAlgorithm if kty == "RSA" else ECAlgorithm).from_jwk(dict(matched))
        except Exception as exc:  # noqa: BLE001 - an unusable key refuses the grant
            raise DecisionGrantError(DecisionSubReason.MALFORMED, "issuer key cannot be used") from exc

    return resolve


def _claim_str(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant claim {key} is missing")
    return value


def _claim_int(payload: Mapping[str, Any], key: str) -> int:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant claim {key} is invalid")
    return value


def _parse_four_eyes(value: Any) -> Optional[FourEyes]:
    if value is None:
        return None
    if not isinstance(value, Mapping) or value.get("approvals_required") != 2 or value.get("position") not in (1, 2):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant four_eyes is invalid")
    first_jti = value.get("first_jti")
    first_sub = value.get("first_sub")
    if value["position"] == 2 and (not isinstance(first_jti, str) or not isinstance(first_sub, str)):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "the second approval must name the first")
    return FourEyes(
        approvals_required=2,
        position=int(value["position"]),
        first_jti=first_jti if isinstance(first_jti, str) else None,
        first_sub=first_sub if isinstance(first_sub, str) else None,
    )


def verify_decision_grant(
    token: str,
    expected_action: Union[DecisionAction, Mapping[str, Any]],
    case_version: str,
    *,
    jwks_uri: Optional[str] = None,
    issuer: str,
    key_resolver: Optional[KeyResolver] = None,
    developer_id: Optional[str] = None,
    connector: Optional[str] = None,
    algorithms: Sequence[str] = ("RS256", "ES256"),
    clock_tolerance: int = 0,
    now: Optional[int] = None,
) -> DecisionGrant:
    """Verify one decision grant against the action about to be performed.

    Checks, failing with :class:`DecisionGrantError` and a sub-reason:

    - ``malformed``: not a ``typ: decision+jwt`` JWT, bad signature, wrong
      issuer or audience, missing or invalid claims, or an ``action_hash`` that
      is not the hash of the ``action`` claim;
    - ``unknown_grant``: issued to another developer (``developer_id``);
    - ``wrong_case``: approves an action on another case;
    - ``action_mismatch``: approves another action on this case, or for
      another connector;
    - ``case_changed``: approved for another case version;
    - ``expired``: past ``exp`` (after the signature is known to be good).

    It does not check single use; see the module documentation.
    """
    if not isinstance(token, str) or not token or len(token) > _MAX_TOKEN_LENGTH:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant must be a compact JWT")
    expected = _as_action(expected_action)
    if not isinstance(case_version, str) or not case_version:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "case_version is required")
    if key_resolver is None:
        if jwks_uri is None:
            raise ValueError("verify_decision_grant needs jwks_uri or key_resolver")
        key_resolver = _default_key_resolver(jwks_uri)

    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant is not a JWT: {exc}") from exc
    if header.get("typ") != DECISION_GRANT_TYP:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant typ must be {DECISION_GRANT_TYP}")
    if not isinstance(header.get("kid"), str) or not header.get("kid"):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant has no kid")
    if header.get("alg") not in tuple(algorithms) or header.get("alg") not in _KEY_TYPES:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant algorithm {header.get('alg')!r} is not allowed")
    try:
        key = key_resolver(header)
    except DecisionGrantError:
        raise
    except GrantexTokenError as exc:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"no key to verify the decision grant: {exc}") from exc

    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            key,
            algorithms=list(algorithms),
            audience=DECISION_GRANT_AUDIENCE,
            issuer=issuer,
            options={
                # Time is checked below against ``now``, after the signature.
                "verify_exp": False, "verify_iat": False, "verify_nbf": False,
                "require": ["iss", "aud", "sub", "jti", "iat", "exp"],
            },
        )
    except jwt.PyJWTError as exc:
        raise DecisionGrantError(
            DecisionSubReason.MALFORMED, f"decision grant signature, issuer or audience is invalid: {exc}"
        ) from exc

    jti = _claim_str(payload, "jti")
    if not _JTI_RE.match(jti):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant jti is malformed")
    try:
        action = DecisionAction.from_dict(payload.get("action"))
    except ActionValidationError as exc:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, f"decision grant action is malformed: {exc}") from exc
    action_hash = _claim_str(payload, "action_hash")
    if not is_action_hash(action_hash) or action.action_hash() != action_hash:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant action_hash does not match its action")
    amr = payload.get("amr")
    if not isinstance(amr, list) or not all(isinstance(v, str) for v in amr):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant amr is invalid")
    acr = payload.get("acr")
    if acr is not None and not isinstance(acr, str):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant acr is invalid")
    if payload.get("dwell_source") != "server":
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant dwell time was not measured by the issuer")
    memo_hash = _claim_str(payload, "memo_hash")
    policy_score_hash = _claim_str(payload, "policy_score_hash")
    if not is_action_hash(memo_hash) or not is_action_hash(policy_score_hash):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant memo or policy score hash is malformed")
    iat = _claim_int(payload, "iat")
    exp = _claim_int(payload, "exp")
    if exp <= iat or exp - iat > 86_400:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant lifetime exceeds 24 hours")

    grant = DecisionGrant(
        token=token,
        jti=jti,
        iss=_claim_str(payload, "iss"),
        sub=_claim_str(payload, "sub"),
        dev=_claim_str(payload, "dev"),
        idp=_claim_str(payload, "idp"),
        approver_auth=_claim_str(payload, "approver_auth"),
        amr=tuple(amr),
        auth_time=_claim_int(payload, "auth_time"),
        action=action,
        action_hash=action_hash,
        connector=_claim_str(payload, "connector"),
        case_version=_claim_str(payload, "case_version"),
        dwell_ms=_claim_int(payload, "dwell_ms"),
        decision_request=_claim_str(payload, "decision_request"),
        iat=iat,
        exp=exp,
        memo_hash=memo_hash,
        policy_score_hash=policy_score_hash,
        acr=acr,
        memo_ref=payload.get("memo_ref") if isinstance(payload.get("memo_ref"), str) else None,
        policy_score_ref=payload.get("policy_score_ref") if isinstance(payload.get("policy_score_ref"), str) else None,
        four_eyes=_parse_four_eyes(payload.get("four_eyes")),
    )

    if developer_id is not None and grant.dev != developer_id:
        raise DecisionGrantError(DecisionSubReason.UNKNOWN_GRANT, "decision grant was issued to another developer")
    if grant.action.case_id != expected.case_id:
        raise DecisionGrantError(DecisionSubReason.WRONG_CASE, "decision grant is for another case")
    if grant.action_hash != expected.action_hash():
        raise DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, "decision grant approves a different action")
    if connector is not None and grant.connector != connector:
        raise DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, "decision grant approves an action on another connector")
    if grant.case_version != case_version:
        raise DecisionGrantError(DecisionSubReason.CASE_CHANGED, "decision grant was approved for another case version")
    current = int(time.time()) if now is None else now
    if grant.iat > current + clock_tolerance + 60:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grant is issued in the future")
    if current >= grant.exp + clock_tolerance:
        raise DecisionGrantError(DecisionSubReason.EXPIRED, "decision grant has expired")
    return grant


def verify_decision_grants(
    tokens: Sequence[str],
    expected_action: Union[DecisionAction, Mapping[str, Any]],
    case_version: str,
    *,
    issuer: str,
    approvals_required: int = 1,
    jwks_uri: Optional[str] = None,
    key_resolver: Optional[KeyResolver] = None,
    developer_id: Optional[str] = None,
    connector: Optional[str] = None,
    algorithms: Sequence[str] = ("RS256", "ES256"),
    clock_tolerance: int = 0,
    now: Optional[int] = None,
) -> DecisionGrantSet:
    """Verify the decision grants for one action, including four eyes.

    ``approvals_required`` is 2 when the manifest lists the decision in
    ``four_eyes_on``; a grant that itself says two approvals are required
    raises the requirement to 2 as well. With two approvals required, exactly
    two grants with different ``sub`` are needed, the second naming the first
    (``same_approver``, ``four_eyes_incomplete`` or ``malformed`` otherwise).
    """
    if approvals_required not in (1, 2):
        raise ValueError("approvals_required must be 1 or 2")
    if isinstance(tokens, str) or not isinstance(tokens, Sequence):
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "decision grants must be a sequence of tokens")
    if len(tokens) == 0:
        raise DecisionGrantError(DecisionSubReason.ABSENT, "no decision grant was presented")
    if len(tokens) > 2:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "at most two decision grants can be presented")
    expected = _as_action(expected_action)
    grants = tuple(
        verify_decision_grant(
            t, expected, case_version,
            jwks_uri=jwks_uri, issuer=issuer, key_resolver=key_resolver, developer_id=developer_id,
            connector=connector, algorithms=algorithms, clock_tolerance=clock_tolerance, now=now,
        )
        for t in tokens
    )
    required = max([approvals_required] + [g.four_eyes.approvals_required for g in grants if g.four_eyes])
    if len({g.jti for g in grants}) != len(grants):
        raise DecisionGrantError(DecisionSubReason.SAME_APPROVER, "the same decision grant was presented twice")
    if len(grants) < required:
        raise DecisionGrantError(
            DecisionSubReason.FOUR_EYES_INCOMPLETE,
            "this decision needs two approvals from different people",
        )
    if len(grants) > required:
        raise DecisionGrantError(DecisionSubReason.MALFORMED, "more decision grants than this decision needs")
    if required == 2:
        first, second = sorted(grants, key=lambda g: g.four_eyes.position if g.four_eyes else 0)
        if first.sub == second.sub:
            raise DecisionGrantError(DecisionSubReason.SAME_APPROVER, "both decision grants were approved by the same person")
        if (
            first.four_eyes is None or second.four_eyes is None
            or first.four_eyes.position != 1 or second.four_eyes.position != 2
            or second.four_eyes.first_jti != first.jti or second.four_eyes.first_sub != first.sub
            or first.decision_request != second.decision_request
        ):
            raise DecisionGrantError(DecisionSubReason.MALFORMED, "the second approval does not reference the first")
        grants = (first, second)
    return DecisionGrantSet(
        grants=grants,
        action=expected,
        action_hash=expected.action_hash(),
        case_version=case_version,
        approvals_required=required,
    )

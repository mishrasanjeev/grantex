"""Auth-service API for decision grants (PRD G-3): ``Grantex.decisions``."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple, Union
from urllib.parse import quote

from .._errors import GrantexApiError, GrantexError
from .._http import HttpClient
from ..denials import DecisionSubReason
from ._action import DecisionAction
from ._verify import DecisionGrantError, DecisionGrantSet

__all__ = [
    "APPROVER_SESSION_HEADER",
    "ConsumedDecision",
    "DecisionConsumer",
    "DecisionsClient",
]

APPROVER_SESSION_HEADER = "Grantex-Approver-Session"

_KNOWN_SUB_REASONS = frozenset(
    v for k, v in vars(DecisionSubReason).items() if k.isupper() and isinstance(v, str)
)


@dataclass(frozen=True)
class ConsumedDecision:
    """The issuer's record that decision grants were consumed for one action."""

    request_id: str
    jtis: Tuple[str, ...]
    action_hash: str
    approvers: Tuple[Dict[str, Any], ...]


class DecisionConsumer(Protocol):
    """Consumes decision grants atomically at their issuer."""

    def consume(
        self,
        grants: DecisionGrantSet,
        *,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
    ) -> ConsumedDecision: ...


def _action_dict(action: Union[DecisionAction, Mapping[str, Any]]) -> Dict[str, Any]:
    return action.to_dict() if isinstance(action, DecisionAction) else DecisionAction.from_dict(action).to_dict()


class DecisionsClient:
    """Decision requests, approvals and consumption on the Grantex auth service.

    The auth service must run with ``DECISION_GRANTS_ENABLED=true``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # ── Approvers ────────────────────────────────────────────────────────

    def create_approver_session(self, connection_id: str, id_token: str) -> Dict[str, Any]:
        """Exchange a step-up ID token (from an OIDC SSO connection) for an approver session."""
        data: Dict[str, Any] = self._http.post(
            "/v1/decisions/approver-sessions",
            {"connectionId": connection_id, "idToken": id_token},
            retry=False,
        )
        return data

    def revoke_approver_session(self, session_id: str) -> None:
        self._http.delete(f"/v1/decisions/approver-sessions/{quote(session_id, safe='')}")

    # ── Cases and requests ───────────────────────────────────────────────

    def set_case_version(self, case_id: str, case_version: str) -> Dict[str, Any]:
        """Register the case's current version; unconsumed grants for other versions are revoked."""
        data: Dict[str, Any] = self._http.put(
            f"/v1/decisions/cases/{quote(case_id, safe='')}", {"caseVersion": case_version}
        )
        return data

    def create_request(
        self,
        action: Union[DecisionAction, Mapping[str, Any]],
        *,
        connector: str,
        case_version: str,
        four_eyes_on: Optional[Sequence[str]] = None,
        approvals_required: Optional[int] = None,
        expires_in_seconds: Optional[int] = None,
        memo_ref: Optional[str] = None,
        policy_score_ref: Optional[str] = None,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ask a person to decide one semantic action. Idempotent while the request is open."""
        body: Dict[str, Any] = {
            "action": _action_dict(action),
            "connector": connector,
            "caseVersion": case_version,
        }
        optional = {
            "fourEyesOn": list(four_eyes_on) if four_eyes_on is not None else None,
            "approvalsRequired": approvals_required,
            "expiresInSeconds": expires_in_seconds,
            "memoRef": memo_ref,
            "policyScoreRef": policy_score_ref,
            "agentId": agent_id,
            "grantId": grant_id,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        data: Dict[str, Any] = self._http.post("/v1/decisions/requests", body)
        return data

    def get_request(self, request_id: str) -> Dict[str, Any]:
        """Status and approvals; ``decisionGrants`` once fully approved and still usable."""
        data: Dict[str, Any] = self._http.get(f"/v1/decisions/requests/{quote(request_id, safe='')}")
        return data

    def cancel_request(self, request_id: str) -> Dict[str, Any]:
        data: Dict[str, Any] = self._http.post(f"/v1/decisions/requests/{quote(request_id, safe='')}/cancel")
        return data

    def approve(self, request_id: str, *, approver_session: str, action_hash: str, dwell_ms: int) -> Dict[str, Any]:
        """Approve the action the approver was shown; returns ``decisionGrant``.

        ``action_hash`` must be the hash displayed to the approver and
        ``dwell_ms`` the time from rendering the decision to the click.
        """
        data: Dict[str, Any] = self._http.post(
            f"/v1/decisions/requests/{quote(request_id, safe='')}/approvals",
            {"actionHash": action_hash, "dwellMs": dwell_ms},
            headers={APPROVER_SESSION_HEADER: approver_session},
            retry=False,
        )
        return data

    def create_page_ticket(self, request_id: str, *, approver_session: str) -> Dict[str, Any]:
        """One-time link to the auth service's approval page for this approver."""
        data: Dict[str, Any] = self._http.post(
            f"/v1/decisions/requests/{quote(request_id, safe='')}/page-tickets",
            headers={APPROVER_SESSION_HEADER: approver_session},
            retry=False,
        )
        return data

    # ── Consumption ──────────────────────────────────────────────────────

    def consume(
        self,
        grants: Union[DecisionGrantSet, Sequence[str]],
        action: Optional[Union[DecisionAction, Mapping[str, Any]]] = None,
        case_version: Optional[str] = None,
        *,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
    ) -> ConsumedDecision:
        """Consume decision grants atomically at the auth service.

        Pass a :class:`DecisionGrantSet` from :func:`verify_decision_grants`, or
        the tokens with the action and case version. Raises
        :class:`DecisionGrantError` with the issuer's sub-reason when refused,
        and ``consume_unavailable`` when the issuer cannot be reached or answers
        unexpectedly: an unconfirmed consumption is never treated as success.
        """
        if isinstance(grants, DecisionGrantSet):
            tokens: List[str] = list(grants.tokens)
            action_body = grants.action.to_dict()
            version = grants.case_version
        else:
            if action is None or case_version is None:
                raise ValueError("consume needs the action and case_version when given tokens")
            tokens = list(grants)
            action_body = _action_dict(action)
            version = case_version
        body: Dict[str, Any] = {"decisionGrants": tokens, "action": action_body, "caseVersion": version}
        if agent_id is not None:
            body["agentId"] = agent_id
        if grant_id is not None:
            body["grantId"] = grant_id
        try:
            data = self._http.post("/v1/decisions/consume", body, retry=False)
        except GrantexApiError as exc:
            payload = exc.body if isinstance(exc.body, dict) else {}
            sub_reason = payload.get("subReason")
            if exc.status_code in (400, 404, 409, 410) and isinstance(sub_reason, str) and sub_reason in _KNOWN_SUB_REASONS:
                raise DecisionGrantError(sub_reason, str(exc)) from exc
            raise DecisionGrantError(
                DecisionSubReason.CONSUME_UNAVAILABLE, f"decision grant could not be consumed: {exc}"
            ) from exc
        except GrantexError as exc:
            raise DecisionGrantError(
                DecisionSubReason.CONSUME_UNAVAILABLE, f"decision grant could not be consumed: {exc}"
            ) from exc
        if not isinstance(data, dict) or data.get("consumed") is not True or not isinstance(data.get("jtis"), list):
            raise DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, "unexpected response from the auth service")
        if sorted(data["jtis"]) != sorted(_jtis_of(grants)):
            raise DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, "the auth service consumed different decision grants")
        approvers = data.get("approvers")
        return ConsumedDecision(
            request_id=str(data.get("requestId", "")),
            jtis=tuple(str(j) for j in data["jtis"]),
            action_hash=str(data.get("actionHash", "")),
            approvers=tuple(a for a in approvers if isinstance(a, dict)) if isinstance(approvers, list) else (),
        )


def _jtis_of(grants: Union[DecisionGrantSet, Sequence[str]]) -> List[str]:
    if isinstance(grants, DecisionGrantSet):
        return list(grants.jtis)
    # Tokens were not verified locally; read the jti claims without trusting them
    # (the issuer verified the signatures before consuming).
    import jwt

    out: List[str] = []
    for token in grants:
        try:
            claims = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError:
            continue
        jti = claims.get("jti")
        if isinstance(jti, str):
            out.append(jti)
    return out


class _ClientConsumer:
    """Adapts :class:`DecisionsClient` to :class:`DecisionConsumer`."""

    def __init__(self, client: DecisionsClient) -> None:
        self._client = client

    def consume(
        self,
        grants: DecisionGrantSet,
        *,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
    ) -> ConsumedDecision:
        return self._client.consume(grants, agent_id=agent_id, grant_id=grant_id)

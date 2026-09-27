"""Auth-service API for decision grants (PRD G-3): ``Grantex.decisions``."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Protocol, Sequence, Tuple, Union
from urllib.parse import quote

from .._errors import GrantexApiError, GrantexError
from .._http import HttpClient
from ..denials import DecisionSubReason
from ._action import DecisionAction
from ._verify import DecisionGrantError, DecisionGrantSet

__all__ = [
    "ConsumedDecision",
    "DecisionConsumer",
    "DecisionsClient",
]

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
    """Consumes decision grants atomically at their issuer.

    ``enforce()`` passes ``agent_did`` and ``grant_id`` from the caller's
    verified grant token; an issuer that binds decision grants to the
    requesting agent refuses a decision requested for another agent or grant
    (``wrong_agent``). ``enforce()`` passes ``agent_did`` only to a consumer
    whose ``consume`` declares it (or ``**kwargs``), so a consumer written
    before it existed keeps working and consumes as before.
    """

    def consume(
        self,
        grants: DecisionGrantSet,
        *,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
        agent_did: Optional[str] = None,
    ) -> ConsumedDecision:
        """Consume every grant in ``grants`` or none. Raise
        ``DecisionGrantError`` with the refusal's sub-reason, or any other
        exception when the issuer cannot confirm consumption."""


def _action_dict(action: Union[DecisionAction, Mapping[str, Any]]) -> Dict[str, Any]:
    return action.to_dict() if isinstance(action, DecisionAction) else DecisionAction.from_dict(action).to_dict()


class DecisionsClient:
    """Decision requests and consumption on the Grantex auth service.

    A platform creates decision requests and consumes decision grants with its
    API key. It cannot approve: a person approves on the auth service's
    approval page (``approvalPage`` in the request) after signing in with an
    identity provider the service administrator allow-listed. The auth service
    must run with ``DECISION_GRANTS_ENABLED=true``.

    When the auth service binds decision grants to the requesting agent
    (``DECISION_GRANT_AGENT_BINDING=true``), the API key alone never receives a
    decision grant: a request that names an agent (``agent_id``, ``grant_id``)
    releases its grants only to that agent's grant token (:meth:`get_grants`),
    and they are consumed only for that agent and grant. A request that names
    none is the platform's own and is consumed by its id
    (:meth:`consume_request`). :meth:`get_grants` and :meth:`consume_request`
    work whether or not the binding is on.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

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
        memo: str,
        policy_score: Mapping[str, Any],
        four_eyes_on: Optional[Sequence[str]] = None,
        approvals_required: Optional[int] = None,
        expires_in_seconds: Optional[int] = None,
        memo_ref: Optional[str] = None,
        policy_score_ref: Optional[str] = None,
        agent_id: Optional[str] = None,
        grant_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ask a person to decide one semantic action. Idempotent while the request is open.

        ``memo`` (text) and ``policy_score`` (a JSON object) are what the
        approver reviews; the auth service stores them with their hashes and
        binds the hashes into the decision grant. The response carries
        ``approvalPage``, the link to send the approver to.

        ``agent_id`` (the agent's Grantex agent id, ``ag_...``) and
        ``grant_id`` name the agent the decision is for: with the binding on,
        only that agent's grant token can fetch the grants, and they are
        consumed only for that agent and grant.
        """
        body: Dict[str, Any] = {
            "action": _action_dict(action),
            "connector": connector,
            "caseVersion": case_version,
            "memo": {"content": memo, **({"ref": memo_ref} if memo_ref is not None else {})},
            "policyScore": {"content": dict(policy_score), **({"ref": policy_score_ref} if policy_score_ref is not None else {})},
        }
        optional = {
            "fourEyesOn": list(four_eyes_on) if four_eyes_on is not None else None,
            "approvalsRequired": approvals_required,
            "expiresInSeconds": expires_in_seconds,
            "agentId": agent_id,
            "grantId": grant_id,
        }
        body.update({k: v for k, v in optional.items() if v is not None})
        data: Dict[str, Any] = self._http.post("/v1/decisions/requests", body)
        return data

    def get_request(self, request_id: str) -> Dict[str, Any]:
        """Status and approvals (by ``jti``).

        With the binding on, also ``decisionGrantsReady`` and never the
        decision grants themselves: use :meth:`get_grants` with the requesting
        agent's grant token. With it off, also ``decisionGrants`` once fully
        approved and still usable.
        """
        data: Dict[str, Any] = self._http.get(f"/v1/decisions/requests/{quote(request_id, safe='')}")
        return data

    def get_grants(self, request_id: str, grant_token: str) -> Dict[str, Any]:
        """The request with ``decisionGrantsReady``, plus ``decisionGrants``
        once fully approved and still usable.

        Released only for a request that names an agent, and only against a
        live grant token of that agent and grant: anything else is refused with
        ``wrong_agent``. Every hand-out and refusal is recorded in the audit
        chain.
        """
        data: Dict[str, Any] = self._http.post(
            f"/v1/decisions/requests/{quote(request_id, safe='')}/grants", {"grantToken": grant_token}
        )
        return data

    def cancel_request(self, request_id: str) -> Dict[str, Any]:
        data: Dict[str, Any] = self._http.post(f"/v1/decisions/requests/{quote(request_id, safe='')}/cancel")
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
        agent_did: Optional[str] = None,
    ) -> ConsumedDecision:
        """Consume decision grants atomically at the auth service.

        Pass a :class:`DecisionGrantSet` from :func:`verify_decision_grants`, or
        the tokens with the action and case version. Raises
        :class:`DecisionGrantError` with the issuer's sub-reason when refused,
        and ``consume_unavailable`` when the issuer cannot be reached or answers
        unexpectedly: an unconfirmed consumption is never treated as success.

        ``agent_did`` is the DID of the agent the call is made for, from its
        verified grant token (what ``enforce()`` passes). It is sent as
        ``agentDid``, which an auth service that does not bind decision grants
        to the requesting agent ignores, so it is safe to send to any version.
        ``agent_id`` is the agent's Grantex agent id (``ag_...``), sent as
        ``agentId``; ``grant_id`` the grant the call is made under.

        Consumption spends the grants. If the response is lost after the auth
        service consumed them, or the tool call fails afterwards, they stay
        spent and a person has to approve again.
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
        if agent_did is not None:
            body["agentDid"] = agent_did
        if grant_id is not None:
            body["grantId"] = grant_id
        data = self._consume("/v1/decisions/consume", body)
        if sorted(data["jtis"]) != sorted(_jtis_of(grants)):
            raise DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, "the auth service consumed different decision grants")
        return _receipt(data)

    def consume_request(
        self,
        request_id: str,
        action: Union[DecisionAction, Mapping[str, Any]],
        case_version: str,
    ) -> ConsumedDecision:
        """Consume the grants of a decision request that names no agent, by its id.

        The platform that asked for the decision spends it without ever
        holding the tokens. A request that names an agent is refused
        (``wrong_agent``): its grants are consumed only as that agent presents
        them. Errors and the no-retry rule are as for :meth:`consume`.
        """
        data = self._consume(
            f"/v1/decisions/requests/{quote(request_id, safe='')}/consume",
            {"action": _action_dict(action), "caseVersion": case_version},
        )
        if data.get("requestId") != request_id or len(data["jtis"]) == 0:
            raise DecisionGrantError(DecisionSubReason.CONSUME_UNAVAILABLE, "the auth service consumed another decision")
        return _receipt(data)

    def _consume(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """POSTs a consumption once; anything but a confirmed one raises ``DecisionGrantError``."""
        try:
            data = self._http.post(path, body, retry=False)
        except GrantexApiError as exc:
            payload = exc.body if isinstance(exc.body, dict) else {}
            sub_reason = payload.get("subReason")
            if exc.status_code in (400, 403, 404, 409, 410) and isinstance(sub_reason, str) and sub_reason in _KNOWN_SUB_REASONS:
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
        return data


def _receipt(data: Dict[str, Any]) -> ConsumedDecision:
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


def _takes_agent_did(consumer: object) -> bool:
    """Whether ``consumer.consume`` accepts ``agent_did``, by name or ``**kwargs``.

    A :class:`DecisionConsumer` written before ``agent_did`` existed does not:
    passing it would raise ``TypeError`` and deny every decision call, so
    ``enforce()`` calls such a consumer as it did before (``grant_id`` only).
    """
    try:
        parameters = inspect.signature(getattr(consumer, "consume")).parameters
    except (AttributeError, TypeError, ValueError):
        return False
    return any(
        p.kind is inspect.Parameter.VAR_KEYWORD
        or (p.name == "agent_did" and p.kind in (inspect.Parameter.KEYWORD_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD))
        for p in parameters.values()
    )


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
        agent_did: Optional[str] = None,
    ) -> ConsumedDecision:
        return self._client.consume(grants, agent_id=agent_id, grant_id=grant_id, agent_did=agent_did)

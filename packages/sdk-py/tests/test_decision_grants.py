"""Decision grants in the Python SDK (PRD G-3): offline verification, four
eyes, atomic consumption at the issuer and ``enforce()`` integration.

Verification cases in spec/examples/decision-grant/verification.json are
shared with the TypeScript SDK.
"""

from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Set
from unittest.mock import MagicMock, patch

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import rsa

from grantex import DenialReason, Grantex, ToolManifest
from grantex._types import VerifiedGrant
from grantex.caps import CapsMeter, InMemoryCapsBackend
from grantex.decisions import (
    ConsumedDecision,
    DecisionAction,
    DecisionGrantError,
    DecisionGrantSet,
    verify_decision_grant,
    verify_decision_grants,
)
from grantex.denials import DecisionSubReason

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "decision-grant" / "verification.json").read_text(encoding="utf-8")
)
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ISSUER = FIXTURE["issuer"]
NOW = FIXTURE["now"]
ACTION = FIXTURE["action"]


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign(claims: Dict[str, Any], header: Optional[Dict[str, Any]] = None, key: Any = KEY) -> str:
    headers = {"typ": "decision+jwt", "kid": "test-key", "alg": "RS256", **(header or {})}
    for name in [k for k, v in headers.items() if v is None]:
        del headers[name]
    token = jwt.encode(claims, key, algorithm="RS256", headers={"typ": "decision+jwt", "kid": "test-key"})
    # Replace the protected header as written (the signature no longer matches
    # a changed header, which the verifier must refuse before or at signature).
    _head, payload, signature = token.split(".")
    return ".".join([_b64(json.dumps(headers).encode()), payload, signature]) if header else token


def build_grant(spec: Dict[str, Any]) -> str:
    claims = copy.deepcopy(FIXTURE["base_claims"])
    claims.update(copy.deepcopy(spec.get("claims", {})))
    for key in spec.get("remove", []):
        claims.pop(key, None)
    token = sign(claims, spec.get("header"))
    if "tamper" in spec:
        head, _payload, signature = token.split(".")
        claims.update(spec["tamper"])
        token = ".".join([head, _b64(json.dumps(claims).encode()), signature])
    return token


def resolver(_header: Any) -> Any:
    return KEY.public_key()


# ── Shared verification cases ────────────────────────────────────────────


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_shared_verification_cases(case: Dict[str, Any]) -> None:
    tokens = [build_grant(g) for g in case["grants"]]
    expected = {**ACTION, **case.get("expected_action", {})}
    try:
        result = verify_decision_grants(
            tokens, expected, case.get("case_version", FIXTURE["base_claims"]["case_version"]),
            issuer=ISSUER, key_resolver=resolver, developer_id=FIXTURE["developer_id"],
            connector=FIXTURE["connector"], approvals_required=case.get("approvals_required", 1),
            now=case.get("now", NOW),
        )
    except DecisionGrantError as exc:
        assert exc.sub_reason == case["expect"], str(exc)
        return
    assert case["expect"] == "valid"
    assert len(result.grants) == len(tokens)
    assert result.action_hash == DecisionAction.from_dict(expected).action_hash()
    if len(result.grants) == 2:
        assert [g.four_eyes.position for g in result.grants if g.four_eyes] == [1, 2]


def test_signature_by_another_key_is_malformed() -> None:
    token = sign(FIXTURE["base_claims"], key=OTHER_KEY)
    with pytest.raises(DecisionGrantError) as info:
        verify_decision_grant(token, ACTION, "v7", issuer=ISSUER, key_resolver=resolver, now=NOW)
    assert info.value.sub_reason == DecisionSubReason.MALFORMED


def test_none_algorithm_and_hmac_are_refused() -> None:
    claims = FIXTURE["base_claims"]
    unsigned = jwt.encode(claims, None, algorithm="none", headers={"typ": "decision+jwt"})  # type: ignore[arg-type]
    hmac = jwt.encode(claims, "x" * 32, algorithm="HS256", headers={"typ": "decision+jwt"})
    for token in (unsigned, hmac):
        with pytest.raises(DecisionGrantError) as info:
            verify_decision_grant(token, ACTION, "v7", issuer=ISSUER, key_resolver=resolver, now=NOW)
        assert info.value.sub_reason == DecisionSubReason.MALFORMED


def test_verified_grant_exposes_the_approval_record() -> None:
    grant = verify_decision_grant(build_grant({}), ACTION, "v7", issuer=ISSUER, key_resolver=resolver, now=NOW)
    assert (grant.sub, grant.approver_auth, grant.amr, grant.dwell_ms, grant.dwell_source) == (
        FIXTURE["base_claims"]["sub"], "sso+hwk+pwd", ("hwk", "pwd"), 61250, "server"
    )
    assert grant.memo_hash == FIXTURE["base_claims"]["memo_hash"]
    assert grant.action == DecisionAction.from_dict(ACTION)


# ── enforce() ────────────────────────────────────────────────────────────

MANIFEST = ToolManifest.from_dict({
    "connector": "acme_kyb",
    "tools": {
        "case_decision": {"permission": "write", "requires_decision": True, "four_eyes_on": ["decline"]},
        "payout_release": {"permission": "write", "requires_decision": True, "caps": {"per_hour": 5}},
        "payout_currency": {"permission": "write", "requires_decision": True, "decision_fields": ["currency"]},
        "get_case": "read",
    },
})


class FakeIssuer:
    """Consumes each jti once, like the auth service."""

    def __init__(self, fail_with: Optional[str] = None) -> None:
        self.consumed: Set[str] = set()
        self.calls: List[DecisionGrantSet] = []
        self.fail_with = fail_with

    def consume(self, grants: DecisionGrantSet, *, agent_id: Optional[str] = None, grant_id: Optional[str] = None) -> ConsumedDecision:
        self.calls.append(grants)
        if self.fail_with is not None:
            raise DecisionGrantError(self.fail_with, "refused by the issuer")
        if any(j in self.consumed for j in grants.jtis):
            raise DecisionGrantError(DecisionSubReason.CONSUMED, "already used")
        self.consumed.update(grants.jtis)
        return ConsumedDecision(request_id=grants.grants[0].decision_request, jtis=grants.jtis, action_hash=grants.action_hash, approvers=())


@pytest.fixture()
def verify_grant() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        mock.return_value = VerifiedGrant(
            token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
            developer_id="dev_01", scopes=("tool:acme_kyb:write",), issued_at=1, expires_at=9999999999,
        )
        with patch("grantex.decisions._verify._default_key_resolver", return_value=resolver), \
                patch("grantex.decisions._verify.time.time", return_value=NOW):
            yield mock


def client(issuer: Optional[FakeIssuer] = None, **options: Any) -> Grantex:
    c = Grantex(api_key="test-key", decision_consumer=issuer or FakeIssuer(), **options)
    c.load_manifest(MANIFEST)
    return c


def call_args(**overrides: Any) -> Dict[str, Any]:
    return {"case_id": "case_8841", "decision": "approve", "subject": "gb:00000001", "note": "re-planned", **overrides}


def test_enforce_returns_decision_required_without_a_decision_grant(verify_grant: MagicMock) -> None:
    result = client().enforce("t", "acme_kyb", "case_decision", arguments=call_args(), case_version="v7")
    assert (result.allowed, result.reason_code, result.sub_reason) == (False, DenialReason.DECISION_REQUIRED, "")
    assert result.details == {"decision_required": "acme_kyb:case_decision"}


def test_valid_decision_grant_is_consumed_and_allows_the_call(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer()
    result = client(issuer).enforce(
        "t", "acme_kyb", "case_decision", decision_grants=[build_grant({})],
        arguments=call_args(requested_at="2026-09-15T10:04:31Z"), case_version="v7",
    )
    assert result.allowed, result.reason
    assert result.decision is not None and result.decision.jtis == (FIXTURE["base_claims"]["jti"],)
    assert len(issuer.calls) == 1


def test_replay_of_a_consumed_jti_is_denied(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer()
    c = client(issuer)
    token = build_grant({})
    assert c.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], arguments=call_args(), case_version="v7").allowed
    replay = c.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], arguments=call_args(), case_version="v7")
    assert (replay.allowed, replay.reason_code, replay.sub_reason) == (False, DenialReason.DECISION_INVALID, DecisionSubReason.CONSUMED)


def test_offline_verification_alone_never_allows_a_call(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer(fail_with=DecisionSubReason.CONSUME_UNAVAILABLE)
    result = client(issuer).enforce("t", "acme_kyb", "case_decision", decision_grants=[build_grant({})], arguments=call_args(), case_version="v7")
    assert (result.allowed, result.sub_reason) == (False, DecisionSubReason.CONSUME_UNAVAILABLE)


@pytest.mark.parametrize(
    ("arguments", "case_version", "sub_reason"),
    [
        (call_args(decision="decline"), "v7", DecisionSubReason.ACTION_MISMATCH),
        (call_args(subject="gb:00000002"), "v7", DecisionSubReason.ACTION_MISMATCH),
        (call_args(case_id="case_8842"), "v7", DecisionSubReason.WRONG_CASE),
        (call_args(), "v8", DecisionSubReason.CASE_CHANGED),
        (call_args(amount=10), "v7", DecisionSubReason.ACTION_MISMATCH),
    ],
)
def test_enforce_returns_decision_invalid_with_sub_reason(verify_grant: MagicMock, arguments: Dict[str, Any], case_version: str, sub_reason: str) -> None:
    issuer = FakeIssuer()
    result = client(issuer).enforce("t", "acme_kyb", "case_decision", decision_grants=[build_grant({})], arguments=arguments, case_version=case_version)
    assert (result.allowed, result.reason_code, result.sub_reason) == (False, DenialReason.DECISION_INVALID, sub_reason)
    assert issuer.calls == []


def test_enforce_needs_the_action_and_case_version(verify_grant: MagicMock) -> None:
    c = client()
    token = build_grant({})
    assert c.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], case_version="v7").sub_reason == DecisionSubReason.MALFORMED
    assert c.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], arguments=call_args()).sub_reason == DecisionSubReason.MALFORMED
    other_tool = {**ACTION, "action": "monitor_delete"}
    assert c.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], decision_action=other_tool, case_version="v7").sub_reason == DecisionSubReason.ACTION_MISMATCH


def test_four_eyes_same_approver_twice_is_denied(verify_grant: MagicMock) -> None:
    cases = {c["name"]: c for c in FIXTURE["cases"]}
    same = cases["four eyes with the same approver twice"]
    tokens = [build_grant(g) for g in same["grants"]]
    result = client().enforce("t", "acme_kyb", "case_decision", decision_grants=tokens, arguments=call_args(decision="decline"), case_version="v7")
    assert (result.allowed, result.sub_reason) == (False, DecisionSubReason.SAME_APPROVER)

    one = cases["four eyes with one grant"]
    incomplete = client().enforce("t", "acme_kyb", "case_decision", decision_grants=[build_grant(g) for g in one["grants"]], arguments=call_args(decision="decline"), case_version="v7")
    assert (incomplete.allowed, incomplete.sub_reason) == (False, DecisionSubReason.FOUR_EYES_INCOMPLETE)

    both = cases["four eyes with two approvers"]
    issuer = FakeIssuer()
    ok = client(issuer).enforce("t", "acme_kyb", "case_decision", decision_grants=[build_grant(g) for g in both["grants"]], arguments=call_args(decision="decline"), case_version="v7")
    assert ok.allowed, ok.reason
    assert len(issuer.consumed) == 2


def test_decisions_warn_mode_allows_and_reports(verify_grant: MagicMock) -> None:
    c = client(decisions_mode="warn")
    absent = c.enforce("t", "acme_kyb", "case_decision", arguments=call_args(), case_version="v7")
    assert absent.allowed
    assert absent.would_deny is not None and absent.would_deny["reason_code"] == DenialReason.DECISION_REQUIRED

    issuer = FakeIssuer()
    warn = client(issuer)
    token = build_grant({})
    first = warn.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], arguments=call_args(), case_version="v7", decisions_mode="warn")
    assert first.allowed and first.would_deny is None and first.decision is not None
    second = warn.enforce("t", "acme_kyb", "case_decision", decision_grants=[token], arguments=call_args(), case_version="v7", decisions_mode="warn")
    assert second.allowed and second.would_deny is not None and second.would_deny["sub_reason"] == DecisionSubReason.CONSUMED
    with pytest.raises(ValueError):
        client(decisions_mode="off")


def test_caps_reservation_is_released_when_consumption_fails(verify_grant: MagicMock) -> None:
    meter = CapsMeter(InMemoryCapsBackend())
    payout = {**ACTION, "action": "payout_release"}
    claims = {"action": payout, "action_hash": DecisionAction.from_dict(payout).action_hash()}
    token = build_grant({"claims": claims})
    denied = client(FakeIssuer(fail_with=DecisionSubReason.CONSUMED), caps_meter=meter).enforce(
        "t", "acme_kyb", "payout_release", decision_grants=[token], decision_action=payout, case_version="v7",
    )
    assert (denied.allowed, denied.sub_reason) == (False, DecisionSubReason.CONSUMED)
    usage = meter.usage("dev_01", [limit for limit in client(caps_meter=meter).enforce(
        "t", "acme_kyb", "payout_release", decision_action=payout, case_version="v7", reserve=False, decisions_mode="warn",
    ).cap_limits])
    assert all(u.used == 0 for u in usage)


def test_decision_check_does_not_apply_to_tools_without_requires_decision(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer()
    result = client(issuer).enforce("t", "acme_kyb", "get_case", decision_grants=[build_grant({})])
    assert result.allowed and result.decision is None and issuer.calls == []


def test_a_tool_the_grant_references_needs_a_decision_grant_and_four_eyes(verify_grant: MagicMock) -> None:
    # The manifest does not declare requires_decision; the grant's decision
    # reference does, with four eyes on decline.
    manifest = ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"case_decision": "write"}})
    verify_grant.return_value = VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
        developer_id="dev_01", scopes=("tool:acme_kyb:write",), issued_at=1, expires_at=9999999999,
        authorization_details=[{
            "type": "urn:grantex:decision:v1", "connector": "acme_kyb",
            "tools": ["case_decision"], "four_eyes_on": {"case_decision": ["decline"]},
        }],
    )
    issuer = FakeIssuer()
    c = Grantex(api_key="test-key", decision_consumer=issuer)
    c.load_manifest(manifest)

    absent = c.enforce("t", "acme_kyb", "case_decision", arguments=call_args(), case_version="v7")
    assert (absent.allowed, absent.reason_code) == (False, DenialReason.DECISION_REQUIRED)

    approved = c.enforce("t", "acme_kyb", "case_decision", decision_grants=[build_grant({})], arguments=call_args(), case_version="v7")
    assert approved.allowed, approved.reason

    decline = {**ACTION, "decision": "decline"}
    single_decline = build_grant({
        "claims": {"action": decline, "action_hash": DecisionAction.from_dict(decline).action_hash(), "jti": "dgnt_01K00000000000000000000009"},
        "remove": ["four_eyes"],
    })
    one = c.enforce("t", "acme_kyb", "case_decision", decision_grants=[single_decline], arguments=call_args(decision="decline"), case_version="v7")
    assert (one.allowed, one.sub_reason) == (False, DecisionSubReason.FOUR_EYES_INCOMPLETE)
    assert len(issuer.calls) == 1


# ── DecisionsClient over HTTP ────────────────────────────────────────────

BASE = "https://api.grantex.dev"


def _set(tokens: Sequence[str]) -> DecisionGrantSet:
    return verify_decision_grants(tokens, ACTION, "v7", issuer=ISSUER, key_resolver=resolver, now=NOW)


@respx.mock
def test_consume_posts_tokens_action_and_case_version() -> None:
    route = respx.post(f"{BASE}/v1/decisions/consume").mock(return_value=httpx.Response(200, json={
        "consumed": True, "requestId": "dreq_1", "jtis": [FIXTURE["base_claims"]["jti"]], "actionHash": "sha256:x",
        "approvers": [{"sub": "user:approver-a", "approver_auth": "sso+hwk+pwd", "dwell_ms": 61250}],
    }))
    grants = _set([build_grant({})])
    receipt = Grantex(api_key="test-key").decisions.consume(grants, grant_id="grnt_01")
    body = json.loads(route.calls[0].request.content)
    assert body == {"decisionGrants": list(grants.tokens), "action": ACTION, "caseVersion": "v7", "grantId": "grnt_01"}
    assert receipt.jtis == (FIXTURE["base_claims"]["jti"],)
    assert route.call_count == 1


@respx.mock
@pytest.mark.parametrize(
    ("response", "sub_reason"),
    [
        (httpx.Response(409, json={"code": "DECISION_INVALID", "subReason": "consumed", "message": "used"}), "consumed"),
        (httpx.Response(409, json={"code": "DECISION_INVALID", "subReason": "case_changed", "message": "changed"}), "case_changed"),
        (httpx.Response(409, json={"code": "DECISION_INVALID", "subReason": "made_up", "message": "?"}), "consume_unavailable"),
        (httpx.Response(503, json={"message": "down"}), "consume_unavailable"),
        (httpx.Response(404, json={"code": "DECISION_GRANTS_DISABLED"}), "consume_unavailable"),
        (httpx.Response(200, json={"consumed": True, "jtis": ["dgnt_other"]}), "consume_unavailable"),
        (httpx.Response(200, json={"consumed": False}), "consume_unavailable"),
    ],
)
def test_consume_maps_refusals_and_never_assumes_success(response: httpx.Response, sub_reason: str) -> None:
    route = respx.post(f"{BASE}/v1/decisions/consume").mock(return_value=response)
    with pytest.raises(DecisionGrantError) as info:
        Grantex(api_key="test-key").decisions.consume(_set([build_grant({})]))
    assert info.value.sub_reason == sub_reason
    assert route.call_count == 1  # never retried


@respx.mock
def test_consume_network_failure_is_unavailable() -> None:
    respx.post(f"{BASE}/v1/decisions/consume").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(DecisionGrantError) as info:
        Grantex(api_key="test-key", max_retries=0).decisions.consume(_set([build_grant({})]))
    assert info.value.sub_reason == DecisionSubReason.CONSUME_UNAVAILABLE


@respx.mock
def test_platform_calls_send_the_documented_bodies() -> None:
    requests = respx.post(f"{BASE}/v1/decisions/requests").mock(return_value=httpx.Response(201, json={"requestId": "dreq_1"}))
    cases = respx.put(f"{BASE}/v1/decisions/cases/case_8841").mock(return_value=httpx.Response(200, json={"caseVersion": "v8"}))
    c = Grantex(api_key="test-key").decisions
    c.create_request(
        ACTION, connector="acme_kyb", case_version="v7", four_eyes_on=["decline"],
        memo="Registry active.", memo_ref="memo:1", policy_score={"tier": "low"},
    )
    c.set_case_version("case_8841", "v8")
    assert json.loads(requests.calls[0].request.content) == {
        "action": ACTION, "connector": "acme_kyb", "caseVersion": "v7", "fourEyesOn": ["decline"],
        "memo": {"content": "Registry active.", "ref": "memo:1"}, "policyScore": {"content": {"tier": "low"}},
    }
    assert json.loads(cases.calls[0].request.content) == {"caseVersion": "v8"}


def test_the_client_cannot_approve() -> None:
    c = Grantex(api_key="test-key").decisions
    for name in ("approve", "create_approver_session", "create_page_ticket"):
        assert not hasattr(c, name)


def test_decision_action_and_arguments_must_describe_the_same_action(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer()
    token = build_grant({})
    mismatch = client(issuer).enforce(
        "t", "acme_kyb", "case_decision", decision_grants=[token],
        decision_action=ACTION, arguments=call_args(decision="decline"), case_version="v7",
    )
    assert (mismatch.allowed, mismatch.sub_reason) == (False, DecisionSubReason.ACTION_MISMATCH)
    assert issuer.calls == []
    same = client(issuer).enforce(
        "t", "acme_kyb", "case_decision", decision_grants=[token],
        decision_action=ACTION, arguments=call_args(), case_version="v7",
    )
    assert same.allowed, same.reason


class ExplodingIssuer:
    def consume(self, grants: DecisionGrantSet, *, agent_id: Optional[str] = None, grant_id: Optional[str] = None) -> ConsumedDecision:
        raise RuntimeError("socket closed")


def test_any_consumer_failure_denies_and_refunds_caps(verify_grant: MagicMock) -> None:
    meter = CapsMeter(InMemoryCapsBackend())
    payout = {**ACTION, "action": "payout_release"}
    token = build_grant({"claims": {"action": payout, "action_hash": DecisionAction.from_dict(payout).action_hash()}})
    c = Grantex(api_key="test-key", decision_consumer=ExplodingIssuer(), caps_meter=meter)  # type: ignore[arg-type]
    c.load_manifest(MANIFEST)
    denied = c.enforce("t", "acme_kyb", "payout_release", decision_grants=[token], decision_action=payout, case_version="v7")
    assert (denied.allowed, denied.reason_code, denied.sub_reason) == (False, DenialReason.DECISION_INVALID, DecisionSubReason.CONSUME_UNAVAILABLE)
    probe = client(caps_meter=meter).enforce(
        "t", "acme_kyb", "payout_release", decision_action=payout, case_version="v7", reserve=False, decisions_mode="warn",
    )
    assert all(u.used == 0 for u in meter.usage("dev_01", list(probe.cap_limits)))


def test_declared_decision_fields_are_bound(verify_grant: MagicMock) -> None:
    payout = {**ACTION, "action": "payout_currency", "extra": {"currency": "GBP"}}
    token = build_grant({"claims": {"action": payout, "action_hash": DecisionAction.from_dict(payout).action_hash()}})
    issuer = FakeIssuer()
    ok = client(issuer).enforce("t", "acme_kyb", "payout_currency", decision_grants=[token], arguments=call_args(currency="GBP"), case_version="v7")
    assert ok.allowed, ok.reason
    other = client(FakeIssuer()).enforce("t", "acme_kyb", "payout_currency", decision_grants=[token], arguments=call_args(currency="EUR"), case_version="v7")
    assert (other.allowed, other.sub_reason) == (False, DecisionSubReason.ACTION_MISMATCH)
    missing = client(FakeIssuer()).enforce("t", "acme_kyb", "payout_currency", decision_grants=[token], arguments=call_args(), case_version="v7")
    assert (missing.allowed, missing.sub_reason) == (False, DecisionSubReason.MALFORMED)
    unbound = client(FakeIssuer()).enforce("t", "acme_kyb", "payout_currency", decision_grants=[token], decision_action={**ACTION, "action": "payout_currency"}, case_version="v7")
    assert (unbound.allowed, unbound.sub_reason) == (False, DecisionSubReason.MALFORMED)


def test_wrap_tool_carries_decision_grants(verify_grant: MagicMock) -> None:
    issuer = FakeIssuer()
    c = client(issuer)
    calls: List[Dict[str, Any]] = []

    class Tool:
        def _run(self, **kwargs: Any) -> str:
            calls.append(kwargs)
            return "done"

    token = build_grant({})
    tool = c.wrap_tool(Tool(), connector="acme_kyb", tool_name="case_decision", grant_token="t",
                       decision_grants=lambda: [token], case_version=lambda: "v7")
    assert tool._run(**call_args()) == "done"
    with pytest.raises(PermissionError):
        tool._run(**call_args())  # the grant was consumed by the first call
    bare = c.wrap_tool(Tool(), connector="acme_kyb", tool_name="case_decision", grant_token="t")
    with pytest.raises(PermissionError):
        bare._run(**call_args())
    assert len(calls) == 1


class _FakeRequest:
    """The parts of a Starlette request the FastAPI enforcer reads."""

    def __init__(self, headers: Dict[str, str], body: Any) -> None:
        self.headers = {k.lower(): v for k, v in headers.items()}
        self._body = body

    async def json(self) -> Any:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _denial(exc: BaseException) -> Dict[str, Any]:
    detail = getattr(exc, "detail", None)
    return detail if isinstance(detail, dict) else {"message": str(exc)}


def test_fastapi_enforcer_carries_decision_grants(verify_grant: MagicMock) -> None:
    import asyncio

    from grantex.fastapi import GrantexEnforcer

    issuer = FakeIssuer()
    versions: List[Optional[Mapping[str, Any]]] = []

    async def case_version(_request: Any, arguments: Optional[Mapping[str, Any]]) -> str:
        versions.append(arguments)
        return "v7"

    enforcer = GrantexEnforcer(client(issuer), case_version=case_version)
    token = build_grant({})

    def call(request: _FakeRequest) -> Any:
        return asyncio.run(enforcer(connector="acme_kyb", tool="case_decision", authorization="Bearer t", request=request))

    result = call(_FakeRequest({"Grantex-Decision-Grant": token}, call_args()))
    assert result.allowed and result.decision is not None
    assert versions == [call_args()] and len(issuer.calls) == 1

    with pytest.raises(Exception) as replay:
        call(_FakeRequest({"Grantex-Decision-Grant": token}, call_args()))
    assert "already used" in str(_denial(replay.value).get("message"))

    with pytest.raises(Exception) as absent:
        call(_FakeRequest({}, call_args()))
    assert "requires a decision grant" in str(_denial(absent.value).get("message"))

    other = build_grant({"claims": {"jti": "dgnt_01K00000000000000000000008"}})
    with pytest.raises(Exception) as mismatch:
        call(_FakeRequest({"Grantex-Decision-Grant": other}, call_args(decision="decline")))
    assert "not valid" in str(_denial(mismatch.value).get("message"))

    with pytest.raises(Exception) as not_json:
        call(_FakeRequest({"Grantex-Decision-Grant": other}, ValueError("not JSON")))
    assert "not valid" in str(_denial(not_json.value).get("message"))
    # Only the first call and the replay (refused by the issuer) reached consumption.
    assert len(issuer.calls) == 2


def test_fastapi_enforcer_without_case_version_refuses_decision_tools(verify_grant: MagicMock) -> None:
    import asyncio

    from grantex.fastapi import GrantexEnforcer

    issuer = FakeIssuer()
    enforcer = GrantexEnforcer(client(issuer))
    request = _FakeRequest({"Grantex-Decision-Grant": build_grant({})}, call_args())
    with pytest.raises(Exception) as refused:
        asyncio.run(enforcer(connector="acme_kyb", tool="case_decision", authorization="Bearer t", request=request))
    assert "not valid" in str(_denial(refused.value).get("message"))
    assert issuer.calls == []
    allowed = asyncio.run(enforcer(connector="acme_kyb", tool="get_case", authorization="Bearer t", request=request))
    assert allowed.allowed and issuer.calls == []


def test_fastapi_route_with_decision_grants(verify_grant: MagicMock) -> None:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from grantex.manifest import EnforceResult as _EnforceResult
    from grantex.fastapi import GrantexEnforcer

    issuer = FakeIssuer()
    enforcer = GrantexEnforcer(client(issuer), case_version=lambda _request, _arguments: "v7")
    app = fastapi.FastAPI()
    ran: List[Dict[str, Any]] = []

    @app.post("/api/tools/{connector}/{tool}")
    async def execute_tool(connector: str, tool: str, body: Dict[str, Any], auth: _EnforceResult = fastapi.Depends(enforcer)) -> Dict[str, Any]:
        ran.append(body)
        return {"allowed": auth.allowed}

    http = TestClient(app)
    token = build_grant({})
    headers = {"Authorization": "Bearer t", "Grantex-Decision-Grant": token}
    ok = http.post("/api/tools/acme_kyb/case_decision", headers=headers, json=call_args())
    assert ok.status_code == 200, ok.text
    replay = http.post("/api/tools/acme_kyb/case_decision", headers=headers, json=call_args())
    assert replay.status_code == 403
    assert replay.json()["detail"]["reason_code"] == DenialReason.DECISION_INVALID
    assert replay.json()["detail"]["sub_reason"] == DecisionSubReason.CONSUMED
    absent = http.post("/api/tools/acme_kyb/case_decision", headers={"Authorization": "Bearer t"}, json=call_args())
    assert absent.status_code == 403 and absent.json()["detail"]["reason_code"] == DenialReason.DECISION_REQUIRED
    assert ran == [call_args()]


@respx.mock
def test_default_key_resolver_supports_es256_and_rotated_kids() -> None:
    from cryptography.hazmat.primitives.asymmetric import ec
    from jwt.algorithms import ECAlgorithm

    from grantex._verify import clear_jwks_cache

    clear_jwks_cache()
    ec_key = ec.generate_private_key(ec.SECP256R1())
    ec_jwk = json.loads(ECAlgorithm.to_jwk(ec_key.public_key()))
    ec_jwk.update({"kid": "ec-1", "alg": "ES256"})
    jwks = respx.get("https://auth.example.com/.well-known/jwks.json").mock(return_value=httpx.Response(200, json={"keys": [ec_jwk]}))
    claims = {**FIXTURE["base_claims"], "iss": "https://auth.example.com"}
    token = jwt.encode(claims, ec_key, algorithm="ES256", headers={"typ": "decision+jwt", "kid": "ec-1"})
    grant = verify_decision_grant(token, ACTION, "v7", issuer="https://auth.example.com", jwks_uri="https://auth.example.com/.well-known/jwks.json", now=NOW)
    assert grant.jti == FIXTURE["base_claims"]["jti"]
    with pytest.raises(DecisionGrantError) as info:
        verify_decision_grant(token, ACTION, "v7", issuer="https://auth.example.com", jwks_uri="https://auth.example.com/.well-known/jwks.json", now=NOW, algorithms=("RS256",))
    assert info.value.sub_reason == DecisionSubReason.MALFORMED
    rsa_labelled = jwt.encode(claims, KEY, algorithm="RS256", headers={"typ": "decision+jwt", "kid": "ec-1"})
    with pytest.raises(DecisionGrantError):
        verify_decision_grant(rsa_labelled, ACTION, "v7", issuer="https://auth.example.com", jwks_uri="https://auth.example.com/.well-known/jwks.json", now=NOW)
    assert jwks.call_count >= 1
    clear_jwks_cache()

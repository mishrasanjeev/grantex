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
from typing import Any, Dict, Iterator, List, Optional, Sequence, Set
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
    headers = {"typ": "decision+jwt", "kid": "test-key", **(header or {})}
    return jwt.encode(claims, key, algorithm="RS256", headers=headers)


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
    assert (grant.sub, grant.approver_auth, grant.amr, grant.dwell_ms) == ("user:approver-a", "sso+hwk+pwd", ("hwk", "pwd"), 61250)
    assert grant.action == DecisionAction.from_dict(ACTION)


# ── enforce() ────────────────────────────────────────────────────────────

MANIFEST = ToolManifest.from_dict({
    "connector": "acme_kyb",
    "tools": {
        "case_decision": {"permission": "write", "requires_decision": True, "four_eyes_on": ["decline"]},
        "payout_release": {"permission": "write", "requires_decision": True, "caps": {"per_hour": 5}},
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
    approvals = respx.post(f"{BASE}/v1/decisions/requests/dreq_1/approvals").mock(return_value=httpx.Response(201, json={"decisionGrant": "x"}))
    sessions = respx.post(f"{BASE}/v1/decisions/approver-sessions").mock(return_value=httpx.Response(201, json={"sessionToken": "s"}))
    cases = respx.put(f"{BASE}/v1/decisions/cases/case_8841").mock(return_value=httpx.Response(200, json={"caseVersion": "v8"}))
    c = Grantex(api_key="test-key").decisions
    c.create_request(ACTION, connector="acme_kyb", case_version="v7", four_eyes_on=["decline"], memo_ref="memo:1")
    c.create_approver_session("sso_1", "id-token")
    c.approve("dreq_1", approver_session="s", action_hash="sha256:x", dwell_ms=61250)
    c.set_case_version("case_8841", "v8")
    assert json.loads(requests.calls[0].request.content) == {
        "action": ACTION, "connector": "acme_kyb", "caseVersion": "v7", "fourEyesOn": ["decline"], "memoRef": "memo:1",
    }
    assert approvals.calls[0].request.headers["Grantex-Approver-Session"] == "s"
    assert json.loads(approvals.calls[0].request.content) == {"actionHash": "sha256:x", "dwellMs": 61250}
    assert json.loads(sessions.calls[0].request.content) == {"connectionId": "sso_1", "idToken": "id-token"}
    assert json.loads(cases.calls[0].request.content) == {"caseVersion": "v8"}

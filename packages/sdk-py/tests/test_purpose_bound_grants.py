"""Purpose-bound grants (PRD G-2): vocabulary, matching and enforce().

Acceptance-criteria tests are named after the criteria. Matching cases in
spec/examples/purpose-matching.json are shared with the TypeScript SDK.
"""
from __future__ import annotations

import json
import random
import string
from pathlib import Path
from typing import Any, Dict, Iterator, Optional
from unittest.mock import MagicMock, patch

import pytest

from grantex import DenialReason, Grantex, ToolManifest, TokenSubReason, ToolSubReason
from grantex._authorization_details import (
    AuthorizationDetailsError,
    parse_tools_authorization,
)
from grantex._types import AuditEntry, AuthorizationRequest, AuthorizeParams, Grant, VerifiedGrant
from grantex._verify import _build_payload, _payload_to_verified_grant
from grantex.denials import PurposeSubReason
from grantex.manifest import is_valid_purpose_pattern
from grantex.purpose import (
    PURPOSE_VOCABULARY,
    is_known_purpose,
    is_valid_purpose,
    match_purpose,
    purpose_matches,
)

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "purpose-matching.json").read_text(
        encoding="utf-8"
    )
)


def _grant(purpose: Optional[str] = None, *, details: Any = "unset", scopes: tuple[str, ...] = ("tool:acme_kyb:write",)) -> VerifiedGrant:
    if details == "unset":
        details = (
            None
            if purpose is None
            else [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": purpose}]
        )
    return VerifiedGrant(
        token_id="tok_01",
        grant_id="grnt_01",
        principal_id="user_01",
        agent_did="did:grantex:ag_01",
        developer_id="org_01",
        scopes=scopes,
        issued_at=1709000000,
        expires_at=9999999999,
        authorization_details=details,
    )


ACME_KYB = ToolManifest.from_dict(
    {
        "connector": "acme_kyb",
        "tools": {
            "get_case": "read",
            "add_case_note": "write",
            "resolve_business": {"permission": "read", "allowed_purposes": ["aml.cdd.*"]},
            "screen_person": {"permission": "read", "allowed_purposes": ["aml.*"]},
            "monitor_enroll": {"permission": "write", "allowed_purposes": ["aml.cdd.ongoing"]},
            "private_lookup": {"permission": "read", "allowed_purposes": ["x-acme-bank.*"]},
            "open_tool": {"permission": "read", "requires_decision": False},
        },
    }
)


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        yield mock


def _enforce(verify: MagicMock, grant: VerifiedGrant, tool: str, connector: str = "acme_kyb") -> Any:
    verify.return_value = grant
    client = Grantex(api_key="test-key")
    client.load_manifest(ACME_KYB)
    return client.enforce("t", connector, tool)


# ── Acceptance criteria ─────────────────────────────────────────────────────


class TestPurposeBoundGrantsAcceptanceCriteria:
    def test_grant_with_purpose_marketing_enrichment_cannot_call_a_tool_restricted_to_aml_cdd_and_the_denial_names_purpose(
        self, verify: MagicMock
    ) -> None:
        result = _enforce(verify, _grant("marketing.enrichment"), "resolve_business")
        assert result.allowed is False
        assert result.reason_code == DenialReason.PURPOSE_NOT_ALLOWED == "purpose_not_allowed"
        assert "purpose" in result.reason

    def test_wildcard_matching_is_prefix_segment_based(self) -> None:
        assert purpose_matches("aml.cdd.*", "aml.cdd.onboarding") is True
        assert purpose_matches("aml.cdd.*", "aml.cddx") is False

    def test_grant_with_no_purpose_is_denied_for_any_tool_that_declares_allowed_purposes(
        self, verify: MagicMock
    ) -> None:
        for tool in ("resolve_business", "screen_person", "monitor_enroll", "private_lookup"):
            result = _enforce(verify, _grant(None), tool)
            assert (result.allowed, result.reason_code, result.sub_reason) == (
                False,
                DenialReason.PURPOSE_NOT_ALLOWED,
                PurposeSubReason.MISSING,
            ), tool

    def test_prefix_wildcard_does_not_match_the_prefix_itself(self) -> None:
        assert purpose_matches("aml.*", "aml") is False
        assert purpose_matches("aml.cdd.*", "aml.cdd") is False


# ── enforce() ────────────────────────────────────────────────────────────────


class TestEnforcePurpose:
    def test_matching_purpose_is_allowed_and_reported(self, verify: MagicMock) -> None:
        result = _enforce(verify, _grant("aml.cdd.onboarding"), "resolve_business")
        assert result.allowed is True
        assert result.purpose == "aml.cdd.onboarding"

    def test_exact_pattern_requires_the_exact_purpose(self, verify: MagicMock) -> None:
        assert _enforce(verify, _grant("aml.cdd.ongoing"), "monitor_enroll").allowed is True
        denied = _enforce(verify, _grant("aml.cdd.onboarding"), "monitor_enroll")
        assert (denied.reason_code, denied.sub_reason) == (
            DenialReason.PURPOSE_NOT_ALLOWED,
            PurposeSubReason.NOT_MATCHED,
        )
        assert denied.details == {"allowed_purposes": ["aml.cdd.ongoing"], "purpose": "aml.cdd.onboarding"}

    def test_private_purpose_matches_private_pattern(self, verify: MagicMock) -> None:
        assert _enforce(verify, _grant("x-acme-bank.kyb_refresh"), "private_lookup").allowed is True
        assert _enforce(verify, _grant("x-other.kyb_refresh"), "private_lookup").allowed is False

    def test_purpose_outside_the_vocabulary_is_denied_even_if_a_pattern_would_match(
        self, verify: MagicMock
    ) -> None:
        # aml.* would match aml.cdd syntactically, but aml.cdd is not a purpose.
        result = _enforce(verify, _grant("aml.cdd"), "screen_person")
        assert (result.allowed, result.reason_code, result.sub_reason) == (
            False,
            DenialReason.PURPOSE_NOT_ALLOWED,
            PurposeSubReason.UNKNOWN_PURPOSE,
        )

    def test_malformed_purpose_is_denied(self, verify: MagicMock) -> None:
        result = _enforce(verify, _grant("AML.cdd.onboarding"), "resolve_business")
        assert (result.reason_code, result.sub_reason) == (
            DenialReason.PURPOSE_NOT_ALLOWED,
            PurposeSubReason.UNKNOWN_PURPOSE,
        )

    def test_purpose_for_another_connector_does_not_apply(self, verify: MagicMock) -> None:
        details = [{"type": "urn:grantex:tools:v1", "connector": "other_kyb", "purpose": "aml.cdd.onboarding"}]
        result = _enforce(verify, _grant(details=details), "resolve_business")
        assert (result.reason_code, result.sub_reason) == (
            DenialReason.PURPOSE_NOT_ALLOWED,
            PurposeSubReason.MISSING,
        )

    def test_purpose_check_follows_the_permission_check(self, verify: MagicMock) -> None:
        grant = _grant("marketing.enrichment", scopes=("tool:acme_kyb:read",))
        assert _enforce(verify, grant, "monitor_enroll").reason_code == DenialReason.PERMISSION_INSUFFICIENT


class TestToolsWithoutAllowedPurposesBehaveAsBefore:
    @pytest.mark.parametrize("purpose", [None, "aml.cdd.onboarding", "marketing.enrichment", "AML"])
    def test_tools_without_allowed_purposes_ignore_the_grant_purpose(
        self, verify: MagicMock, purpose: Optional[str]
    ) -> None:
        for tool in ("get_case", "add_case_note", "open_tool"):
            assert _enforce(verify, _grant(purpose), tool).allowed is True

    def test_permission_denials_are_unchanged(self, verify: MagicMock) -> None:
        result = _enforce(verify, _grant("aml.screening", scopes=("tool:acme_kyb:read",)), "add_case_note")
        assert result.allowed is False
        assert result.reason == "read scope does not permit write operations on acme_kyb."


class TestAuthorizationDetailsInEnforce:
    def test_other_detail_types_are_ignored(self, verify: MagicMock) -> None:
        details = [
            {"type": "urn:grantex:params:oauth:authorization-details:budget", "amount": "10", "currency": "USD"},
            {"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "aml.screening"},
        ]
        assert _enforce(verify, _grant(details=details), "screen_person").allowed is True

    @pytest.mark.parametrize(
        "details",
        [
            {"type": "urn:grantex:tools:v1"},
            ["not-an-object"],
            [{"connector": "acme_kyb"}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": 7}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "scope": "all"}],
            [
                {"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "aml.screening"},
                {"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "payments.payout"},
            ],
        ],
    )
    def test_malformed_authorization_details_deny_every_call(self, verify: MagicMock, details: Any) -> None:
        for tool in ("get_case", "resolve_business"):
            result = _enforce(verify, _grant(details=details), tool)
            assert (result.allowed, result.reason_code, result.sub_reason) == (
                False,
                DenialReason.TOKEN_INVALID,
                TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
            )

    def test_tools_list_restricts_tools(self, verify: MagicMock) -> None:
        details = [
            {
                "type": "urn:grantex:tools:v1",
                "connector": "acme_kyb",
                "purpose": "aml.cdd.onboarding",
                "tools": ["resolve_business", "screen_*"],
            }
        ]
        assert _enforce(verify, _grant(details=details), "resolve_business").allowed is True
        assert _enforce(verify, _grant(details=details), "screen_person").allowed is True
        denied = _enforce(verify, _grant(details=details), "get_case")
        assert (denied.reason_code, denied.sub_reason) == (
            DenialReason.TOOL_NOT_GRANTED,
            ToolSubReason.NOT_IN_AUTHORIZATION_DETAILS,
        )

    def test_grant_caps_for_the_tool_fail_closed_without_a_meter(self, verify: MagicMock) -> None:
        details = [
            {
                "type": "urn:grantex:tools:v1",
                "connector": "acme_kyb",
                "purpose": "aml.cdd.onboarding",
                "caps": {"resolve_business": {"per_hour": 5}},
            }
        ]
        result = _enforce(verify, _grant(details=details), "resolve_business")
        assert (result.reason_code, result.sub_reason) == (DenialReason.CAP_EXCEEDED, "meter_unavailable")
        assert _enforce(verify, _grant(details=details), "get_case").allowed is True

    def test_verified_grant_carries_the_claim(self) -> None:
        details = [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "aml.screening"}]
        payload = _build_payload(
            {
                "jti": "tok_01", "sub": "user_01", "agt": "did:grantex:ag_01", "dev": "org_01",
                "scp": ["tool:acme_kyb:read"], "iat": 1, "exp": 2, "authorization_details": details,
            }
        )
        assert _payload_to_verified_grant(payload).authorization_details == details


class TestParseToolsAuthorization:
    def test_absent_claim_is_empty(self) -> None:
        assert parse_tools_authorization(None) == {}

    def test_full_entry(self) -> None:
        entries = parse_tools_authorization(
            [
                {
                    "type": "urn:grantex:tools:v1",
                    "connector": "acme_kyb",
                    "purpose": "aml.cdd.onboarding",
                    "data_region": "eu",
                    "tools": ["resolve_business", "screen_*"],
                    "caps": {"verify_business": {"per_hour": 50}},
                }
            ]
        )
        entry = entries["acme_kyb"]
        assert entry.purpose == "aml.cdd.onboarding"
        assert entry.data_region == "eu"
        assert entry.tools == ("resolve_business", "screen_*")
        assert entry.caps == {"verify_business": {"per_hour": 50}}
        assert entry.allows_tool("screen_business") is True
        assert entry.allows_tool("verify_business") is False

    @pytest.mark.parametrize(
        "claim",
        [
            "x",
            [{"type": ""}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme kyb"}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "tools": "resolve_business"}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "tools": ["*"]}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": []}],
            [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "data_region": 1}],
        ],
    )
    def test_malformed_claims_raise(self, claim: Any) -> None:
        with pytest.raises(AuthorizationDetailsError):
            parse_tools_authorization(claim)


# ── Shared fixtures ─────────────────────────────────────────────────────────


def test_vocabulary_matches_the_shared_fixture() -> None:
    assert PURPOSE_VOCABULARY == frozenset(FIXTURES["vocabulary"])


@pytest.mark.parametrize(
    "case", FIXTURES["match_cases"], ids=[f"{c['pattern']!r}~{c['purpose']!r}" for c in FIXTURES["match_cases"]]
)
def test_shared_match_case(case: Dict[str, Any]) -> None:
    assert purpose_matches(case["pattern"], case["purpose"]) is case["matches"]


@pytest.mark.parametrize("case", FIXTURES["known_cases"], ids=[repr(c["purpose"]) for c in FIXTURES["known_cases"]])
def test_shared_known_case(case: Dict[str, Any]) -> None:
    assert is_known_purpose(case["purpose"]) is case["known"]


# ── Property tests (seeded, deterministic) ──────────────────────────────────

_RNG_SEED = 20260915
_ITERATIONS = 2000


def _segment(rng: random.Random) -> str:
    first = rng.choice(string.ascii_lowercase)
    rest = "".join(rng.choice(string.ascii_lowercase + string.digits + "_") for _ in range(rng.randint(0, 6)))
    return first + rest


def _purpose(rng: random.Random, segments: Optional[int] = None) -> str:
    count = segments if segments is not None else rng.randint(1, 5)
    parts = [_segment(rng) for _ in range(count)]
    if rng.random() < 0.2:
        org = "x-" + "-".join(
            "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(rng.randint(1, 4)))
            for _ in range(rng.randint(1, 2))
        )
        return ".".join([org] + parts)
    return ".".join(parts)


def _reference_match(pattern: str, purpose: str) -> bool:
    """Segment-list reference model for well-formed inputs."""
    p_parts = pattern.split(".")
    q_parts = purpose.split(".")
    if p_parts[-1] == "*":
        prefix = p_parts[:-1]
        return len(q_parts) > len(prefix) and q_parts[: len(prefix)] == prefix
    return p_parts == q_parts


class TestPurposeMatcherProperties:
    def test_exact_pattern_matches_only_itself(self) -> None:
        rng = random.Random(_RNG_SEED)
        for _ in range(_ITERATIONS):
            p, q = _purpose(rng), _purpose(rng)
            assert purpose_matches(p, p) is True
            assert purpose_matches(p, q) is (p == q)

    def test_every_proper_prefix_wildcard_matches_and_never_matches_the_prefix(self) -> None:
        rng = random.Random(_RNG_SEED + 1)
        for _ in range(_ITERATIONS):
            p = _purpose(rng, rng.randint(2, 5))
            parts = p.split(".")
            for k in range(1, len(parts)):
                prefix = ".".join(parts[:k])
                if not is_valid_purpose(prefix):
                    continue  # a bare private org is not a purpose prefix on its own
                assert purpose_matches(prefix + ".*", p) is True
                assert purpose_matches(prefix + ".*", prefix) is False

    def test_extending_the_last_prefix_segment_never_matches(self) -> None:
        rng = random.Random(_RNG_SEED + 2)
        for _ in range(_ITERATIONS):
            p = _purpose(rng, rng.randint(2, 5))
            parts = p.split(".")
            k = rng.randint(1, len(parts) - 1)
            prefix = ".".join(parts[:k])
            extended = prefix + rng.choice(string.ascii_lowercase + string.digits + "_")
            tail = ".".join(parts[k:])
            assert purpose_matches(prefix + ".*", extended) is False
            assert purpose_matches(prefix + ".*", extended + "." + tail) is False

    def test_matches_the_segment_reference_model(self) -> None:
        rng = random.Random(_RNG_SEED + 3)
        for _ in range(_ITERATIONS):
            q = _purpose(rng)
            if rng.random() < 0.5:
                # Build the pattern from q so matches are common.
                parts = q.split(".")
                k = rng.randint(1, len(parts))
                base = ".".join(parts[:k])
                pattern = base + ".*" if rng.random() < 0.7 else base
            else:
                pattern = _purpose(rng) + (".*" if rng.random() < 0.5 else "")
            if not is_valid_purpose_pattern(pattern):
                assert purpose_matches(pattern, q) is False
                continue
            assert purpose_matches(pattern, q) is _reference_match(pattern, q), (pattern, q)

    def test_malformed_inputs_never_match(self) -> None:
        rng = random.Random(_RNG_SEED + 4)
        alphabet = string.ascii_letters + string.digits + "._-* \n"
        for _ in range(_ITERATIONS):
            junk = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 12)))
            good = _purpose(rng)
            if not is_valid_purpose(junk):
                assert purpose_matches(good + ".*", junk) is False
                assert purpose_matches(junk, junk) is False
            assert purpose_matches(None, good) is False
            assert purpose_matches(good, None) is False

    def test_match_purpose_returns_the_first_matching_pattern(self) -> None:
        assert match_purpose(["payments.*", "aml.*", "aml.cdd.*"], "aml.cdd.onboarding") == "aml.*"
        assert match_purpose([], "aml.screening") is None
        assert match_purpose(None, "aml.screening") is None


def test_authorize_params_send_purpose() -> None:
    params = AuthorizeParams(agent_id="ag_01", user_id="user_01", scopes=["tool:acme_kyb:read"], purpose="aml.screening")
    assert params.to_dict()["purpose"] == "aml.screening"
    assert "purpose" not in AuthorizeParams(agent_id="ag_01", user_id="user_01", scopes=["x"]).to_dict()


def test_api_types_read_purpose() -> None:
    grant = Grant.from_dict({"grantId": "grnt_01", "scopes": [], "purpose": "aml.screening"})
    assert grant.purpose == "aml.screening"
    assert Grant.from_dict({"grantId": "grnt_01"}).purpose is None
    entry = AuditEntry.from_dict(
        {
            "entryId": "alog_01", "agentId": "ag_01", "agentDid": "did:grantex:ag_01",
            "grantId": "grnt_01", "principalId": "user_01", "action": "acme_kyb.resolve_business",
            "hash": "h", "timestamp": "2026-09-15T00:00:00Z", "purpose": "aml.cdd.onboarding",
        }
    )
    assert entry.purpose == "aml.cdd.onboarding"
    assert AuthorizationRequest.from_dict({"authRequestId": "areq_01", "purpose": "payments.payout"}).purpose == "payments.payout"

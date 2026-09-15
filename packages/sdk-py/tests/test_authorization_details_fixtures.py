"""authorization_details parsing against the fixtures shared with the TypeScript SDK,
and the enforce() consequences of grant caps that cannot be read unambiguously."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterator
from unittest.mock import MagicMock, patch

import pytest

from grantex import Grantex, ManifestValidationError, ToolManifest
from grantex._authorization_details import (
    AuthorizationDetailsError,
    ToolsAuthorization,
    parse_tools_authorization,
)
from grantex._types import VerifiedGrant
from grantex.caps import CapsMeter, InMemoryCapsBackend

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "authorization-details.json").read_text(encoding="utf-8")
)


def _as_fixture(entry: ToolsAuthorization) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if entry.purpose is not None:
        out["purpose"] = entry.purpose
    if entry.data_region is not None:
        out["data_region"] = entry.data_region
    if entry.tools is not None:
        out["tools"] = list(entry.tools)
    if entry.caps is not None:
        out["caps"] = {name: dict(windows) for name, windows in entry.caps.items()}
    return out


@pytest.mark.parametrize("case", FIXTURES["valid"], ids=[c["name"] for c in FIXTURES["valid"]])
def test_valid_claim(case: Dict[str, Any]) -> None:
    entries = parse_tools_authorization(case["claim"])
    assert {name: _as_fixture(entry) for name, entry in entries.items()} == case["entries"]


@pytest.mark.parametrize("case", FIXTURES["invalid"], ids=[c["name"] for c in FIXTURES["invalid"]])
def test_invalid_claim(case: Dict[str, Any]) -> None:
    with pytest.raises(AuthorizationDetailsError):
        parse_tools_authorization(case["claim"])


# ── enforce() ────────────────────────────────────────────────────────────────

MANIFEST = ToolManifest.from_dict(
    {
        "connector": "acme_kyb",
        "tools": {"get_case": "read", "screen_person": "read", "screen_business": "read"},
    }
)


def _grant(details: Any) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="user_01", agent_did="did:grantex:ag_01",
        developer_id="dev_01", scopes=("tool:acme_kyb:read",), issued_at=1709000000, expires_at=9999999999,
        authorization_details=details,
    )


@pytest.fixture()
def client() -> Iterator[tuple[Grantex, MagicMock]]:
    with patch("grantex._client.verify_grant_token") as verify:
        c = Grantex(api_key="test-key", caps_meter=CapsMeter(InMemoryCapsBackend()))
        c.load_manifest(MANIFEST)
        yield c, verify


def test_wildcard_cap_keys_deny_instead_of_being_ignored(client: tuple[Grantex, MagicMock]) -> None:
    c, verify = client
    verify.return_value = _grant(
        [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "tools": ["screen_*"], "caps": {"screen_*": {"per_hour": 1}}}]
    )
    results = [c.enforce("t", "acme_kyb", "screen_person") for _ in range(3)]
    assert all(r.allowed is False for r in results)
    assert {(r.reason_code, r.sub_reason) for r in results} == {("token_invalid", "malformed_authorization_details")}


def test_malformed_caps_for_another_tool_deny_every_call_on_the_connector(client: tuple[Grantex, MagicMock]) -> None:
    c, verify = client
    verify.return_value = _grant(
        [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": {"screen_business": {"per_hour": "x"}}}]
    )
    result = c.enforce("t", "acme_kyb", "get_case")
    assert (result.allowed, result.sub_reason) == (False, "malformed_authorization_details")


def test_exact_grant_caps_apply(client: tuple[Grantex, MagicMock]) -> None:
    c, verify = client
    verify.return_value = _grant(
        [{"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "caps": {"screen_person": {"per_hour": 1}}}]
    )
    assert c.enforce("t", "acme_kyb", "screen_person").allowed is True
    denied = c.enforce("t", "acme_kyb", "screen_person")
    assert (denied.reason_code, denied.details["limit"], denied.details["scope"]) == ("cap_exceeded", 1, "grant")
    assert c.enforce("t", "acme_kyb", "screen_business").allowed is True


@pytest.mark.parametrize(
    "tools",
    [{"cost_units": {"permission": "read"}}, {"get_case": "read", "cost_units": "read"}],
)
def test_cost_units_is_not_a_tool_name(tools: Dict[str, Any]) -> None:
    with pytest.raises(ManifestValidationError, match='tool name "cost_units" is reserved'):
        ToolManifest.from_dict({"connector": "acme_kyb", "tools": tools})
    with pytest.raises(ManifestValidationError, match="is reserved"):
        ToolManifest(connector="acme_kyb", tools={"get_case": "read"}).add_tool("cost_units", "read")

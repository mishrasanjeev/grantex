# SPDX-License-Identifier: Apache-2.0
"""enforce() checks the grant's data region against the relying party's.

A ``urn:grantex:tools:v1`` entry may carry ``data_region``: the region the
grant's data may be processed in. With ``data_region_check="on"`` enforce()
denies a call for a connector whose entry names a region when the client has no
expected region (``region_unconfigured``), and when the regions differ
(``region_mismatch``). An entry without a region is unrestricted. The check is
``off`` by default in this release.

The cases in spec/examples/enforce-data-region.json are shared with the
TypeScript SDK and @grantex/gateway.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterator, List
from unittest.mock import MagicMock, patch

import pytest

from grantex import DenialReason, Grantex, RegionSubReason, ToolManifest
from grantex._types import VerifiedGrant

CASES: List[Dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "enforce-data-region.json").read_text(
        encoding="utf-8"
    )
)["cases"]

MANIFEST = ToolManifest.from_dict({"connector": "acme_kyb", "tools": {"get_case": "read"}})


def _grant(region: Any) -> VerifiedGrant:
    entry: Dict[str, Any] = {"type": "urn:grantex:tools:v1", "connector": "acme_kyb", "purpose": "aml.cdd.onboarding"}
    if region is not None:
        entry["data_region"] = region
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="shopper-01",
        agent_did="did:grantex:ag_01", developer_id="dev_01",
        scopes=("tool:acme_kyb:read",), issued_at=1709000000, expires_at=9999999999,
        authorization_details=[entry],
    )


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        yield mock


def _client(**options: Any) -> Grantex:
    c = Grantex(api_key="test-key", **{"revocation_check": "offline", "audience_check": "off", **options})
    c.load_manifest(MANIFEST)
    return c


def _outcome(result: Any) -> str:
    if result.allowed:
        return "allow"
    assert result.reason_code == DenialReason.REGION_MISMATCH
    return str(result.sub_reason)


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_data_region_cases(case: Dict[str, Any], verify: MagicMock) -> None:
    verify.return_value = _grant(case["token_region"])
    options: Dict[str, Any] = {"data_region_check": case["region_check"]}
    if case["client_region"] is not None:
        options["data_region"] = case["client_region"]
    call: Dict[str, Any] = {}
    if case["call_region"] is not None:
        call["data_region"] = case["call_region"]
    result = _client(**options).enforce(grant_token="t", connector="acme_kyb", tool="get_case", **call)
    assert _outcome(result) == case["expect"]


def test_off_by_default(verify: MagicMock) -> None:
    verify.return_value = _grant("eu")
    assert _client().enforce(grant_token="t", connector="acme_kyb", tool="get_case").allowed is True


def test_denial_details_and_permissive_mode(verify: MagicMock) -> None:
    verify.return_value = _grant("eu")
    result = _client(data_region_check="on", data_region="in", enforce_mode="permissive").enforce(
        grant_token="t", connector="acme_kyb", tool="get_case"
    )
    assert result.allowed is False
    assert result.reason_code == DenialReason.REGION_MISMATCH
    assert result.sub_reason == RegionSubReason.REGION_MISMATCH
    assert result.details == {"expected_data_region": "in", "token_data_region": "eu"}


def test_invalid_configuration_is_refused() -> None:
    with pytest.raises(ValueError, match="data_region cannot be set with data_region_check='off'"):
        Grantex(api_key="k", data_region="in")
    with pytest.raises(ValueError, match="data_region_check must be one of on, off"):
        Grantex(api_key="k", data_region_check="maybe")
    with pytest.raises(ValueError, match="data_region must be a non-empty string"):
        Grantex(api_key="k", data_region_check="on", data_region="")


def test_per_call_region_needs_the_check_on(verify: MagicMock) -> None:
    verify.return_value = _grant("in")
    with pytest.raises(ValueError, match="data_region cannot be set with data_region_check='off'"):
        _client().enforce(grant_token="t", connector="acme_kyb", tool="get_case", data_region="in")

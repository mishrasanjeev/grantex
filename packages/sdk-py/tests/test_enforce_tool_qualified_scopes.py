# SPDX-License-Identifier: Apache-2.0
"""enforce() honours the tool segment of a scope with ``tool_qualified_scopes=True`` (FINDINGS G-144).

The cases in spec/examples/enforce-tool-qualified-scopes.json are shared with the TypeScript SDK.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterator, List
from unittest.mock import MagicMock, patch

import pytest

from grantex import Grantex, ToolManifest
from grantex._types import VerifiedGrant

CASES: List[Dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "spec" / "examples" / "enforce-tool-qualified-scopes.json").read_text(
        encoding="utf-8"
    )
)["cases"]


def _grant(scopes: List[str]) -> VerifiedGrant:
    return VerifiedGrant(
        token_id="tok_01", grant_id="grnt_01", principal_id="shopper-01",
        agent_did="did:grantex:ag_01", developer_id="dev_01",
        scopes=tuple(scopes), issued_at=1709000000, expires_at=9999999999,
    )


@pytest.fixture()
def verify() -> Iterator[MagicMock]:
    with patch("grantex._client.verify_grant_token") as mock:
        yield mock


def _outcome(result: Any) -> str:
    if result.allowed:
        return "allow"
    return f"{result.reason_code or ''}/{result.sub_reason or ''}"


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_cases(case: Dict[str, Any], verify: MagicMock) -> None:
    verify.return_value = _grant(case["scopes"])
    client = Grantex(
        api_key="test-key", revocation_check="offline", audience_check="off", tool_qualified_scopes=case["option"]
    )
    client.load_manifest(ToolManifest.from_dict({"connector": "acme_kyb", "tools": {case["tool"]: case["required"]}}))
    result = client.enforce(grant_token="t", connector="acme_kyb", tool=case["tool"])
    assert _outcome(result) == case["expect"]
    if case["expect"].endswith("tool_scope_missing"):
        named = sorted({s.split(":")[3] for s in case["scopes"] if "acme_kyb" in s and len(s.split(":")) > 3})
        assert result.details == {"tool_scopes": named}


def test_off_by_default_and_type_checked() -> None:
    with pytest.raises(ValueError, match="tool_qualified_scopes must be a bool"):
        Grantex(api_key="k", tool_qualified_scopes="yes")  # type: ignore[arg-type]

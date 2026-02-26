"""Tests for ComplianceClient."""
from __future__ import annotations

import pytest
import respx
import httpx

from grantex import Grantex
from grantex._types import (
    ComplianceExportAuditParams,
    ComplianceExportGrantsParams,
    EvidencePackParams,
)
from tests.conftest import MOCK_GRANT, MOCK_AUDIT_ENTRY

MOCK_SUMMARY = {
    "generatedAt": "2026-02-26T00:00:00Z",
    "agents": {"total": 5, "active": 4, "suspended": 1, "revoked": 0},
    "grants": {"total": 23, "active": 18, "revoked": 3, "expired": 2},
    "auditEntries": {"total": 412, "success": 400, "failure": 10, "blocked": 2},
    "policies": {"total": 2},
    "plan": "pro",
}

MOCK_GRANTS_EXPORT = {
    "generatedAt": "2026-02-26T00:00:00Z",
    "total": 1,
    "grants": [MOCK_GRANT],
}

MOCK_AUDIT_EXPORT = {
    "generatedAt": "2026-02-26T00:00:00Z",
    "total": 1,
    "entries": [MOCK_AUDIT_ENTRY],
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


@respx.mock
def test_get_summary(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/compliance/summary").mock(
        return_value=httpx.Response(200, json=MOCK_SUMMARY)
    )
    summary = client.compliance.get_summary()

    assert summary.plan == "pro"
    assert summary.agents["total"] == 5
    assert summary.grants["active"] == 18
    assert summary.audit_entries["failure"] == 10
    assert summary.policies["total"] == 2
    assert summary.since is None


@respx.mock
def test_get_summary_with_params(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/compliance/summary").mock(
        return_value=httpx.Response(200, json=MOCK_SUMMARY)
    )
    client.compliance.get_summary(since="2026-01-01T00:00:00Z", until="2026-12-31T00:00:00Z")

    url = str(route.calls[0].request.url)
    assert "since=" in url
    assert "until=" in url


@respx.mock
def test_export_grants(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/compliance/export/grants").mock(
        return_value=httpx.Response(200, json=MOCK_GRANTS_EXPORT)
    )
    export = client.compliance.export_grants()

    assert export.total == 1
    assert len(export.grants) == 1
    assert export.grants[0].id == "grant_01HXYZ"


@respx.mock
def test_export_grants_with_params(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/compliance/export/grants").mock(
        return_value=httpx.Response(200, json=MOCK_GRANTS_EXPORT)
    )
    params = ComplianceExportGrantsParams(status="active", since="2026-01-01T00:00:00Z")
    client.compliance.export_grants(params)

    url = str(route.calls[0].request.url)
    assert "status=active" in url
    assert "since=" in url


@respx.mock
def test_export_audit(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/compliance/export/audit").mock(
        return_value=httpx.Response(200, json=MOCK_AUDIT_EXPORT)
    )
    export = client.compliance.export_audit()

    assert export.total == 1
    assert len(export.entries) == 1
    assert export.entries[0].entry_id == "audit_01HXYZ"


@respx.mock
def test_export_audit_with_params(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/compliance/export/audit").mock(
        return_value=httpx.Response(200, json=MOCK_AUDIT_EXPORT)
    )
    params = ComplianceExportAuditParams(
        agent_id="ag_01HXYZ123abc",
        status="failure",
    )
    client.compliance.export_audit(params)

    url = str(route.calls[0].request.url)
    assert "agentId=ag_01HXYZ123abc" in url
    assert "status=failure" in url


MOCK_EVIDENCE_PACK = {
    "meta": {
        "schemaVersion": "1.0",
        "generatedAt": "2026-02-26T00:00:00Z",
        "framework": "all",
    },
    "summary": {
        "agents": {"total": 5, "active": 4, "suspended": 1, "revoked": 0},
        "grants": {"total": 23, "active": 18, "revoked": 3, "expired": 2},
        "auditEntries": {"total": 412, "success": 400, "failure": 10, "blocked": 2},
        "policies": {"total": 2},
        "plan": "pro",
    },
    "grants": [MOCK_GRANT],
    "auditEntries": [MOCK_AUDIT_ENTRY],
    "policies": [],
    "chainIntegrity": {"valid": True, "checkedEntries": 1, "firstBrokenAt": None},
}


@respx.mock
def test_evidence_pack(client: Grantex) -> None:
    respx.get("https://api.grantex.dev/v1/compliance/evidence-pack").mock(
        return_value=httpx.Response(200, json=MOCK_EVIDENCE_PACK)
    )
    pack = client.compliance.evidence_pack()

    assert pack.meta.schema_version == "1.0"
    assert pack.meta.framework == "all"
    assert pack.meta.since is None
    assert pack.summary["plan"] == "pro"
    assert len(pack.grants) == 1
    assert len(pack.audit_entries) == 1
    assert pack.chain_integrity.valid is True
    assert pack.chain_integrity.checked_entries == 1
    assert pack.chain_integrity.first_broken_at is None


@respx.mock
def test_evidence_pack_with_params(client: Grantex) -> None:
    route = respx.get("https://api.grantex.dev/v1/compliance/evidence-pack").mock(
        return_value=httpx.Response(200, json=MOCK_EVIDENCE_PACK)
    )
    params = EvidencePackParams(
        framework="soc2",
        since="2026-01-01T00:00:00Z",
        until="2026-12-31T00:00:00Z",
    )
    client.compliance.evidence_pack(params)

    url = str(route.calls[0].request.url)
    assert "framework=soc2" in url
    assert "since=" in url
    assert "until=" in url

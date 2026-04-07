"""Tests for DpdpClient — DPDP Act 2023 compliance endpoints."""
from __future__ import annotations

import json

import pytest
import respx
import httpx

from grantex import (
    Grantex,
    CreateConsentRecordParams,
    CreateConsentNoticeParams,
    FileGrievanceParams,
    CreateExportParams,
)

BASE = "https://api.grantex.dev"

MOCK_CONSENT_RECORD = {
    "recordId": "cr_01",
    "grantId": "grant_01",
    "dataPrincipalId": "user_abc",
    "consentNoticeHash": "abc123hash",
    "consentProof": {"type": "Ed25519Signature2020", "signedAt": "2026-04-01T00:00:00Z"},
    "processingExpiresAt": "2027-04-01T00:00:00Z",
    "retentionUntil": "2027-05-01T00:00:00Z",
    "status": "active",
    "createdAt": "2026-04-01T00:00:00Z",
}

MOCK_CONSENT_NOTICE = {
    "id": "cn_01",
    "noticeId": "privacy-notice-v1",
    "version": "1.0",
    "language": "en",
    "contentHash": "sha256abc",
    "createdAt": "2026-04-01T00:00:00Z",
}

MOCK_GRIEVANCE = {
    "grievanceId": "grv_01",
    "referenceNumber": "GRV-2026-00001",
    "type": "consent-violation",
    "status": "submitted",
    "dataPrincipalId": "user_abc",
    "description": "Consent was not obtained before processing",
    "expectedResolutionBy": "2026-04-08T00:00:00Z",
    "createdAt": "2026-04-01T00:00:00Z",
}

MOCK_EXPORT = {
    "exportId": "exp_01",
    "type": "dpdp-audit",
    "format": "json",
    "status": "completed",
    "recordCount": 5,
    "data": {"exportType": "dpdp-audit", "generatedAt": "2026-04-01T00:00:00Z"},
    "expiresAt": "2026-04-08T00:00:00Z",
    "createdAt": "2026-04-01T00:00:00Z",
}


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


# ── Consent Records ──────────────────────────────────────────────────────────


@respx.mock
def test_create_consent_record(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records").mock(
        return_value=httpx.Response(201, json=MOCK_CONSENT_RECORD)
    )
    result = client.dpdp.create_consent_record(
        CreateConsentRecordParams(
            grant_id="grant_01",
            data_principal_id="user_abc",
            purposes=[{"code": "marketing", "description": "Email marketing"}],
            consent_notice_id="privacy-notice-v1",
            processing_expires_at="2027-04-01T00:00:00Z",
        )
    )

    assert result.record_id == "cr_01"
    assert result.grant_id == "grant_01"
    assert result.status == "active"
    assert result.consent_notice_hash == "abc123hash"

    body = json.loads(route.calls[0].request.content)
    assert body["grantId"] == "grant_01"
    assert body["dataPrincipalId"] == "user_abc"
    assert body["consentNoticeId"] == "privacy-notice-v1"


@respx.mock
def test_get_consent_record(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records/cr_01").mock(
        return_value=httpx.Response(200, json=MOCK_CONSENT_RECORD)
    )
    result = client.dpdp.get_consent_record("cr_01")

    assert result.record_id == "cr_01"
    assert result.data_principal_id == "user_abc"
    assert result.consent_proof is not None
    assert result.consent_proof["type"] == "Ed25519Signature2020"


@respx.mock
def test_list_consent_records_no_filter(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records").mock(
        return_value=httpx.Response(
            200, json={"records": [MOCK_CONSENT_RECORD], "totalRecords": 1}
        )
    )
    result = client.dpdp.list_consent_records()

    assert result.total_records == 1
    assert len(result.records) == 1
    assert result.records[0].record_id == "cr_01"


@respx.mock
def test_list_consent_records_with_principal(client: Grantex) -> None:
    respx.get(url__regex=r"/v1/dpdp/consent-records\?dataPrincipalId=user_abc").mock(
        return_value=httpx.Response(
            200, json={"records": [MOCK_CONSENT_RECORD], "totalRecords": 1}
        )
    )
    result = client.dpdp.list_consent_records(principal_id="user_abc")

    assert result.total_records == 1


# ── Withdraw Consent ─────────────────────────────────────────────────────────


@respx.mock
def test_withdraw_consent(client: Grantex) -> None:
    mock_response = {
        "recordId": "cr_01",
        "status": "withdrawn",
        "withdrawnAt": "2026-04-02T00:00:00Z",
        "grantRevoked": True,
        "dataDeleted": True,
    }
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=mock_response)
    )
    result = client.dpdp.withdraw_consent(
        "cr_01", reason="User requested", revoke_grant=True, delete_data=True
    )

    assert result.record_id == "cr_01"
    assert result.status == "withdrawn"
    assert result.grant_revoked is True
    assert result.data_deleted is True

    body = json.loads(route.calls[0].request.content)
    assert body["reason"] == "User requested"
    assert body["revokeGrant"] is True
    assert body["deleteProcessedData"] is True


@respx.mock
def test_withdraw_consent_minimal(client: Grantex) -> None:
    mock_response = {
        "recordId": "cr_01",
        "status": "withdrawn",
        "withdrawnAt": "2026-04-02T00:00:00Z",
        "grantRevoked": False,
        "dataDeleted": False,
    }
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=mock_response)
    )
    result = client.dpdp.withdraw_consent("cr_01", reason="Changed mind")

    assert result.grant_revoked is False
    assert result.data_deleted is False

    body = json.loads(route.calls[0].request.content)
    assert "revokeGrant" not in body
    assert "deleteProcessedData" not in body


# ── Data Principal Rights ────────────────────────────────────────────────────


@respx.mock
def test_list_principal_records(client: Grantex) -> None:
    mock_response = {
        "dataPrincipalId": "user_abc",
        "records": [MOCK_CONSENT_RECORD],
        "totalRecords": 1,
    }
    respx.get(f"{BASE}/v1/dpdp/data-principals/user_abc/records").mock(
        return_value=httpx.Response(200, json=mock_response)
    )
    result = client.dpdp.list_principal_records("user_abc")

    assert result.data_principal_id == "user_abc"
    assert result.total_records == 1
    assert result.records[0].record_id == "cr_01"


@respx.mock
def test_request_erasure(client: Grantex) -> None:
    mock_response = {
        "requestId": "ER-2026-00001",
        "dataPrincipalId": "user_abc",
        "status": "completed",
        "recordsErased": 2,
        "grantsRevoked": 1,
        "submittedAt": "2026-04-02T00:00:00Z",
        "expectedCompletionBy": "2026-04-09T00:00:00Z",
    }
    route = respx.post(f"{BASE}/v1/dpdp/data-principals/user_abc/erasure").mock(
        return_value=httpx.Response(201, json=mock_response)
    )
    result = client.dpdp.request_erasure("user_abc")

    assert result.request_id == "ER-2026-00001"
    assert result.status == "completed"
    assert result.records_erased == 2
    assert result.grants_revoked == 1

    body = json.loads(route.calls[0].request.content)
    assert body["dataPrincipalId"] == "user_abc"


# ── Consent Notices ──────────────────────────────────────────────────────────


@respx.mock
def test_create_consent_notice(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-notices").mock(
        return_value=httpx.Response(201, json=MOCK_CONSENT_NOTICE)
    )
    result = client.dpdp.create_consent_notice(
        CreateConsentNoticeParams(
            notice_id="privacy-notice-v1",
            version="1.0",
            title="Privacy Notice",
            content="We process your data for...",
            purposes=[{"code": "marketing", "description": "Email marketing"}],
            language="en",
        )
    )

    assert result.id == "cn_01"
    assert result.notice_id == "privacy-notice-v1"
    assert result.version == "1.0"
    assert result.content_hash == "sha256abc"

    body = json.loads(route.calls[0].request.content)
    assert body["noticeId"] == "privacy-notice-v1"
    assert body["language"] == "en"


# ── Grievances ───────────────────────────────────────────────────────────────


@respx.mock
def test_file_grievance(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/grievances").mock(
        return_value=httpx.Response(202, json=MOCK_GRIEVANCE)
    )
    result = client.dpdp.file_grievance(
        FileGrievanceParams(
            data_principal_id="user_abc",
            type="consent-violation",
            description="Consent was not obtained before processing",
        )
    )

    assert result.grievance_id == "grv_01"
    assert result.reference_number == "GRV-2026-00001"
    assert result.status == "submitted"

    body = json.loads(route.calls[0].request.content)
    assert body["dataPrincipalId"] == "user_abc"
    assert body["type"] == "consent-violation"


@respx.mock
def test_get_grievance(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/grievances/grv_01").mock(
        return_value=httpx.Response(200, json=MOCK_GRIEVANCE)
    )
    result = client.dpdp.get_grievance("grv_01")

    assert result.grievance_id == "grv_01"
    assert result.type == "consent-violation"
    assert result.description == "Consent was not obtained before processing"


# ── Compliance Exports ───────────────────────────────────────────────────────


@respx.mock
def test_create_export(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/exports").mock(
        return_value=httpx.Response(201, json=MOCK_EXPORT)
    )
    result = client.dpdp.create_export(
        CreateExportParams(
            type="dpdp-audit",
            date_from="2026-01-01",
            date_to="2026-04-01",
            format="json",
        )
    )

    assert result.export_id == "exp_01"
    assert result.type == "dpdp-audit"
    assert result.record_count == 5
    assert result.data is not None

    body = json.loads(route.calls[0].request.content)
    assert body["type"] == "dpdp-audit"
    assert body["dateFrom"] == "2026-01-01"
    assert body["format"] == "json"


@respx.mock
def test_get_export(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/exports/exp_01").mock(
        return_value=httpx.Response(200, json=MOCK_EXPORT)
    )
    result = client.dpdp.get_export("exp_01")

    assert result.export_id == "exp_01"
    assert result.status == "completed"
    assert result.format == "json"

"""Tests for DpdpClient — DPDP Act 2023 endpoints.

Response bodies come from ``fixtures/dpdp_server_fixtures.json``: the bodies
the auth-service DPDP routes actually send.
"""
from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx

from grantex import (
    ComplianceExport,
    CreateConsentNoticeParams,
    CreateConsentRecordParams,
    CreateExportParams,
    DpdpExport,
    FileGrievanceParams,
    Grantex,
    GrantexApiError,
    GrantexNetworkError,
)

BASE = "https://api.grantex.dev"

_RAW: dict[str, Any] = json.loads(
    (Path(__file__).parent / "fixtures" / "dpdp_server_fixtures.json").read_text(
        encoding="utf-8"
    )
)


def _resolve(value: Any) -> Any:
    if isinstance(value, str) and value.startswith("<") and value.endswith(">"):
        return _resolve(_RAW[value[1:-1]])
    if isinstance(value, list):
        return [_resolve(v) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v) for k, v in value.items() if not k.startswith("_")}
    return value


def fx(name: str) -> dict[str, Any]:
    """A server response body, with annotations removed and references resolved."""
    result: dict[str, Any] = _resolve(_RAW[name])
    return result


def err_fx(name: str) -> dict[str, Any]:
    result: dict[str, Any] = _RAW["errors"][name]
    return result


TRAVERSAL_ID = "user@test.com/../x"
TRAVERSAL_ENC = "user%40test.com%2F..%2Fx"


@pytest.fixture
def client() -> Grantex:
    return Grantex(api_key="test-key")


def _query(route: respx.Route) -> dict[str, list[str]]:
    return parse_qs(urlsplit(str(route.calls[0].request.url)).query)


# ── Consent Records ──────────────────────────────────────────────────────────


@respx.mock
def test_create_consent_record(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records").mock(
        return_value=httpx.Response(201, json=fx("createConsentRecord_201"))
    )
    result = client.dpdp.create_consent_record(
        CreateConsentRecordParams(
            grant_id="grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V",
            data_principal_id="user_123",
            purposes=[
                {"code": "analytics", "description": "Usage analytics for service improvement"}
            ],
            consent_notice_id="privacy-notice",
            consent_notice_version="2.0",
            processing_expires_at="2027-09-30T00:00:00.000Z",
        )
    )

    assert result.record_id == "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W"
    assert result.status == "active"
    assert result.consent_notice_version == "2.0"
    assert result.consent_notice_hash is not None
    assert result.consent_proof is not None
    assert result.consent_proof["type"] == "JWS-EdDSA"
    assert result.consent_proof["alg"] == "EdDSA"
    assert result.consent_proof["kid"] == "ed25519-2026-09"
    assert result.consent_proof.get("keyPersistence") == "persistent"
    assert result.consent_proof["jwksUri"] == "https://issuer.example/.well-known/jwks.json"
    assert result.consent_proof["signedAt"] == "2026-09-30T10:15:00.000Z"
    # Create sends none of these.
    assert result.purposes is None
    assert result.scopes is None
    assert result.consent_given_at is None

    body = json.loads(route.calls[0].request.content)
    assert body["grantId"] == "grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V"
    assert body["consentNoticeVersion"] == "2.0"
    assert body["purposes"] == [
        {"code": "analytics", "description": "Usage analytics for service improvement"}
    ]


@respx.mock
def test_get_consent_record_has_no_proof(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records/crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W").mock(
        return_value=httpx.Response(200, json=fx("consentRecord_200"))
    )
    result = client.dpdp.get_consent_record("crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W")

    assert result.data_principal_id == "user_123"
    assert result.consent_proof is None
    assert result.consent_notice_hash is None
    assert result.purposes is not None
    assert result.purposes[0]["code"] == "analytics"
    assert result.purposes[0]["description"] == "Usage analytics for service improvement"
    assert result.scopes == ["read:profile", "write:preferences"]
    assert result.data_fiduciary_name == "Acme Health"
    assert result.consent_given_at == "2026-09-30T10:15:00.000Z"


@respx.mock
def test_get_erased_legacy_record(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records/crec_01J9Z0AAAAAAAAAAAAAAAAAAAA").mock(
        return_value=httpx.Response(200, json=fx("consentRecord_erased_legacy_200"))
    )
    result = client.dpdp.get_consent_record("crec_01J9Z0AAAAAAAAAAAAAAAAAAAA")

    assert result.status == "erased"
    assert result.erased_at == "2026-09-29T12:00:00.000Z"
    assert result.consent_notice_version is None
    assert result.access_count == 3


@respx.mock
def test_list_consent_records_no_filter(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records").mock(
        return_value=httpx.Response(200, json=fx("listConsentRecords_200"))
    )
    result = client.dpdp.list_consent_records()

    assert result.total_records == 7
    assert len(result.records) == 2
    assert result.next_cursor is not None
    assert result.next_cursor.startswith("eyJ")


@respx.mock
def test_list_consent_records_with_principal(client: Grantex) -> None:
    route = respx.get(url__regex=r"/v1/dpdp/consent-records\?").mock(
        return_value=httpx.Response(200, json=fx("listConsentRecords_200"))
    )
    result = client.dpdp.list_consent_records(principal_id="user_abc")

    assert result.total_records == 7
    assert _query(route) == {"dataPrincipalId": ["user_abc"]}


@respx.mock
def test_list_consent_records_pagination(client: Grantex) -> None:
    route = respx.get(url__regex=r"/v1/dpdp/consent-records\?").mock(
        return_value=httpx.Response(200, json=fx("listConsentRecords_200"))
    )
    client.dpdp.list_consent_records(
        data_principal_id="user_123", limit=2, cursor="eyJ0Ijo+/="
    )

    assert _query(route) == {
        "dataPrincipalId": ["user_123"],
        "limit": ["2"],
        "cursor": ["eyJ0Ijo+/="],
    }


# ── Withdraw Consent ─────────────────────────────────────────────────────────


@respx.mock
def test_withdraw_consent(client: Grantex) -> None:
    route = respx.post(
        f"{BASE}/v1/dpdp/consent-records/crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W/withdraw"
    ).mock(return_value=httpx.Response(200, json=fx("withdrawConsent_200")))
    result = client.dpdp.withdraw_consent(
        "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W",
        reason="User requested",
        revoke_grant=True,
        delete_processed_data=True,
    )

    assert result.record_id == "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W"
    assert result.status == "withdrawn"
    assert result.grant_revoked is True
    assert result.data_deleted is False
    assert result.data_deletion_requested is True

    body = json.loads(route.calls[0].request.content)
    assert body == {
        "reason": "User requested",
        "revokeGrant": True,
        "deleteProcessedData": True,
    }


@respx.mock
def test_withdraw_consent_minimal(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=fx("withdrawConsent_200"))
    )
    client.dpdp.withdraw_consent("cr_01", reason="Changed mind")

    body = json.loads(route.calls[0].request.content)
    assert body == {"reason": "Changed mind"}


@respx.mock
def test_withdraw_consent_explicit_false_is_sent(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=fx("withdrawConsent_200"))
    )
    client.dpdp.withdraw_consent(
        "cr_01", reason="r", revoke_grant=False, delete_processed_data=False
    )

    body = json.loads(route.calls[0].request.content)
    assert body == {"reason": "r", "revokeGrant": False, "deleteProcessedData": False}


@respx.mock
def test_withdraw_consent_delete_data_alias_is_deprecated(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=fx("withdrawConsent_200"))
    )
    with pytest.warns(DeprecationWarning, match="delete_processed_data"):
        client.dpdp.withdraw_consent("cr_01", reason="r", delete_data=True)

    body = json.loads(route.calls[0].request.content)
    assert body["deleteProcessedData"] is True


def test_withdraw_consent_conflicting_delete_flags(client: Grantex) -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        with pytest.raises(ValueError, match="delete_data"):
            client.dpdp.withdraw_consent(
                "cr_01", reason="r", delete_data=True, delete_processed_data=False
            )


@respx.mock
def test_withdraw_consent_matching_delete_flags_allowed(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-records/cr_01/withdraw").mock(
        return_value=httpx.Response(200, json=fx("withdrawConsent_200"))
    )
    with pytest.warns(DeprecationWarning):
        client.dpdp.withdraw_consent(
            "cr_01", reason="r", delete_data=True, delete_processed_data=True
        )
    assert json.loads(route.calls[0].request.content)["deleteProcessedData"] is True


# ── Data Principal Rights ────────────────────────────────────────────────────


@respx.mock
def test_list_principal_records(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/data-principals/user_123/records").mock(
        return_value=httpx.Response(200, json=fx("principalRecords_200"))
    )
    result = client.dpdp.list_principal_records("user_123")

    assert result.data_principal_id == "user_123"
    assert result.total_records == 1
    assert result.next_cursor is None
    assert result.records[0].record_id == "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W"


@respx.mock
def test_list_principal_records_without_per_record_principal(client: Grantex) -> None:
    """Older servers omit dataPrincipalId on each record: no KeyError, and the
    top-level principal fills it."""
    body = fx("principalRecords_200")
    for record in body["records"]:
        del record["dataPrincipalId"]
    respx.get(f"{BASE}/v1/dpdp/data-principals/user_123/records").mock(
        return_value=httpx.Response(200, json=body)
    )
    result = client.dpdp.list_principal_records("user_123")

    assert result.records[0].data_principal_id == "user_123"


@respx.mock
def test_list_principal_records_pagination(client: Grantex) -> None:
    route = respx.get(url__regex=r"/v1/dpdp/data-principals/user_123/records\?").mock(
        return_value=httpx.Response(200, json=fx("principalRecords_200"))
    )
    client.dpdp.list_principal_records("user_123", limit=10, cursor="c1")

    assert _query(route) == {"limit": ["10"], "cursor": ["c1"]}


@respx.mock
def test_request_erasure(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/data-principals/user_123/erasure").mock(
        return_value=httpx.Response(201, json=fx("erasure_201"))
    )
    result = client.dpdp.request_erasure("user_123")

    assert result.request_id == "ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R"
    assert result.status == "completed"
    assert result.records_erased == 2
    assert result.grants_revoked == 1
    assert result.delegated_grants_revoked == 0
    assert result.grievances_redacted == 0
    assert result.exports_deleted == 0
    assert result.completed_at == "2026-09-30T14:00:00.120Z"
    assert result.expected_completion_by == "2026-09-30T14:00:00.120Z"
    assert [r["category"] for r in result.retained] == [
        "consent_records", "audit_log", "grievances", "stored_exports", "fiduciary_data",
    ]
    assert result.retained[3].get("count") == 1
    assert result.retained[0]["category"] == "consent_records"
    assert result.retained[0].get("count") == 2
    assert "count" not in result.retained[1]

    request = route.calls[0].request
    assert request.content == b""
    assert "content-type" not in request.headers


@respx.mock
def test_get_erasure_request(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/erasure-requests/ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R").mock(
        return_value=httpx.Response(200, json=fx("erasure_201"))
    )
    result = client.dpdp.get_erasure_request("ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R")

    assert result.records_erased == 2


# ── Consent Notices ──────────────────────────────────────────────────────────


@respx.mock
def test_create_consent_notice(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/consent-notices").mock(
        return_value=httpx.Response(201, json=fx("createConsentNotice_201"))
    )
    result = client.dpdp.create_consent_notice(
        CreateConsentNoticeParams(
            notice_id="privacy-notice",
            version="2.0",
            title="Data Processing Consent Notice",
            content="We collect and process your data for the following purposes...",
            purposes=[{"code": "analytics", "description": "Usage analytics"}],
            language="en",
            grievance_officer={
                "name": "Grievance Officer",
                "email": "grievance@acme.example",
                "phone": "+91-00000-00000",
            },
        )
    )

    assert result.id == "notice_01J9ZA1B2C3D4E5F6G7H8J9K0M"
    assert result.notice_id == "privacy-notice"
    assert result.version == "2.0"
    assert result.language == "en"

    body = json.loads(route.calls[0].request.content)
    assert body["noticeId"] == "privacy-notice"
    assert body["language"] == "en"
    assert body["grievanceOfficer"]["phone"] == "+91-00000-00000"


@respx.mock
def test_list_consent_notices(client: Grantex) -> None:
    route = respx.get(url__regex=r"/v1/dpdp/consent-notices\?").mock(
        return_value=httpx.Response(200, json=fx("listConsentNotices_200"))
    )
    result = client.dpdp.list_consent_notices(limit=5, cursor="c2")

    assert result.notices[0].title == "Data Processing Consent Notice"
    assert result.notices[0].notice_id == "privacy-notice"
    assert result.next_cursor is None
    assert _query(route) == {"limit": ["5"], "cursor": ["c2"]}


@respx.mock
def test_get_consent_notice(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-notices/privacy-notice").mock(
        return_value=httpx.Response(200, json=fx("getConsentNotice_200"))
    )
    result = client.dpdp.get_consent_notice("privacy-notice")

    assert result.notice_id == "privacy-notice"
    assert [v.version for v in result.versions] == ["2.0", "1.0"]
    newest = result.versions[0]
    assert newest.grievance_officer is not None
    assert newest.grievance_officer.get("phone") == "+91-00000-00000"
    assert newest.purposes[0]["code"] == "analytics"
    assert result.versions[1].grievance_officer is None
    assert result.versions[1].data_fiduciary_contact is None


# ── Grievances ───────────────────────────────────────────────────────────────


@respx.mock
def test_file_grievance(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/grievances").mock(
        return_value=httpx.Response(202, json=fx("fileGrievance_202"))
    )
    result = client.dpdp.file_grievance(
        FileGrievanceParams(
            data_principal_id="user_123",
            type="unauthorized-processing",
            description="My data was used for marketing without consent",
            record_id="crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W",
            evidence={"screenshots": ["https://files.example.com/s1.png"]},
            response_period_days=30,
        )
    )

    assert result.grievance_id == "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P"
    assert result.reference_number == "GRV-2026-01J9ZC5D6E7F8G9H0J1K2M3N4Q"
    assert result.status == "submitted"
    assert result.response_period_days == 7

    body = json.loads(route.calls[0].request.content)
    assert body == {
        "dataPrincipalId": "user_123",
        "type": "unauthorized-processing",
        "description": "My data was used for marketing without consent",
        "recordId": "crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W",
        "evidence": {"screenshots": ["https://files.example.com/s1.png"]},
        "responsePeriodDays": 30,
    }


@respx.mock
def test_get_grievance(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/grievances/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P").mock(
        return_value=httpx.Response(200, json=fx("getGrievance_200"))
    )
    result = client.dpdp.get_grievance("grv_01J9ZC5D6E7F8G9H0J1K2M3N4P")

    assert result.status == "in_review"
    assert result.type == "unauthorized-processing"
    assert result.description == "My data was used for marketing without consent"
    assert result.updated_at == "2026-10-01T08:00:00.000Z"
    assert result.response_period_days == 7


@respx.mock
def test_list_grievances(client: Grantex) -> None:
    route = respx.get(url__regex=r"/v1/dpdp/grievances\?").mock(
        return_value=httpx.Response(200, json=fx("listGrievances_200"))
    )
    result = client.dpdp.list_grievances(
        status="submitted", data_principal_id="user_123", limit=20, cursor="c3"
    )

    assert len(result.grievances) == 1
    assert result.grievances[0].description is None
    assert result.next_cursor is None
    assert _query(route) == {
        "status": ["submitted"],
        "dataPrincipalId": ["user_123"],
        "limit": ["20"],
        "cursor": ["c3"],
    }


@respx.mock
def test_update_grievance(client: Grantex) -> None:
    route = respx.patch(f"{BASE}/v1/dpdp/grievances/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P").mock(
        return_value=httpx.Response(200, json=fx("updateGrievance_200"))
    )
    result = client.dpdp.update_grievance(
        "grv_01J9ZC5D6E7F8G9H0J1K2M3N4P",
        status="resolved",
        resolution="Marketing processing stopped and the data principal informed",
    )

    assert result.status == "resolved"
    assert result.resolved_at == "2026-10-02T09:30:00.000Z"
    assert json.loads(route.calls[0].request.content) == {
        "status": "resolved",
        "resolution": "Marketing processing stopped and the data principal informed",
    }


# ── Compliance Exports ───────────────────────────────────────────────────────


@respx.mock
def test_create_export(client: Grantex) -> None:
    route = respx.post(f"{BASE}/v1/dpdp/exports").mock(
        return_value=httpx.Response(201, json=fx("createExport_201"))
    )
    result = client.dpdp.create_export(
        CreateExportParams(
            type="dpdp-audit",
            date_from="2026-09-01T00:00:00.000Z",
            date_to="2026-09-30T23:59:59.999Z",
            format="json",
        )
    )

    assert result.export_id == "exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q"
    assert result.type == "dpdp-audit"
    assert result.status is None
    assert result.record_count == 3
    assert result.truncated is False
    assert result.audit_log_limit == 1000
    assert result.data_principal_id is None
    assert result.data is not None

    body = json.loads(route.calls[0].request.content)
    assert body["type"] == "dpdp-audit"
    assert body["dateTo"] == "2026-09-30T23:59:59.999Z"
    assert body["format"] == "json"


@respx.mock
def test_get_export(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/exports/exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q").mock(
        return_value=httpx.Response(200, json=fx("getExport_200"))
    )
    result = client.dpdp.get_export("exp_01J9ZD6E7F8G9H0J1K2M3N4P5Q")

    assert result.status == "complete"
    assert result.truncated is True
    assert result.record_count == 1001
    assert result.data_principal_id == "user_123"
    assert result.date_to == "2026-09-30T23:59:59.999Z"


def test_dpdp_export_alias() -> None:
    assert DpdpExport is ComplianceExport


# ── Path encoding ────────────────────────────────────────────────────────────


@respx.mock
def test_path_parameters_are_url_encoded(client: Grantex) -> None:
    route = respx.route().mock(return_value=httpx.Response(200, json={}))
    d = client.dpdp
    calls: list[Callable[[], object]] = [
        lambda: d.get_consent_record(TRAVERSAL_ID),
        lambda: d.withdraw_consent(TRAVERSAL_ID, reason="r"),
        lambda: d.list_principal_records(TRAVERSAL_ID),
        lambda: d.request_erasure(TRAVERSAL_ID),
        lambda: d.get_erasure_request(TRAVERSAL_ID),
        lambda: d.get_consent_notice(TRAVERSAL_ID),
        lambda: d.get_grievance(TRAVERSAL_ID),
        lambda: d.update_grievance(TRAVERSAL_ID, status="in_review"),
        lambda: d.get_export(TRAVERSAL_ID),
    ]
    for invoke in calls:
        try:
            invoke()
        except (KeyError, TypeError, AttributeError):
            pass  # the empty body does not decode; only the path matters here

    paths = [c.request.url.raw_path.decode() for c in route.calls]
    assert paths == [
        f"/v1/dpdp/consent-records/{TRAVERSAL_ENC}",
        f"/v1/dpdp/consent-records/{TRAVERSAL_ENC}/withdraw",
        f"/v1/dpdp/data-principals/{TRAVERSAL_ENC}/records",
        f"/v1/dpdp/data-principals/{TRAVERSAL_ENC}/erasure",
        f"/v1/dpdp/erasure-requests/{TRAVERSAL_ENC}",
        f"/v1/dpdp/consent-notices/{TRAVERSAL_ENC}",
        f"/v1/dpdp/grievances/{TRAVERSAL_ENC}",
        f"/v1/dpdp/grievances/{TRAVERSAL_ENC}",
        f"/v1/dpdp/exports/{TRAVERSAL_ENC}",
    ]


# ── No auto-retry on non-idempotent writes ──────────────────────────────────────────────────


_WRITES: list[tuple[str, str, str, Callable[[Grantex], object]]] = [
    (
        "create_consent_record", "POST", "/v1/dpdp/consent-records",
        lambda g: g.dpdp.create_consent_record(
            CreateConsentRecordParams(
                grant_id="g", data_principal_id="p",
                purposes=[{"code": "c", "description": "d"}],
                consent_notice_id="n", processing_expires_at="2027-01-01T00:00:00.000Z",
            )
        ),
    ),
    (
        "withdraw_consent", "POST", "/v1/dpdp/consent-records/r/withdraw",
        lambda g: g.dpdp.withdraw_consent("r", reason="x"),
    ),
    (
        "create_consent_notice", "POST", "/v1/dpdp/consent-notices",
        lambda g: g.dpdp.create_consent_notice(
            CreateConsentNoticeParams(
                notice_id="n", version="1", title="t", content="c",
                purposes=[{"code": "c", "description": "d"}],
            )
        ),
    ),
    (
        "file_grievance", "POST", "/v1/dpdp/grievances",
        lambda g: g.dpdp.file_grievance(
            FileGrievanceParams(data_principal_id="p", type="t", description="d")
        ),
    ),
    (
        "update_grievance", "PATCH", "/v1/dpdp/grievances/grv",
        lambda g: g.dpdp.update_grievance("grv", status="in_review"),
    ),
    (
        "create_export", "POST", "/v1/dpdp/exports",
        lambda g: g.dpdp.create_export(
            CreateExportParams(type="dpdp-audit", date_from="a", date_to="b")
        ),
    ),
]


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("grantex._http.time.sleep", lambda _s: None)


@pytest.mark.parametrize("name,method,path,invoke", _WRITES, ids=[w[0] for w in _WRITES])
@respx.mock
def test_write_not_retried_after_503(
    no_sleep: None, name: str, method: str, path: str,
    invoke: Callable[[Grantex], object],
) -> None:
    route = respx.route(method=method, url=f"{BASE}{path}").mock(
        return_value=httpx.Response(503, json=err_fx("503_CONSENT_PROOF_UNAVAILABLE"))
    )
    client = Grantex(api_key="test-key", max_retries=3)
    with pytest.raises(GrantexApiError) as exc:
        invoke(client)
    assert exc.value.status_code == 503
    assert route.call_count == 1


@pytest.mark.parametrize("name,method,path,invoke", _WRITES, ids=[w[0] for w in _WRITES])
@respx.mock
def test_write_not_retried_after_timeout(
    no_sleep: None, name: str, method: str, path: str,
    invoke: Callable[[Grantex], object],
) -> None:
    route = respx.route(method=method, url=f"{BASE}{path}").mock(
        side_effect=httpx.ReadTimeout("timed out")
    )
    client = Grantex(api_key="test-key", max_retries=3)
    with pytest.raises(GrantexNetworkError):
        invoke(client)
    assert route.call_count == 1


@respx.mock
def test_request_erasure_retries_transient_503(no_sleep: None) -> None:
    """Erasure is idempotent on the server (a replay returns the earlier
    request), so it keeps the client's normal retry behaviour."""
    route = respx.post(f"{BASE}/v1/dpdp/data-principals/user_123/erasure").mock(
        side_effect=[
            httpx.Response(503, json=err_fx("503_CONSENT_PROOF_UNAVAILABLE")),
            httpx.Response(201, json=fx("erasure_201")),
        ]
    )
    client = Grantex(api_key="test-key", max_retries=1)
    result = client.dpdp.request_erasure("user_123")
    assert result.request_id == "ER-2026-01J9ZE7F8G9H0J1K2M3N4P5Q6R"
    assert route.call_count == 2


@respx.mock
def test_get_still_retries_503(no_sleep: None) -> None:
    route = respx.get(f"{BASE}/v1/dpdp/grievances/grv_01J9ZC5D6E7F8G9H0J1K2M3N4P").mock(
        side_effect=[
            httpx.Response(503, json={"message": "unavailable"}),
            httpx.Response(200, json=fx("getGrievance_200")),
        ]
    )
    client = Grantex(api_key="test-key", max_retries=1)
    result = client.dpdp.get_grievance("grv_01J9ZC5D6E7F8G9H0J1K2M3N4P")
    assert result.status == "in_review"
    assert route.call_count == 2


# ── Error handling ───────────────────────────────────────────────────────────


_ERRORS: list[tuple[str, int, str, str, Callable[[Grantex], object]]] = [
    (
        "404_NOT_FOUND", 404, "GET", "/v1/dpdp/consent-records/crec_unknown",
        lambda g: g.dpdp.get_consent_record("crec_unknown"),
    ),
    (
        "409_ALREADY_WITHDRAWN", 409, "POST", "/v1/dpdp/consent-records/crec_01/withdraw",
        lambda g: g.dpdp.withdraw_consent("crec_01", reason="again"),
    ),
    (
        "410_GONE", 410, "GET", "/v1/dpdp/exports/exp_old",
        lambda g: g.dpdp.get_export("exp_old"),
    ),
    (
        "409_INVALID_TRANSITION", 409, "PATCH", "/v1/dpdp/grievances/grv_01",
        lambda g: g.dpdp.update_grievance("grv_01", status="in_review"),
    ),
    (
        "503_CONSENT_PROOF_KEY_NOT_PERSISTENT", 503, "POST", "/v1/dpdp/consent-records",
        lambda g: g.dpdp.create_consent_record(
            CreateConsentRecordParams(
                grant_id="g", data_principal_id="p",
                purposes=[{"code": "c", "description": "d"}],
                consent_notice_id="n", processing_expires_at="2027-01-01T00:00:00.000Z",
            )
        ),
    ),
]


@pytest.mark.parametrize(
    "name,status,method,path,invoke", _ERRORS, ids=[e[0] for e in _ERRORS]
)
@respx.mock
def test_error_surfaces_status_code_and_request_id(
    client: Grantex, name: str, status: int, method: str, path: str,
    invoke: Callable[[Grantex], object],
) -> None:
    body = err_fx(name)
    respx.route(method=method, url=f"{BASE}{path}").mock(
        return_value=httpx.Response(status, json=body)
    )
    with pytest.raises(GrantexApiError) as exc:
        invoke(client)
    assert exc.value.status_code == status
    assert exc.value.code == body["code"]
    assert str(exc.value) == body["message"]
    assert exc.value.request_id == body["requestId"]


@respx.mock
def test_error_request_id_header_wins(client: Grantex) -> None:
    respx.get(f"{BASE}/v1/dpdp/consent-records/x").mock(
        return_value=httpx.Response(
            404, json=err_fx("404_NOT_FOUND"), headers={"x-request-id": "hdr-1"}
        )
    )
    with pytest.raises(GrantexApiError) as exc:
        client.dpdp.get_consent_record("x")
    assert exc.value.request_id == "hdr-1"


# ── Model tolerance ──────────────────────────────────────────────────────────


def test_models_tolerate_every_fixture() -> None:
    """Every server body decodes into its model without KeyError."""
    g = grantex
    g.ConsentRecord.from_dict(fx("createConsentRecord_201"))
    g.ConsentRecord.from_dict(fx("consentRecord_200"))
    g.ConsentRecord.from_dict(fx("consentRecord_erased_legacy_200"))
    g.ListConsentRecordsResponse.from_dict(fx("listConsentRecords_200"))
    g.PrincipalRecordsResponse.from_dict(fx("principalRecords_200"))
    g.WithdrawConsentResponse.from_dict(fx("withdrawConsent_200"))
    g.ConsentNotice.from_dict(fx("createConsentNotice_201"))
    g.ListConsentNoticesResponse.from_dict(fx("listConsentNotices_200"))
    g.ConsentNoticeDetail.from_dict(fx("getConsentNotice_200"))
    g.Grievance.from_dict(fx("fileGrievance_202"))
    g.ListGrievancesResponse.from_dict(fx("listGrievances_200"))
    g.Grievance.from_dict(fx("getGrievance_200"))
    g.Grievance.from_dict(fx("updateGrievance_200"))
    g.ComplianceExport.from_dict(fx("createExport_201"))
    g.ComplianceExport.from_dict(fx("getExport_200"))
    g.ErasureResponse.from_dict(fx("erasure_201"))

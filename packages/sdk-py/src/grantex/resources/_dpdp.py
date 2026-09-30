"""DPDP (Digital Personal Data Protection) client.

India's DPDP Act 2023 endpoints: consent records and withdrawal (s.6(4)),
consent notices (s.5), the rights to access (s.11) and erasure (s.12),
grievance redressal (s.13), and compliance exports.

Writes (POST/PATCH) other than erasure are sent exactly once: they are not
idempotent, and a replay after a timeout or 5xx would duplicate a record,
grievance, notice or export, or fail with a spurious 409. Erasure is
idempotent on the server (a replay returns the earlier request), so it and the
reads keep the client's retry behaviour.
"""
from __future__ import annotations

import warnings
from typing import Literal
from urllib.parse import quote, urlencode

from .._http import HttpClient
from .._types import (
    ComplianceExport,
    ConsentNotice,
    ConsentNoticeDetail,
    ConsentRecord,
    CreateConsentNoticeParams,
    CreateConsentRecordParams,
    CreateExportParams,
    ErasureResponse,
    FileGrievanceParams,
    Grievance,
    GrievanceStatus,
    ListConsentNoticesResponse,
    ListConsentRecordsResponse,
    ListGrievancesResponse,
    PrincipalRecordsResponse,
    WithdrawConsentResponse,
)


def _seg(value: str) -> str:
    """Encode one path segment (``/``, ``?``, ``#``, ``%`` and ``..`` included)."""
    return quote(value, safe="")


def _query(params: dict[str, str | int | None]) -> str:
    items = {k: str(v) for k, v in params.items() if v is not None and v != ""}
    return f"?{urlencode(items)}" if items else ""


class DpdpClient:
    """Client for DPDP Act endpoints."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # ── Consent records ───────────────────────────────────────────────────

    def create_consent_record(
        self, params: CreateConsentRecordParams
    ) -> ConsentRecord:
        """Record consent for a grant. Only this response carries
        ``consent_proof`` and ``consent_notice_hash``.

        POST /v1/dpdp/consent-records
        """
        data = self._http.post(
            "/v1/dpdp/consent-records", params.to_dict(), retry=False
        )
        return ConsentRecord.from_dict(data)

    def get_consent_record(self, record_id: str) -> ConsentRecord:
        """Fetch a single consent record by ID.

        GET /v1/dpdp/consent-records/:recordId
        """
        data = self._http.get(f"/v1/dpdp/consent-records/{_seg(record_id)}")
        return ConsentRecord.from_dict(data)

    def list_consent_records(
        self,
        principal_id: str | None = None,
        *,
        data_principal_id: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> ListConsentRecordsResponse:
        """List consent records, newest first, optionally for one data principal.

        ``limit`` is 1..200 (server default 50); pass the previous page's
        ``next_cursor`` as ``cursor``. Without ``limit`` or ``cursor`` the
        server does not paginate: it returns the newest 100 records (every
        match when filtered by principal) and ``next_cursor`` is ``None``. ``principal_id`` is the original
        positional form of ``data_principal_id``.

        GET /v1/dpdp/consent-records
        """
        if (
            principal_id is not None
            and data_principal_id is not None
            and principal_id != data_principal_id
        ):
            raise ValueError("principal_id and data_principal_id disagree")
        principal = data_principal_id if data_principal_id is not None else principal_id
        qs = _query({"dataPrincipalId": principal, "limit": limit, "cursor": cursor})
        data = self._http.get(f"/v1/dpdp/consent-records{qs}")
        return ListConsentRecordsResponse.from_dict(data)

    def withdraw_consent(
        self,
        record_id: str,
        reason: str,
        revoke_grant: bool | None = None,
        delete_data: bool | None = None,
        *,
        delete_processed_data: bool | None = None,
    ) -> WithdrawConsentResponse:
        """Withdraw consent (DPDP Act s.6(4)).

        ``revoke_grant`` and ``delete_processed_data`` are sent only when
        given, so the server default applies otherwise.
        ``delete_processed_data`` records a deletion request for the Data
        Fiduciary. ``delete_data`` is a deprecated alias for it.

        POST /v1/dpdp/consent-records/:recordId/withdraw
        """
        if delete_data is not None:
            warnings.warn(
                "withdraw_consent(delete_data=...) is deprecated; "
                "use delete_processed_data=...",
                DeprecationWarning,
                stacklevel=2,
            )
            if delete_processed_data is not None and delete_processed_data != delete_data:
                raise ValueError(
                    "delete_data and delete_processed_data disagree; "
                    "pass only delete_processed_data"
                )
            if delete_processed_data is None:
                delete_processed_data = delete_data

        body: dict[str, object] = {"reason": reason}
        if revoke_grant is not None:
            body["revokeGrant"] = revoke_grant
        if delete_processed_data is not None:
            body["deleteProcessedData"] = delete_processed_data
        data = self._http.post(
            f"/v1/dpdp/consent-records/{_seg(record_id)}/withdraw", body, retry=False
        )
        return WithdrawConsentResponse.from_dict(data)

    # ── Data principal rights ─────────────────────────────────────────────

    def list_principal_records(
        self,
        principal_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> PrincipalRecordsResponse:
        """A data principal's consent records (right to access, DPDP Act s.11).

        GET /v1/dpdp/data-principals/:principalId/records
        """
        qs = _query({"limit": limit, "cursor": cursor})
        data = self._http.get(
            f"/v1/dpdp/data-principals/{_seg(principal_id)}/records{qs}"
        )
        return PrincipalRecordsResponse.from_dict(data)

    def request_erasure(self, principal_id: str) -> ErasureResponse:
        """Erase a data principal's personal data (right to erasure, DPDP Act
        s.12). Idempotent on the server: a repeat returns the earlier request,
        so a transient failure is retried like a read.

        POST /v1/dpdp/data-principals/:principalId/erasure (no body)
        """
        data = self._http.post(f"/v1/dpdp/data-principals/{_seg(principal_id)}/erasure")
        return ErasureResponse.from_dict(data)

    def get_erasure_request(self, request_id: str) -> ErasureResponse:
        """Fetch an erasure request by ID.

        GET /v1/dpdp/erasure-requests/:requestId
        """
        data = self._http.get(f"/v1/dpdp/erasure-requests/{_seg(request_id)}")
        return ErasureResponse.from_dict(data)

    # ── Consent notices ───────────────────────────────────────────────────

    def create_consent_notice(
        self, params: CreateConsentNoticeParams
    ) -> ConsentNotice:
        """Register a consent notice version (DPDP Act s.5).

        POST /v1/dpdp/consent-notices
        """
        data = self._http.post(
            "/v1/dpdp/consent-notices", params.to_dict(), retry=False
        )
        return ConsentNotice.from_dict(data)

    def list_consent_notices(
        self, *, limit: int | None = None, cursor: str | None = None
    ) -> ListConsentNoticesResponse:
        """List consent notice versions, newest first.

        GET /v1/dpdp/consent-notices
        """
        qs = _query({"limit": limit, "cursor": cursor})
        data = self._http.get(f"/v1/dpdp/consent-notices{qs}")
        return ListConsentNoticesResponse.from_dict(data)

    def get_consent_notice(self, notice_id: str) -> ConsentNoticeDetail:
        """Every version of a consent notice, newest first.

        GET /v1/dpdp/consent-notices/:noticeId
        """
        data = self._http.get(f"/v1/dpdp/consent-notices/{_seg(notice_id)}")
        return ConsentNoticeDetail.from_dict(data)

    # ── Grievances ────────────────────────────────────────────────────────

    def file_grievance(self, params: FileGrievanceParams) -> Grievance:
        """File a grievance (DPDP Act s.13).

        POST /v1/dpdp/grievances
        """
        data = self._http.post("/v1/dpdp/grievances", params.to_dict(), retry=False)
        return Grievance.from_dict(data)

    def get_grievance(self, grievance_id: str) -> Grievance:
        """Get a grievance by ID.

        GET /v1/dpdp/grievances/:grievanceId
        """
        data = self._http.get(f"/v1/dpdp/grievances/{_seg(grievance_id)}")
        return Grievance.from_dict(data)

    def list_grievances(
        self,
        *,
        status: GrievanceStatus | None = None,
        data_principal_id: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> ListGrievancesResponse:
        """List grievances, newest first. Items omit description and evidence.

        GET /v1/dpdp/grievances
        """
        qs = _query(
            {
                "status": status,
                "dataPrincipalId": data_principal_id,
                "limit": limit,
                "cursor": cursor,
            }
        )
        data = self._http.get(f"/v1/dpdp/grievances{qs}")
        return ListGrievancesResponse.from_dict(data)

    def update_grievance(
        self,
        grievance_id: str,
        status: Literal["in_review", "resolved", "rejected"],
        resolution: str | None = None,
    ) -> Grievance:
        """Move a grievance: submitted -> in_review -> resolved | rejected.
        ``resolution`` is required for ``resolved`` and ``rejected``.

        PATCH /v1/dpdp/grievances/:grievanceId
        """
        body: dict[str, object] = {"status": status}
        if resolution is not None:
            body["resolution"] = resolution
        data = self._http.patch(
            f"/v1/dpdp/grievances/{_seg(grievance_id)}", body, retry=False
        )
        return Grievance.from_dict(data)

    # ── Compliance exports ────────────────────────────────────────────────

    def create_export(self, params: CreateExportParams) -> ComplianceExport:
        """Generate a compliance export (DPDP audit, GDPR Article 15, EU AI Act).

        POST /v1/dpdp/exports
        """
        data = self._http.post("/v1/dpdp/exports", params.to_dict(), retry=False)
        return ComplianceExport.from_dict(data)

    def get_export(self, export_id: str) -> ComplianceExport:
        """Get an export by ID. An expired export fails with 410 ``GONE``.

        GET /v1/dpdp/exports/:exportId
        """
        data = self._http.get(f"/v1/dpdp/exports/{_seg(export_id)}")
        return ComplianceExport.from_dict(data)

"""DPDP (Digital Personal Data Protection) client.

India's DPDP Act 2023 compliance -- consent records, data principal rights,
grievances, consent notices, and compliance exports.
"""
from __future__ import annotations

from .._http import HttpClient
from .._types import (
    CreateConsentRecordParams,
    ConsentRecord,
    ListConsentRecordsResponse,
    WithdrawConsentResponse,
    PrincipalRecordsResponse,
    ErasureResponse,
    CreateConsentNoticeParams,
    ConsentNotice,
    FileGrievanceParams,
    Grievance,
    CreateExportParams,
    ComplianceExport,
)


class DpdpClient:
    """Client for DPDP Act compliance endpoints."""

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create_consent_record(
        self, params: CreateConsentRecordParams
    ) -> ConsentRecord:
        """Create a DPDP consent record linked to a Grantex grant.

        POST /v1/dpdp/consent-records
        """
        data = self._http.post("/v1/dpdp/consent-records", params.to_dict())
        return ConsentRecord.from_dict(data)

    def get_consent_record(self, record_id: str) -> ConsentRecord:
        """Fetch a single consent record by ID.

        GET /v1/dpdp/consent-records/:recordId
        """
        data = self._http.get(f"/v1/dpdp/consent-records/{record_id}")
        return ConsentRecord.from_dict(data)

    def list_consent_records(
        self, principal_id: str | None = None
    ) -> ListConsentRecordsResponse:
        """List consent records, optionally filtered by data principal.

        GET /v1/dpdp/consent-records
        """
        path = "/v1/dpdp/consent-records"
        if principal_id is not None:
            from urllib.parse import urlencode

            path = f"{path}?{urlencode({'dataPrincipalId': principal_id})}"
        data = self._http.get(path)
        return ListConsentRecordsResponse.from_dict(data)

    def withdraw_consent(
        self,
        record_id: str,
        reason: str,
        revoke_grant: bool = False,
        delete_data: bool = False,
    ) -> WithdrawConsentResponse:
        """Withdraw consent for a consent record.

        POST /v1/dpdp/consent-records/:recordId/withdraw
        """
        body: dict[str, object] = {"reason": reason}
        if revoke_grant:
            body["revokeGrant"] = True
        if delete_data:
            body["deleteProcessedData"] = True
        data = self._http.post(
            f"/v1/dpdp/consent-records/{record_id}/withdraw", body
        )
        return WithdrawConsentResponse.from_dict(data)

    def list_principal_records(
        self, principal_id: str
    ) -> PrincipalRecordsResponse:
        """List all consent records for a data principal (right to access).

        GET /v1/dpdp/data-principals/:principalId/records
        """
        data = self._http.get(
            f"/v1/dpdp/data-principals/{principal_id}/records"
        )
        return PrincipalRecordsResponse.from_dict(data)

    def request_erasure(self, principal_id: str) -> ErasureResponse:
        """Submit a data erasure request for a data principal.

        POST /v1/dpdp/data-principals/:principalId/erasure
        """
        data = self._http.post(
            f"/v1/dpdp/data-principals/{principal_id}/erasure",
            {"dataPrincipalId": principal_id},
        )
        return ErasureResponse.from_dict(data)

    def create_consent_notice(
        self, params: CreateConsentNoticeParams
    ) -> ConsentNotice:
        """Register a consent notice version.

        POST /v1/dpdp/consent-notices
        """
        data = self._http.post("/v1/dpdp/consent-notices", params.to_dict())
        return ConsentNotice.from_dict(data)

    def file_grievance(self, params: FileGrievanceParams) -> Grievance:
        """File a grievance under DPDP section 13(6).

        POST /v1/dpdp/grievances
        """
        data = self._http.post("/v1/dpdp/grievances", params.to_dict())
        return Grievance.from_dict(data)

    def get_grievance(self, grievance_id: str) -> Grievance:
        """Get grievance status by ID.

        GET /v1/dpdp/grievances/:grievanceId
        """
        data = self._http.get(f"/v1/dpdp/grievances/{grievance_id}")
        return Grievance.from_dict(data)

    def create_export(self, params: CreateExportParams) -> ComplianceExport:
        """Generate a compliance export (DPDP, GDPR Article 15, EU AI Act).

        POST /v1/dpdp/exports
        """
        data = self._http.post("/v1/dpdp/exports", params.to_dict())
        return ComplianceExport.from_dict(data)

    def get_export(self, export_id: str) -> ComplianceExport:
        """Get export status and data by ID.

        GET /v1/dpdp/exports/:exportId
        """
        data = self._http.get(f"/v1/dpdp/exports/{export_id}")
        return ComplianceExport.from_dict(data)

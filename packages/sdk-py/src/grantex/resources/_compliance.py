from __future__ import annotations

from urllib.parse import urlencode

from .._http import HttpClient
from .._types import (
    ComplianceAuditExport,
    ComplianceExportAuditParams,
    ComplianceExportGrantsParams,
    ComplianceGrantsExport,
    ComplianceSummary,
)


class ComplianceClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def get_summary(
        self,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> ComplianceSummary:
        """Get an org-wide compliance summary (agents, grants, audit, policies, plan)."""
        params: dict[str, str] = {}
        if since is not None:
            params["since"] = since
        if until is not None:
            params["until"] = until
        qs = urlencode(params)
        path = f"/v1/compliance/summary?{qs}" if qs else "/v1/compliance/summary"
        data = self._http.get(path)
        return ComplianceSummary.from_dict(data)

    def export_grants(
        self,
        params: ComplianceExportGrantsParams | None = None,
    ) -> ComplianceGrantsExport:
        """Export all grants (optionally filtered)."""
        qs = urlencode(params.to_dict()) if params else ""
        path = f"/v1/compliance/export/grants?{qs}" if qs else "/v1/compliance/export/grants"
        data = self._http.get(path)
        return ComplianceGrantsExport.from_dict(data)

    def export_audit(
        self,
        params: ComplianceExportAuditParams | None = None,
    ) -> ComplianceAuditExport:
        """Export all audit entries (optionally filtered)."""
        qs = urlencode(params.to_dict()) if params else ""
        path = f"/v1/compliance/export/audit?{qs}" if qs else "/v1/compliance/export/audit"
        data = self._http.get(path)
        return ComplianceAuditExport.from_dict(data)

"""Auth service evidence endpoints (spec/evidence-package.md, "Producing evidence")."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence
from urllib.parse import quote

import httpx

__all__ = ["EvidenceApiError", "ExportedPackage", "export_package", "record_evidence", "void_record"]

_ROOT = re.compile(r"sha256:[0-9a-f]{64}\Z")
_AUDIT_HASH = re.compile(r"[0-9a-f]{64}\Z")
MAX_RECORDS_PER_REQUEST = 100


class EvidenceApiError(Exception):
    """The auth service refused or failed an evidence request."""

    def __init__(self, status: int, code: str, message: str, field_path: Optional[str] = None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.field_path = field_path


@dataclass(frozen=True)
class ExportedPackage:
    """An exported package as returned by the auth service.

    ``root`` and ``anchor_hash`` come from response headers. They let the
    caller record what the service anchored; an auditor verifying later should
    take the root from the audit log rather than from the package's sender.
    """

    data: bytes
    root: str
    anchor_hash: Optional[str]


def _url(base_url: str, case_id: str, action: str) -> str:
    if not case_id:
        raise ValueError("case_id is required")
    return f"{base_url.rstrip('/')}/v1/evidence/cases/{quote(case_id, safe='')}/{action}"


def _raise_for(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    code = "HTTP_ERROR"
    message = response.reason_phrase or "request failed"
    field_path: Optional[str] = None
    try:
        body = response.json()
        if isinstance(body, dict):
            code = str(body.get("code", code))
            message = str(body.get("message", message))
            path = body.get("field_path")
            field_path = path if isinstance(path, str) else None
    except ValueError:
        pass
    raise EvidenceApiError(response.status_code, code, message, field_path)


def export_package(
    case_id: str,
    *,
    base_url: str,
    api_key: str,
    disclose: Iterable[str] = (),
    sign: bool = False,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
) -> ExportedPackage:
    """Export the evidence package of a case (``POST /v1/evidence/cases/{id}/export``)."""
    body: Dict[str, Any] = {"disclose": sorted(set(disclose)), "sign": sign}
    with httpx.Client(timeout=timeout, transport=transport) as client:
        response = client.post(
            _url(base_url, case_id, "export"),
            json=body,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        )
    _raise_for(response)
    root = response.headers.get("grantex-evidence-root", "")
    if not _ROOT.match(root):
        raise EvidenceApiError(response.status_code, "EVIDENCE_ROOT_HEADER_INVALID", "response has no valid Grantex-Evidence-Root header")
    anchor = response.headers.get("grantex-evidence-anchor")
    if anchor is not None and not _AUDIT_HASH.match(anchor):
        raise EvidenceApiError(response.status_code, "EVIDENCE_ANCHOR_HEADER_INVALID", "Grantex-Evidence-Anchor header is malformed")
    return ExportedPackage(data=response.content, root=root, anchor_hash=anchor)


def record_evidence(
    case_id: str,
    records: Sequence[Mapping[str, Any]],
    *,
    base_url: str,
    api_key: str,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
) -> List[Dict[str, Any]]:
    """Append evidence records to a case (``POST /v1/evidence/cases/{id}/records``).

    Sends at most 100 records per request, in order, and returns the audit
    entry id and hash of each record. A refused request raises
    :class:`EvidenceApiError` and nothing from that request is recorded.
    """
    results: List[Dict[str, Any]] = []
    items = [dict(record) for record in records]
    if not items:
        raise ValueError("at least one record is required")
    with httpx.Client(timeout=timeout, transport=transport) as client:
        for start in range(0, len(items), MAX_RECORDS_PER_REQUEST):
            response = client.post(
                _url(base_url, case_id, "records"),
                json={"records": items[start : start + MAX_RECORDS_PER_REQUEST]},
                headers={"Authorization": f"Bearer {api_key}"},
            )
            _raise_for(response)
            body = response.json()
            results.extend(body.get("records", []) if isinstance(body, dict) else [])
    return results


def void_record(
    case_id: str,
    *,
    target_type: str,
    target_id: str,
    reason_code: str,
    base_url: str,
    api_key: str,
    timeout: float = 30.0,
    transport: Optional[httpx.BaseTransport] = None,
) -> Dict[str, Any]:
    """Void a recorded evidence record (``POST /v1/evidence/cases/{id}/void``).

    Nothing is deleted: a ``void`` entry naming the record is appended, and the
    record can no longer be cited.
    """
    with httpx.Client(timeout=timeout, transport=transport) as client:
        response = client.post(
            _url(base_url, case_id, "void"),
            json={"reason_code": reason_code, "target_id": target_id, "target_type": target_type},
            headers={"Authorization": f"Bearer {api_key}"},
        )
    _raise_for(response)
    body = response.json()
    return body if isinstance(body, dict) else {}

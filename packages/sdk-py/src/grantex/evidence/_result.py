"""Verification codes, results and errors for evidence packages."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

__all__ = [
    "VerificationCode",
    "VerificationFailure",
    "VerificationResult",
    "EvidenceBuildError",
]


class VerificationCode:
    """Reason codes a verification can fail with (spec/evidence-package.md)."""

    MISSING_ROOT = "missing_root"
    TOO_LARGE = "too_large"
    MALFORMED_JSON = "malformed_json"
    DUPLICATE_KEY = "duplicate_key"
    NON_CANONICAL_NUMBER = "non_canonical_number"
    NON_CANONICAL_DOCUMENT = "non_canonical_document"
    UNSUPPORTED_FORMAT = "unsupported_format"
    UNSUPPORTED_VERSION = "unsupported_version"
    SCHEMA_VIOLATION = "schema_violation"
    PRIVACY_VIOLATION = "privacy_violation"
    GENESIS_MISMATCH = "genesis_mismatch"
    SEQUENCE_MISMATCH = "sequence_mismatch"
    LINK_MISMATCH = "link_mismatch"
    ENTRY_HASH_MISMATCH = "entry_hash_mismatch"
    HEAD_MISMATCH = "head_mismatch"
    LENGTH_MISMATCH = "length_mismatch"
    ROOT_MISMATCH = "root_mismatch"
    GRANT_CHAIN_BROKEN = "grant_chain_broken"
    ENTRIES_OUT_OF_ORDER = "entries_out_of_order"
    DUPLICATE_IDENTIFIER = "duplicate_identifier"
    DANGLING_REFERENCE = "dangling_reference"
    CASE_MISMATCH = "case_mismatch"
    ACTION_HASH_MISMATCH = "action_hash_mismatch"
    DECISION_INCONSISTENT = "decision_inconsistent"
    VALIDITY_VIOLATION = "validity_violation"
    AUTHORITY_VIOLATION = "authority_violation"
    TOOL_CALL_INCONSISTENT = "tool_call_inconsistent"
    ROOT_NOT_TRUSTED = "root_not_trusted"
    ANCHOR_MISSING = "anchor_missing"
    ANCHOR_HASH_MISMATCH = "anchor_hash_mismatch"
    ANCHOR_MISMATCH = "anchor_mismatch"
    ANCHOR_NOT_TRUSTED = "anchor_not_trusted"
    SIGNATURE_MISSING = "signature_missing"
    SIGNATURE_UNVERIFIED = "signature_unverified"
    SIGNATURE_KEY_UNKNOWN = "signature_key_unknown"
    SIGNATURE_INVALID = "signature_invalid"


class VerificationFailure(Exception):
    """The first failed check. Raised internally, reported in the result."""

    def __init__(
        self,
        code: str,
        message: str,
        entry_index: Optional[int] = None,
        field_path: Optional[str] = None,
        expected: Optional[str] = None,
        actual: Optional[str] = None,
    ) -> None:
        super().__init__(code, message)
        self.code = code
        self.message = message
        self.entry_index = entry_index
        self.field_path = field_path
        self.expected = expected
        self.actual = actual

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(frozen=True)
class VerificationResult:
    """Outcome of :func:`verify_package`.

    ``ok`` is true only when every check passed. Otherwise ``code`` names the
    first check that failed and ``entry_index``, ``field_path``, ``expected``
    and ``actual`` locate it where that is meaningful.

    ``anchor_status`` says how far the anchor can be trusted: ``absent``;
    ``internal-consistency-only`` (it matches the package, which anyone able to
    write the package could arrange); ``pinned`` (it equals an anchor hash the
    caller obtained independently); ``signed`` (the service signature covers
    it). ``signature_status`` is ``absent``, ``unchecked`` or ``verified``.
    """

    ok: bool
    code: Optional[str] = None
    message: str = ""
    entry_index: Optional[int] = None
    field_path: Optional[str] = None
    expected: Optional[str] = None
    actual: Optional[str] = None
    root: Optional[str] = None
    entry_count: Optional[int] = None
    anchor_status: str = "absent"
    signature_status: str = "absent"
    signature_kid: Optional[str] = None
    unsourced_inputs: int = 0
    late_entries: int = 0
    tenant_asserted_entries: int = 0
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """JSON-ready form, the same in the Python and TypeScript SDKs."""
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "entry_index": self.entry_index,
            "field_path": self.field_path,
            "expected": self.expected,
            "actual": self.actual,
            "root": self.root,
            "entry_count": self.entry_count,
            "anchor_status": self.anchor_status,
            "signature_status": self.signature_status,
            "signature_kid": self.signature_kid,
            "unsourced_inputs": self.unsourced_inputs,
            "late_entries": self.late_entries,
            "tenant_asserted_entries": self.tenant_asserted_entries,
        }


class EvidenceBuildError(ValueError):
    """A package could not be built from the given input."""

    def __init__(self, code: str, message: str, field_path: Optional[str] = None):
        super().__init__(f"{code}: {message}" + (f" at {field_path}" if field_path else ""))
        self.code = code
        self.field_path = field_path

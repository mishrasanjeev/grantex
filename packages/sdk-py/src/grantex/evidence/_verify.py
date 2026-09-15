"""Evidence package verification (spec/evidence-package.md, "Verification")."""

from __future__ import annotations

import re
from typing import Any, Mapping, Optional

from ._document import DEFAULT_MAX_BYTES, parse_canonical
from ._checks import check_chain, check_privacy, check_semantics
from ._hashing import audit_entry_hash
from ._result import VerificationCode as Code
from ._result import VerificationFailure, VerificationResult
from ._schema import validate
from ._signature import verify_signature

__all__ = ["verify_package", "check_document"]

FORMAT = "grantex-evidence-package"
SUPPORTED_VERSIONS = ("1.0",)
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_AUDIT_HASH = re.compile(r"[0-9a-f]{64}\Z")
_ENTRY_PATH = re.compile(r"entries\[([0-9]+)\]")


def check_document(package: Any) -> None:
    """Run every check that needs only the document (no trust inputs)."""
    if not isinstance(package, dict):
        raise VerificationFailure(
            Code.SCHEMA_VIOLATION, "package must be a JSON object", field_path="$"
        )
    if package.get("format") != FORMAT:
        raise VerificationFailure(
            Code.UNSUPPORTED_FORMAT,
            f"format must be {FORMAT}",
            field_path="format",
            expected=FORMAT,
            actual=package.get("format") if isinstance(package.get("format"), str) else None,
        )
    if package.get("version") not in SUPPORTED_VERSIONS:
        version = package.get("version")
        raise VerificationFailure(
            Code.UNSUPPORTED_VERSION,
            "unsupported package version",
            field_path="version",
            expected=SUPPORTED_VERSIONS[-1],
            actual=version if isinstance(version, str) else None,
        )
    validate(package)
    check_privacy(package)
    check_chain(package)
    check_semantics(package)


def _check_anchor(
    package: Mapping[str, Any],
    expected_anchor_hash: Optional[str],
    require_anchor: bool,
) -> bool:
    anchor = package.get("anchor")
    if anchor is None:
        if require_anchor or expected_anchor_hash is not None:
            raise VerificationFailure(
                Code.ANCHOR_MISSING, "package has no anchor", field_path="anchor"
            )
        return False
    audit = anchor["audit_entry"]
    computed = audit_entry_hash(audit)
    if audit["hash"] != computed:
        raise VerificationFailure(
            Code.ANCHOR_HASH_MISMATCH,
            "anchor audit entry does not match its hash",
            field_path="anchor.audit_entry.hash",
            expected=computed,
            actual=audit["hash"],
        )
    chain = package["chain"]
    case = package["case"]
    metadata = audit["metadata"]
    for path, expected, actual in (
        ("anchor.audit_entry.developerId", case["tenant_id"], audit["developerId"]),
        ("anchor.audit_entry.metadata.case_id", case["case_id"], metadata["case_id"]),
        ("anchor.audit_entry.metadata.entry_count", chain["length"], metadata["entry_count"]),
        ("anchor.audit_entry.metadata.package_root", chain["root"], metadata["package_root"]),
    ):
        if expected != actual:
            raise VerificationFailure(
                Code.ANCHOR_MISMATCH,
                "anchor audit entry records a different package",
                field_path=path,
                expected=str(expected),
                actual=str(actual),
            )
    if expected_anchor_hash is not None and audit["hash"] != expected_anchor_hash:
        raise VerificationFailure(
            Code.ANCHOR_NOT_TRUSTED,
            "anchor audit entry is not the trusted one",
            field_path="anchor.audit_entry.hash",
            expected=expected_anchor_hash,
            actual=audit["hash"],
        )
    return True


def verify_package(
    data: bytes,
    *,
    expected_root: Optional[str],
    expected_anchor_hash: Optional[str] = None,
    require_anchor: bool = False,
    jwks: Optional[Mapping[str, Any]] = None,
    require_signature: bool = False,
    allow_unverified_signature: bool = False,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> VerificationResult:
    """Verify evidence package bytes against a trusted root.

    ``expected_root`` is the package root obtained independently of the
    package (for example from the auth service audit log). Verification fails
    closed: the result is ``ok`` only if every check passes, and otherwise
    names the first failed check and where it failed.
    """
    root: Optional[str] = None
    count: Optional[int] = None
    anchor_checked = False
    signature_checked = False
    try:
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("package data must be bytes")
        if expected_root is None or not _DIGEST.match(expected_root):
            raise VerificationFailure(
                Code.MISSING_ROOT,
                "a trusted root (sha256:<64 hex>) is required to verify a package",
                expected="sha256:<64 lower-case hex digits>",
                actual=expected_root,
            )
        if expected_anchor_hash is not None and not _AUDIT_HASH.match(expected_anchor_hash):
            raise VerificationFailure(
                Code.ANCHOR_NOT_TRUSTED,
                "trusted anchor hash must be 64 lower-case hex digits",
                actual=expected_anchor_hash,
            )
        package = parse_canonical(bytes(data), max_bytes)
        check_document(package)
        root = package["chain"]["root"]
        count = package["chain"]["length"]
        if root != expected_root:
            raise VerificationFailure(
                Code.ROOT_NOT_TRUSTED,
                "package root is not the trusted root",
                field_path="chain.root",
                expected=expected_root,
                actual=root,
            )
        anchor_checked = _check_anchor(package, expected_anchor_hash, require_anchor)
        signature = package.get("signature")
        if signature is None:
            if require_signature:
                raise VerificationFailure(
                    Code.SIGNATURE_MISSING, "package is not signed", field_path="signature"
                )
        elif jwks is None:
            if not allow_unverified_signature:
                raise VerificationFailure(
                    Code.SIGNATURE_UNVERIFIED,
                    "package is signed but no key set was given to verify it",
                    field_path="signature",
                )
        else:
            verify_signature(signature, root, jwks)
            signature_checked = True
    except VerificationFailure as failure:
        entry_index = failure.entry_index
        if entry_index is None and failure.field_path is not None:
            located = _ENTRY_PATH.match(failure.field_path)
            if located:
                entry_index = int(located.group(1))
        return VerificationResult(
            ok=False,
            code=failure.code,
            message=failure.message,
            entry_index=entry_index,
            field_path=failure.field_path,
            expected=failure.expected,
            actual=failure.actual,
            root=root,
            entry_count=count,
            anchor_checked=anchor_checked,
            signature_checked=signature_checked,
        )
    return VerificationResult(
        ok=True,
        message="package verified",
        root=root,
        entry_count=count,
        anchor_checked=anchor_checked,
        signature_checked=signature_checked,
    )

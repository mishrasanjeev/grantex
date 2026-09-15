"""Building evidence packages from case records."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Sequence

from ._canonical import CanonicalizationError, canonicalize
from ._hashing import (
    IDENTIFIER_CLASSES,
    audit_entry_hash,
    chain_root,
    entry_hash,
    header_hash,
    pseudonymise,
)
from ._result import EvidenceBuildError, VerificationFailure
from ._verify import FORMAT, check_document

__all__ = [
    "PrivacySettings",
    "BuiltPackage",
    "build_package",
    "anchor_audit_entry",
    "attach_anchor",
    "attach_signature",
    "serialize_package",
]

_ENTRY_INPUT_MEMBERS = frozenset({"type", "at", "data", "source", "ext"})


@dataclass(frozen=True)
class PrivacySettings:
    """How identifiers appear in a package.

    Identifiers of every class not in ``disclosed`` are replaced by per-case
    pseudonyms computed with ``key`` (at least 32 bytes, never written to the
    package; ``key_id`` names it). Disclosing every class needs no key and
    produces scheme ``none``.
    """

    key: Optional[bytes] = None
    key_id: Optional[str] = None
    disclosed: FrozenSet[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class BuiltPackage:
    """A built package: the document, its canonical bytes and its root."""

    document: Dict[str, Any]
    data: bytes
    root: str


def serialize_package(document: Mapping[str, Any]) -> bytes:
    """The canonical bytes of a package document."""
    return canonicalize(dict(document)).encode("utf-8")


def _privacy_member(privacy: PrivacySettings) -> Dict[str, Any]:
    unknown = set(privacy.disclosed) - set(IDENTIFIER_CLASSES)
    if unknown:
        raise EvidenceBuildError(
            "privacy_violation", f"unknown identifier classes {sorted(unknown)}"
        )
    disclosed = sorted(privacy.disclosed)
    if disclosed == list(IDENTIFIER_CLASSES):
        return {"disclosed": disclosed, "scheme": "none"}
    if privacy.key is None or len(privacy.key) < 32 or not privacy.key_id:
        raise EvidenceBuildError(
            "privacy_violation",
            "pseudonymising identifiers requires a key of at least 32 bytes and a key_id",
        )
    return {"disclosed": disclosed, "key_id": privacy.key_id, "scheme": "hmac-sha256-v1"}


def build_package(
    *,
    case: Mapping[str, Any],
    entries: Sequence[Mapping[str, Any]],
    privacy: PrivacySettings,
) -> BuiltPackage:
    """Build a package from a case header and entry records.

    ``case`` has ``case_id``, ``tenant_id``, ``issuer``, ``state``,
    ``exported_at`` and optionally ``subject`` and ``ext``. Each record has
    ``type``, ``at`` and ``data`` and optionally ``source`` and ``ext``.
    Identifiers are given in the clear and pseudonymised here according to
    ``privacy``. The result is checked with the same rules as verification, so
    an invalid package is refused with :class:`EvidenceBuildError`.
    """
    privacy_member = _privacy_member(privacy)
    disclosed = set(privacy_member["disclosed"])
    case_member = copy.deepcopy(dict(case))
    tenant_id = case_member.get("tenant_id")
    case_id = case_member.get("case_id")

    def protect(cls: str, value: Any) -> Any:
        if cls in disclosed or not isinstance(value, str):
            return value
        if not isinstance(tenant_id, str) or not isinstance(case_id, str):
            raise EvidenceBuildError(
                "schema_violation", "case_id and tenant_id must be strings", "case"
            )
        assert privacy.key is not None
        return pseudonymise(privacy.key, tenant_id, case_id, cls, value)

    if "subject" in case_member:
        case_member["subject"] = protect("subject", case_member["subject"])

    document: Dict[str, Any] = {
        "case": case_member,
        "format": FORMAT,
        "privacy": privacy_member,
        "version": "1.0",
    }
    try:
        previous = header_hash(document)
    except CanonicalizationError as exc:
        raise EvidenceBuildError("schema_violation", str(exc), "case") from None
    genesis = previous

    built_entries: List[Dict[str, Any]] = []
    for index, record in enumerate(entries):
        unknown = set(record) - _ENTRY_INPUT_MEMBERS
        if unknown:
            raise EvidenceBuildError(
                "schema_violation",
                f"unknown record members {sorted(unknown)}",
                f"entries[{index}]",
            )
        entry: Dict[str, Any] = {name: copy.deepcopy(value) for name, value in record.items()}
        data = entry.get("data")
        if isinstance(data, dict):
            if entry.get("type") == "grant" and "principal" in data:
                data["principal"] = protect("principal", data["principal"])
            elif entry.get("type") == "decision":
                if "approver" in data:
                    data["approver"] = protect("approver", data["approver"])
                action = data.get("action")
                if isinstance(action, dict) and "subject" in action:
                    action["subject"] = protect("subject", action["subject"])
        entry["seq"] = index
        entry["prev"] = previous
        try:
            entry["hash"] = entry_hash(entry)
        except CanonicalizationError as exc:
            raise EvidenceBuildError(
                "schema_violation", str(exc), f"entries[{index}]"
            ) from None
        previous = entry["hash"]
        built_entries.append(entry)

    chain: Dict[str, Any] = {
        "alg": "sha256",
        "canonicalization": "RFC8785",
        "genesis": genesis,
        "head": previous,
        "length": len(built_entries),
    }
    chain["root"] = chain_root(chain)
    document["entries"] = built_entries
    document["chain"] = chain

    try:
        check_document(document)
    except VerificationFailure as failure:
        raise EvidenceBuildError(failure.code, failure.message, failure.field_path) from None
    return BuiltPackage(document=document, data=serialize_package(document), root=chain["root"])


def anchor_audit_entry(
    document: Mapping[str, Any],
    *,
    audit_entry_id: str,
    timestamp: str,
    prev_hash: Optional[str],
    agent_id: str = "",
    agent_did: str = "",
    grant_id: str = "",
    principal_id: str = "platform",
) -> Dict[str, Any]:
    """The auth-service audit entry that records a package's root.

    The auth service appends this entry to the tenant's audit hash chain when
    it exports a package, then embeds it as the package ``anchor``.
    """
    chain = document["chain"]
    case = document["case"]
    audit: Dict[str, Any] = {
        "action": "evidence.package_exported",
        "agentDid": agent_did,
        "agentId": agent_id,
        "developerId": case["tenant_id"],
        "grantId": grant_id,
        "id": audit_entry_id,
        "metadata": {
            "case_id": case["case_id"],
            "entry_count": chain["length"],
            "format": document["format"],
            "package_root": chain["root"],
            "version": document["version"],
        },
        "prevHash": prev_hash,
        "principalId": principal_id,
        "status": "success",
        "timestamp": timestamp,
    }
    audit["hash"] = audit_entry_hash(audit)
    return audit


def attach_anchor(document: Mapping[str, Any], audit_entry: Mapping[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``document`` with ``anchor`` set; the root is unchanged."""
    out = copy.deepcopy(dict(document))
    out["anchor"] = {"audit_entry": copy.deepcopy(dict(audit_entry)), "type": "grantex-audit-entry"}
    return out


def attach_signature(document: Mapping[str, Any], signature: Mapping[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``document`` with ``signature`` set; the root is unchanged."""
    out = copy.deepcopy(dict(document))
    out["signature"] = dict(signature)
    return out

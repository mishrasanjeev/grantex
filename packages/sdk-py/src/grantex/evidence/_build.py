"""Building evidence packages from case records."""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Sequence

from ._canonical import CanonicalizationError, canonicalize
from ._hashing import (
    IDENTIFIER_CLASSES,
    PLATFORM_MARKER,
    action_reference,
    audit_entry_hash,
    case_key,
    chain_root,
    entry_hash,
    header_hash,
    keyed_content_digest,
    pseudonym,
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
    """How identifiers and content digests appear in a package.

    Every class not in ``disclosed`` (``approver``, ``content``, ``principal``,
    ``record``, ``subject``) is keyed per case with ``key`` (at least 32 bytes,
    never written to the package; ``key_id`` names it). Disclosing every class
    needs no key and produces scheme ``none``.
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
        raise EvidenceBuildError("privacy_violation", f"unknown classes {sorted(unknown)}")
    disclosed = sorted(privacy.disclosed)
    if disclosed == list(IDENTIFIER_CLASSES):
        return {"disclosed": disclosed, "scheme": "none"}
    if privacy.key is None or len(privacy.key) < 32 or not privacy.key_id:
        raise EvidenceBuildError(
            "privacy_violation", "keying undisclosed classes requires a key of at least 32 bytes and a key_id"
        )
    return {"disclosed": disclosed, "key_id": privacy.key_id, "scheme": "hmac-sha256-v1"}


class _Protector:
    def __init__(self, privacy: PrivacySettings, disclosed: List[str], case: Mapping[str, Any]) -> None:
        self.disclosed = set(disclosed)
        self.key: Optional[bytes] = None
        if privacy.key is not None and self.disclosed != set(IDENTIFIER_CLASSES):
            tenant_id, case_id = case.get("tenant_id"), case.get("case_id")
            if not isinstance(tenant_id, str) or not isinstance(case_id, str):
                raise EvidenceBuildError("schema_violation", "case_id and tenant_id must be strings", "case")
            self.key = case_key(privacy.key, tenant_id, case_id)

    def identifier(self, cls: str, holder: Any, name: str) -> None:
        if cls in self.disclosed or not isinstance(holder, dict) or not isinstance(holder.get(name), str):
            return
        assert self.key is not None
        holder[name] = pseudonym(self.key, cls, holder[name])

    def content(self, holder: Dict[str, Any], name: str) -> None:
        if "content" in self.disclosed or not isinstance(holder.get(name), str):
            return
        assert self.key is not None
        holder[name] = keyed_content_digest(self.key, holder[name])

    def action(self, data: Dict[str, Any]) -> None:
        if "subject" in self.disclosed or not isinstance(data.get("action_hash"), str):
            return
        assert self.key is not None
        data["action_ref"] = action_reference(self.key, data.pop("action_hash"))

    def refs(self, refs: Any) -> None:
        for ref in refs if isinstance(refs, list) else []:
            self.identifier("record", ref, "record_id")
            self.identifier("record", ref, "excerpt_ref")

    def entry(self, entry: Dict[str, Any]) -> None:
        data = entry.get("data")
        if not isinstance(data, dict):
            return
        kind = entry.get("type")
        if kind == "grant":
            self.identifier("principal", data, "principal")
        elif kind == "tool_call":
            self.content(data, "input_hash")
            self.content(data, "output_hash")
            for record in data.get("upstream_records", []) if isinstance(data.get("upstream_records"), list) else []:
                self.identifier("record", record, "record_id")
        elif kind == "policy_evaluation":
            for item in data.get("inputs", []) if isinstance(data.get("inputs"), list) else []:
                if isinstance(item, dict):
                    self.refs(item.get("evidence"))
        elif kind == "recommendation":
            for section in data.get("sections", []) if isinstance(data.get("sections"), list) else []:
                if isinstance(section, dict):
                    self.refs(section.get("evidence"))
        elif kind == "disposition":
            for comparison in data.get("comparisons", []) if isinstance(data.get("comparisons"), list) else []:
                if isinstance(comparison, dict):
                    self.refs(comparison.get("evidence"))
            self.refs([data.get("hit")])
        elif kind == "decision":
            self.identifier("subject", data.get("action"), "subject")
            self.identifier("approver", data, "approver")
            self.action(data)
        elif kind == "decision_consumption":
            self.action(data)


def build_package(
    *,
    case: Mapping[str, Any],
    entries: Sequence[Mapping[str, Any]],
    privacy: PrivacySettings,
) -> BuiltPackage:
    """Build a package from a case header and entry records.

    ``case`` has ``case_id``, ``tenant_id``, ``issuer``, ``state``,
    ``exported_at`` and optionally ``subject`` and ``ext``. Each record has
    ``type``, ``at``, ``data`` and ``source`` and optionally ``ext``. Values are
    given in the clear (decisions carry the token's ``action_hash``) and keyed
    here according to ``privacy``. The result is checked with the verification
    rules, so an invalid package is refused with :class:`EvidenceBuildError`.
    """
    privacy_member = _privacy_member(privacy)
    case_member = copy.deepcopy(dict(case))
    protect = _Protector(privacy, privacy_member["disclosed"], case_member)
    protect.identifier("subject", case_member, "subject")

    document: Dict[str, Any] = {"case": case_member, "format": FORMAT, "privacy": privacy_member, "version": "1.0"}
    try:
        previous = header_hash(document)
    except CanonicalizationError as exc:
        raise EvidenceBuildError("schema_violation", str(exc), "case") from None
    genesis = previous

    built_entries: List[Dict[str, Any]] = []
    for index, record in enumerate(entries):
        unknown = set(record) - _ENTRY_INPUT_MEMBERS
        if unknown:
            raise EvidenceBuildError("schema_violation", f"unknown record members {sorted(unknown)}", f"entries[{index}]")
        entry: Dict[str, Any] = {name: copy.deepcopy(value) for name, value in record.items()}
        protect.entry(entry)
        entry["seq"] = index
        entry["prev"] = previous
        try:
            entry["hash"] = entry_hash(entry)
        except CanonicalizationError as exc:
            raise EvidenceBuildError("schema_violation", str(exc), f"entries[{index}]") from None
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
) -> Dict[str, Any]:
    """The platform audit entry that records a package's root.

    The auth service appends it to the tenant's audit hash chain on export and
    embeds it as the package ``anchor``. Its agent, DID and grant are empty,
    its principal is ``platform`` and its metadata carries the platform
    marker, none of which a tenant can write through ``/v1/audit/log``.
    """
    chain = document["chain"]
    case = document["case"]
    audit: Dict[str, Any] = {
        "action": "evidence.package_exported",
        "agentDid": "",
        "agentId": "",
        "developerId": case["tenant_id"],
        "grantId": "",
        "id": audit_entry_id,
        "metadata": {
            "case_id": case["case_id"],
            "entry_count": chain["length"],
            "format": document["format"],
            PLATFORM_MARKER: True,
            "package_root": chain["root"],
            "version": document["version"],
        },
        "prevHash": prev_hash,
        "principalId": "platform",
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

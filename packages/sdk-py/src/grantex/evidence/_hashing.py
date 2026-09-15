"""Hashes used by evidence packages (spec/evidence-package.md, "Hash chain")."""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, Mapping, Optional

from ._canonical import canonicalize

__all__ = [
    "IDENTIFIER_CLASSES",
    "digest",
    "digest_bytes",
    "header_hash",
    "entry_hash",
    "chain_root",
    "decision_action_hash",
    "audit_entry_hash",
    "pseudonymise",
    "is_pseudonym",
]

IDENTIFIER_CLASSES = ("approver", "principal", "subject")
"""Classes of identifier that are pseudonymised unless disclosed."""

_PSEUDONYM_PREFIX = "pz:"
_CASE_DERIVATION_LABEL = "grantex-evidence-v1"
_HEADER_MEMBERS = ("case", "format", "privacy", "version")
_CHAIN_MEMBERS = ("alg", "canonicalization", "genesis", "head", "length")


def digest_bytes(data: bytes) -> str:
    """``sha256:`` followed by the lower-case hex SHA-256 of ``data``."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest(value: Any) -> str:
    """Digest of the RFC 8785 canonical form of a JSON value."""
    return digest_bytes(canonicalize(value).encode("utf-8"))


def header_hash(package: Mapping[str, Any]) -> str:
    """``chain.genesis``: digest of ``{case, format, privacy, version}``."""
    return digest({name: package[name] for name in _HEADER_MEMBERS})


def entry_hash(entry: Mapping[str, Any]) -> str:
    """Digest of an entry with its ``hash`` member removed."""
    return digest({name: value for name, value in entry.items() if name != "hash"})


def chain_root(chain: Mapping[str, Any]) -> str:
    """``chain.root``: digest of ``{alg, canonicalization, genesis, head, length}``."""
    return digest({name: chain[name] for name in _CHAIN_MEMBERS})


def decision_action_hash(action: Mapping[str, Any]) -> str:
    """The decision-grant ``action_hash`` of a semantic action (PRD G-3).

    ``"sha256:" + base64url(SHA-256(JCS(action)))`` without padding.
    """
    raw = hashlib.sha256(canonicalize(dict(action)).encode("utf-8")).digest()
    return "sha256:" + base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def audit_entry_hash(entry: Mapping[str, Any]) -> str:
    """Hash of an auth-service audit entry, as the audit chain stores it.

    This is the auth service's current audit hash layout: SHA-256 (lower-case
    hex) of a JSON object with members in this fixed order, metadata with
    members sorted, and no whitespace.
    """
    prev_hash: Optional[str] = entry["prevHash"]
    text = (
        "{"
        + '"id":' + canonicalize(entry["id"]) + ","
        + '"agentId":' + canonicalize(entry["agentId"]) + ","
        + '"agentDid":' + canonicalize(entry["agentDid"]) + ","
        + '"grantId":' + canonicalize(entry["grantId"]) + ","
        + '"principalId":' + canonicalize(entry["principalId"]) + ","
        + '"developerId":' + canonicalize(entry["developerId"]) + ","
        + '"action":' + canonicalize(entry["action"]) + ","
        + '"metadata":' + canonicalize(entry["metadata"]) + ","
        + '"timestamp":' + canonicalize(entry["timestamp"]) + ","
        + '"prevHash":' + canonicalize(prev_hash) + ","
        + '"status":' + canonicalize(entry["status"])
        + "}"
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pseudonymise(
    tenant_key: bytes, tenant_id: str, case_id: str, identifier_class: str, value: str
) -> str:
    """Stable per-case pseudonym for an identifier.

    ``case_key = HMAC-SHA256(tenant_key, "grantex-evidence-v1:" + tenant_id + ":" + case_id)``
    and the pseudonym is ``"pz:" + base64url(HMAC-SHA256(case_key, class + ":" + value))``.
    The same identifier in the same case always maps to the same pseudonym;
    across cases it does not, so packages cannot be joined on it.
    """
    if identifier_class not in IDENTIFIER_CLASSES:
        raise ValueError(f"unknown identifier class {identifier_class!r}")
    if len(tenant_key) < 32:
        raise ValueError("pseudonymisation key must be at least 32 bytes")
    case_key = hmac.new(
        tenant_key,
        f"{_CASE_DERIVATION_LABEL}:{tenant_id}:{case_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    mac = hmac.new(
        case_key, f"{identifier_class}:{value}".encode("utf-8"), hashlib.sha256
    ).digest()
    return _PSEUDONYM_PREFIX + base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")


def is_pseudonym(value: object) -> bool:
    """Whether ``value`` has the pseudonym form ``pz:`` + 43 base64url characters."""
    if not isinstance(value, str) or not value.startswith(_PSEUDONYM_PREFIX):
        return False
    body = value[len(_PSEUDONYM_PREFIX) :]
    return len(body) == 43 and all(
        c.isascii() and (c.isalnum() or c in "-_") for c in body
    )

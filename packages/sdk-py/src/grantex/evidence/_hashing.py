"""Hashes and keyed pseudonyms used by evidence packages.

See spec/evidence-package.md, "Identifiers and privacy" and "Hash chain".
Every keyed value is an HMAC-SHA256 under a per-case key, and every HMAC input
is the RFC 8785 form of a JSON array, so no two inputs can collide by
concatenation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, Mapping, Optional

from ._canonical import canonicalize

__all__ = [
    "IDENTIFIER_CLASSES",
    "PLATFORM_MARKER",
    "digest",
    "digest_bytes",
    "header_hash",
    "entry_hash",
    "chain_root",
    "decision_action_hash",
    "audit_entry_hash",
    "case_key",
    "pseudonym",
    "pseudonymise",
    "keyed_content_digest",
    "action_reference",
    "is_pseudonym",
    "is_action_reference",
]

IDENTIFIER_CLASSES = ("approver", "content", "principal", "record", "subject")
"""Classes of value that are keyed per case unless disclosed (sorted)."""

PLATFORM_MARKER = "grantex:platform"
"""Metadata member only the auth service writes; /v1/audit/log refuses it."""

_PSEUDONYM_PREFIX = "pz:"
_ACTION_PREFIX = "ak:"
_KEYED_DIGEST_PREFIX = "hmac-sha256:"
_HEADER_MEMBERS = ("case", "format", "privacy", "version")
_CHAIN_MEMBERS = ("alg", "canonicalization", "genesis", "head", "length")
_B64URL = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


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
    """The decision-grant ``action_hash``: ``"sha256:" + base64url(SHA-256(JCS(action)))``."""
    raw = hashlib.sha256(canonicalize(dict(action)).encode("utf-8")).digest()
    return "sha256:" + _b64url(raw)


def audit_entry_hash(entry: Mapping[str, Any]) -> str:
    """Hash of an auth-service audit entry, as the audit chain stores it.

    SHA-256 (lower-case hex) of a JSON object with members in this fixed
    order, each value in RFC 8785 form, and no whitespace.
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


def case_key(tenant_key: bytes, tenant_id: str, case_id: str) -> bytes:
    """``HMAC-SHA256(tenant_key, JCS(["grantex-evidence-case-v1", tenant_id, case_id]))``."""
    if len(tenant_key) < 32:
        raise ValueError("pseudonymisation key must be at least 32 bytes")
    label = canonicalize(["grantex-evidence-case-v1", tenant_id, case_id]).encode("utf-8")
    return hmac.new(tenant_key, label, hashlib.sha256).digest()


def _mac(key: bytes, parts: Any) -> bytes:
    return hmac.new(key, canonicalize(parts).encode("utf-8"), hashlib.sha256).digest()


def pseudonym(key: bytes, identifier_class: str, value: str) -> str:
    """``"pz:" + base64url(HMAC(case_key, JCS(["pseudonym-v1", class, value])))``."""
    if identifier_class not in ("approver", "principal", "record", "subject"):
        raise ValueError(f"not an identifier class: {identifier_class!r}")
    return _PSEUDONYM_PREFIX + _b64url(_mac(key, ["pseudonym-v1", identifier_class, value]))


def pseudonymise(
    tenant_key: bytes, tenant_id: str, case_id: str, identifier_class: str, value: str
) -> str:
    """Stable per-case pseudonym for an identifier (derives the case key first)."""
    return pseudonym(case_key(tenant_key, tenant_id, case_id), identifier_class, value)


def keyed_content_digest(key: bytes, value_digest: str) -> str:
    """``"hmac-sha256:" + hex(HMAC(case_key, JCS(["content-v1", digest])))``.

    Replaces a tool input or output digest so equal inputs in two cases cannot
    be matched across packages.
    """
    return _KEYED_DIGEST_PREFIX + _mac(key, ["content-v1", value_digest]).hex()


def action_reference(key: bytes, action_hash: str) -> str:
    """``"ak:" + base64url(HMAC(case_key, JCS(["action-v1", action_hash])))``.

    Stands in for a decision ``action_hash`` when the subject is pseudonymised:
    an unkeyed hash over the clear subject would let anyone confirm a guess.
    """
    return _ACTION_PREFIX + _b64url(_mac(key, ["action-v1", action_hash]))


def _prefixed_b64(value: object, prefix: str) -> bool:
    if not isinstance(value, str) or not value.startswith(prefix):
        return False
    body = value[len(prefix) :]
    return len(body) == 43 and all(c in _B64URL for c in body)


def is_pseudonym(value: object) -> bool:
    """Whether ``value`` has the pseudonym form ``pz:`` + 43 base64url characters."""
    return _prefixed_b64(value, _PSEUDONYM_PREFIX)


def is_action_reference(value: object) -> bool:
    """Whether ``value`` has the form ``ak:`` + 43 base64url characters."""
    return _prefixed_b64(value, _ACTION_PREFIX)

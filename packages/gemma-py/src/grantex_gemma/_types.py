"""Type definitions for grantex-gemma."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass
class JWKSSnapshot:
    """A snapshot of JWKS keys for offline verification."""

    keys: list[dict[str, Any]]
    fetched_at: str
    valid_until: str


@dataclass
class OfflineAuditKey:
    """Ed25519 key pair for signing offline audit entries."""

    public_key: str
    private_key: str
    algorithm: str


@dataclass
class ConsentBundle:
    """Bundle containing everything needed for offline authorization."""

    bundle_id: str
    grant_token: str
    jwks_snapshot: JWKSSnapshot
    offline_audit_key: OfflineAuditKey
    checkpoint_at: int
    sync_endpoint: str
    offline_expires_at: str


@dataclass
class VerifiedGrant:
    """Result of successful offline token verification."""

    agent_did: str
    principal_did: str
    scopes: list[str]
    expires_at: datetime
    jti: str
    grant_id: str
    depth: int


@dataclass
class SignedAuditEntry:
    """A signed, hash-chained audit log entry."""

    seq: int
    timestamp: str
    action: str
    agent_did: str
    grant_id: str
    scopes: list[str]
    result: str
    metadata: dict[str, Any]
    prev_hash: str
    hash: str
    signature: str


@dataclass
class SyncResult:
    """Result of syncing offline audit entries to the cloud."""

    accepted: int
    rejected: int
    revocation_status: str
    new_bundle: ConsentBundle | None = field(default=None)

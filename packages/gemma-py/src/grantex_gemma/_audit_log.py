"""Offline audit log with Ed25519 signing and hash chain."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
)
from cryptography.hazmat.primitives.serialization import (
    load_pem_private_key,
)

from ._errors import HashChainError
from ._hash_chain import compute_entry_hash
from ._types import (
    ConsentBundle,
    JWKSSnapshot,
    OfflineAuditKey,
    SignedAuditEntry,
    SyncResult,
    VerifiedGrant,
)


class OfflineAuditLog:
    """Append-only, Ed25519-signed, hash-chained audit log.

    Entries are stored in JSONL format on disk.
    """

    def __init__(
        self,
        signing_key: OfflineAuditKey,
        log_path: str,
        max_size_mb: int = 50,
        rotate_on_size: bool = True,
    ) -> None:
        self._signing_key = signing_key
        self._log_path = log_path
        self._max_size_mb = max_size_mb
        self._rotate_on_size = rotate_on_size
        self._seq = 0
        self._prev_hash = "0" * 64
        self._lock = asyncio.Lock()

        # Load existing state from the log file
        self._load_existing_state()

        # Parse the Ed25519 private key
        self._private_key = self._load_private_key()

    def _load_private_key(self) -> Ed25519PrivateKey:
        """Load the Ed25519 private key from PEM."""
        key_bytes = self._signing_key.private_key.encode("utf-8")
        loaded = load_pem_private_key(key_bytes, password=None)
        if not isinstance(loaded, Ed25519PrivateKey):
            raise ValueError("Expected Ed25519 private key")
        return loaded

    def _load_existing_state(self) -> None:
        """Resume seq/prev_hash from an existing log file."""
        if not os.path.exists(self._log_path):
            return
        try:
            with open(self._log_path, "r", encoding="utf-8") as f:
                last_line = ""
                for line in f:
                    stripped = line.strip()
                    if stripped:
                        last_line = stripped
                if last_line:
                    entry = json.loads(last_line)
                    self._seq = entry["seq"]
                    self._prev_hash = entry["hash"]
        except (json.JSONDecodeError, KeyError, OSError):
            # Start fresh if the file is corrupted
            pass

    def _maybe_rotate(self) -> None:
        """Rotate the log file if it exceeds max_size_mb."""
        if not self._rotate_on_size:
            return
        try:
            size = os.path.getsize(self._log_path)
        except OSError:
            return
        if size >= self._max_size_mb * 1024 * 1024:
            rotated = f"{self._log_path}.{int(datetime.now(tz=timezone.utc).timestamp())}"
            os.rename(self._log_path, rotated)

    async def append(
        self,
        action: str,
        grant: VerifiedGrant,
        result: str,
        metadata: dict[str, Any] | None = None,
    ) -> SignedAuditEntry:
        """Append a signed audit entry to the log.

        Args:
            action: The action being audited (e.g. "read_contacts").
            grant: The verified grant that authorized this action.
            result: Outcome of the action (e.g. "success", "denied").
            metadata: Optional extra context.

        Returns:
            The signed and hash-chained audit entry.
        """
        async with self._lock:
            self._maybe_rotate()

            self._seq += 1
            now = datetime.now(tz=timezone.utc).isoformat()
            meta = metadata if metadata is not None else {}

            entry_dict: dict[str, Any] = {
                "seq": self._seq,
                "timestamp": now,
                "action": action,
                "agent_did": grant.agent_did,
                "grant_id": grant.grant_id,
                "scopes": grant.scopes,
                "result": result,
                "metadata": meta,
                "prev_hash": self._prev_hash,
            }

            entry_hash = compute_entry_hash(entry_dict)
            signature = self._sign(entry_hash)

            signed_entry = SignedAuditEntry(
                seq=self._seq,
                timestamp=now,
                action=action,
                agent_did=grant.agent_did,
                grant_id=grant.grant_id,
                scopes=grant.scopes,
                result=result,
                metadata=meta,
                prev_hash=self._prev_hash,
                hash=entry_hash,
                signature=signature,
            )

            # Write to JSONL
            line = json.dumps(
                {
                    "seq": signed_entry.seq,
                    "timestamp": signed_entry.timestamp,
                    "action": signed_entry.action,
                    "agent_did": signed_entry.agent_did,
                    "grant_id": signed_entry.grant_id,
                    "scopes": signed_entry.scopes,
                    "result": signed_entry.result,
                    "metadata": signed_entry.metadata,
                    "prev_hash": signed_entry.prev_hash,
                    "hash": signed_entry.hash,
                    "signature": signed_entry.signature,
                },
                separators=(",", ":"),
            )
            with open(
                self._log_path, "a", encoding="utf-8"
            ) as f:
                f.write(line + "\n")

            self._prev_hash = entry_hash
            return signed_entry

    async def sync(
        self,
        endpoint: str,
        api_key: str,
        bundle_id: str,
        batch_size: int = 100,
    ) -> SyncResult:
        """Sync audit entries to the cloud in batches.

        Args:
            endpoint: The sync endpoint URL.
            api_key: Developer API key for authentication.
            bundle_id: The consent bundle ID.
            batch_size: Max entries per HTTP request.

        Returns:
            A SyncResult with accepted/rejected counts.
        """
        entries = self._read_entries()
        if not entries:
            return SyncResult(
                accepted=0,
                rejected=0,
                revocation_status="active",
                new_bundle=None,
            )

        total_accepted = 0
        total_rejected = 0
        revocation_status = "active"
        new_bundle: ConsentBundle | None = None

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient() as client:
            for i in range(0, len(entries), batch_size):
                batch = entries[i : i + batch_size]
                body = {
                    "bundleId": bundle_id,
                    "entries": batch,
                }
                resp = await client.post(
                    endpoint,
                    json=body,
                    headers=headers,
                    timeout=30.0,
                )
                if resp.status_code >= 400:
                    raise HashChainError(
                        f"Sync failed ({resp.status_code}): {resp.text}"
                    )
                data = resp.json()
                total_accepted += data.get("accepted", 0)
                total_rejected += data.get("rejected", 0)
                revocation_status = data.get(
                    "revocationStatus", "active"
                )
                if data.get("newBundle"):
                    new_bundle = _parse_sync_bundle(
                        data["newBundle"]
                    )

        return SyncResult(
            accepted=total_accepted,
            rejected=total_rejected,
            revocation_status=revocation_status,
            new_bundle=new_bundle,
        )

    def _sign(self, data: str) -> str:
        """Sign data with Ed25519 and return base64url signature."""
        sig_bytes = self._private_key.sign(data.encode("utf-8"))
        return base64.urlsafe_b64encode(sig_bytes).decode("ascii")

    def _read_entries(self) -> list[dict[str, Any]]:
        """Read all entries from the log file."""
        entries: list[dict[str, Any]] = []
        if not os.path.exists(self._log_path):
            return entries
        with open(self._log_path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped:
                    entries.append(json.loads(stripped))
        return entries


def _parse_sync_bundle(data: dict[str, Any]) -> ConsentBundle:
    """Parse a ConsentBundle from a sync response."""
    jwks_data = data["jwksSnapshot"]
    audit_key_data = data["offlineAuditKey"]
    return ConsentBundle(
        bundle_id=data["bundleId"],
        grant_token=data["grantToken"],
        jwks_snapshot=JWKSSnapshot(
            keys=jwks_data["keys"],
            fetched_at=jwks_data["fetchedAt"],
            valid_until=jwks_data["validUntil"],
        ),
        offline_audit_key=OfflineAuditKey(
            public_key=audit_key_data["publicKey"],
            private_key=audit_key_data["privateKey"],
            algorithm=audit_key_data["algorithm"],
        ),
        checkpoint_at=data["checkpointAt"],
        sync_endpoint=data["syncEndpoint"],
        offline_expires_at=data["offlineExpiresAt"],
    )


def create_offline_audit_log(
    signing_key: OfflineAuditKey,
    log_path: str,
    max_size_mb: int = 50,
    rotate_on_size: bool = True,
) -> OfflineAuditLog:
    """Create an offline audit log.

    Args:
        signing_key: Ed25519 key pair for signing entries.
        log_path: Path to the JSONL log file.
        max_size_mb: Maximum log file size before rotation.
        rotate_on_size: Whether to rotate on size limit.

    Returns:
        An OfflineAuditLog instance.
    """
    return OfflineAuditLog(
        signing_key=signing_key,
        log_path=log_path,
        max_size_mb=max_size_mb,
        rotate_on_size=rotate_on_size,
    )

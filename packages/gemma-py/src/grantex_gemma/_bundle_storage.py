"""Encrypted storage for consent bundles using AES-256-GCM."""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ._errors import BundleTamperedError
from ._types import ConsentBundle, JWKSSnapshot, OfflineAuditKey


def store_bundle(
    bundle: ConsentBundle,
    path: str,
    encryption_key: str,
) -> None:
    """Encrypt and store a consent bundle to disk.

    Args:
        bundle: The consent bundle to store.
        path: File path for the encrypted bundle.
        encryption_key: Hex-encoded 256-bit encryption key (64 hex chars).

    Raises:
        ValueError: If the encryption key is invalid.
    """
    key_bytes = _decode_key(encryption_key)
    plaintext = json.dumps(
        _bundle_to_dict(bundle), separators=(",", ":")
    ).encode("utf-8")

    nonce = os.urandom(12)
    aesgcm = AESGCM(key_bytes)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)

    # Format: base64(nonce + ciphertext)
    combined = nonce + ciphertext
    encoded = base64.b64encode(combined).decode("ascii")

    with open(path, "w", encoding="utf-8") as f:
        f.write(encoded)


def load_bundle(
    path: str,
    encryption_key: str,
) -> ConsentBundle:
    """Load and decrypt a consent bundle from disk.

    Args:
        path: File path of the encrypted bundle.
        encryption_key: Hex-encoded 256-bit encryption key (64 hex chars).

    Returns:
        The decrypted ConsentBundle.

    Raises:
        BundleTamperedError: If decryption or integrity check fails.
        FileNotFoundError: If the file does not exist.
    """
    key_bytes = _decode_key(encryption_key)

    with open(path, "r", encoding="utf-8") as f:
        encoded = f.read()

    try:
        combined = base64.b64decode(encoded)
    except Exception as exc:
        raise BundleTamperedError(
            "Bundle file contains invalid base64 data"
        ) from exc

    if len(combined) < 12:
        raise BundleTamperedError("Bundle file is too short")

    nonce = combined[:12]
    ciphertext = combined[12:]

    aesgcm = AESGCM(key_bytes)
    try:
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    except Exception as exc:
        raise BundleTamperedError(
            "Bundle decryption failed: data has been tampered with"
        ) from exc

    try:
        data: dict[str, Any] = json.loads(plaintext.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise BundleTamperedError(
            "Bundle contains invalid JSON after decryption"
        ) from exc

    return _dict_to_bundle(data)


def _decode_key(encryption_key: str) -> bytes:
    """Decode the encryption key from hex."""
    try:
        key_bytes = bytes.fromhex(encryption_key)
    except ValueError as exc:
        raise ValueError(
            "encryption_key must be a 64-character hex string"
        ) from exc
    if len(key_bytes) != 32:
        raise ValueError(
            "encryption_key must be exactly 32 bytes (64 hex chars)"
        )
    return key_bytes


def _bundle_to_dict(bundle: ConsentBundle) -> dict[str, Any]:
    """Serialize a ConsentBundle to a dictionary."""
    return {
        "bundleId": bundle.bundle_id,
        "grantToken": bundle.grant_token,
        "jwksSnapshot": {
            "keys": bundle.jwks_snapshot.keys,
            "fetchedAt": bundle.jwks_snapshot.fetched_at,
            "validUntil": bundle.jwks_snapshot.valid_until,
        },
        "offlineAuditKey": {
            "publicKey": bundle.offline_audit_key.public_key,
            "privateKey": bundle.offline_audit_key.private_key,
            "algorithm": bundle.offline_audit_key.algorithm,
        },
        "checkpointAt": bundle.checkpoint_at,
        "syncEndpoint": bundle.sync_endpoint,
        "offlineExpiresAt": bundle.offline_expires_at,
    }


def _dict_to_bundle(data: dict[str, Any]) -> ConsentBundle:
    """Deserialize a dictionary to a ConsentBundle."""
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

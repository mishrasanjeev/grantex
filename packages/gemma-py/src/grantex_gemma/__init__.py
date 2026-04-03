"""grantex-gemma — Offline authorization for Gemma 4 on-device AI agents."""

from __future__ import annotations

from ._audit_log import OfflineAuditLog, create_offline_audit_log
from ._bundle_storage import load_bundle, store_bundle
from ._consent_bundle import create_consent_bundle
from ._errors import (
    BundleTamperedError,
    GrantexAuthError,
    GrantexGemmaError,
    HashChainError,
    OfflineVerificationError,
    ScopeViolationError,
    TokenExpiredError,
)
from ._hash_chain import compute_entry_hash, verify_chain
from ._scope_enforcer import enforce_scopes, has_scope
from ._types import (
    ConsentBundle,
    JWKSSnapshot,
    OfflineAuditKey,
    SignedAuditEntry,
    SyncResult,
    VerifiedGrant,
)
from ._verifier import OfflineVerifier, create_offline_verifier

__version__ = "0.1.0"

__all__ = [
    # Verifier
    "create_offline_verifier",
    "OfflineVerifier",
    # Consent bundles
    "create_consent_bundle",
    # Audit log
    "create_offline_audit_log",
    "OfflineAuditLog",
    # Hash chain
    "compute_entry_hash",
    "verify_chain",
    # Scope enforcement
    "enforce_scopes",
    "has_scope",
    # Bundle storage
    "store_bundle",
    "load_bundle",
    # Errors
    "GrantexGemmaError",
    "OfflineVerificationError",
    "ScopeViolationError",
    "TokenExpiredError",
    "BundleTamperedError",
    "GrantexAuthError",
    "HashChainError",
    # Types
    "ConsentBundle",
    "JWKSSnapshot",
    "OfflineAuditKey",
    "SignedAuditEntry",
    "SyncResult",
    "VerifiedGrant",
    # Version
    "__version__",
]

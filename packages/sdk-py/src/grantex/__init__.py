"""Grantex Python SDK — delegated authorization protocol for AI agents."""

from __future__ import annotations

from ._client import Grantex
from ._errors import (
    GrantexApiError,
    GrantexAuthError,
    GrantexError,
    GrantexNetworkError,
    GrantexTokenError,
)
from ._types import (
    Agent,
    AuditEntry,
    AuthorizationRequest,
    AuthorizeParams,
    DelegateParams,
    Grant,
    GrantTokenPayload,
    ListAgentsResponse,
    ListAuditParams,
    ListAuditResponse,
    ListGrantsParams,
    ListGrantsResponse,
    LogAuditParams,
    VerifiedGrant,
    VerifyGrantTokenOptions,
    VerifyTokenResponse,
)
from ._verify import verify_grant_token

__version__ = "0.1.0"

__all__ = [
    # Main client
    "Grantex",
    # Standalone verify
    "verify_grant_token",
    # Errors
    "GrantexError",
    "GrantexApiError",
    "GrantexAuthError",
    "GrantexTokenError",
    "GrantexNetworkError",
    # Types
    "Agent",
    "AuditEntry",
    "AuthorizationRequest",
    "AuthorizeParams",
    "DelegateParams",
    "Grant",
    "GrantTokenPayload",
    "ListAgentsResponse",
    "ListAuditParams",
    "ListAuditResponse",
    "ListGrantsParams",
    "ListGrantsResponse",
    "LogAuditParams",
    "VerifiedGrant",
    "VerifyGrantTokenOptions",
    "VerifyTokenResponse",
    # Version
    "__version__",
]

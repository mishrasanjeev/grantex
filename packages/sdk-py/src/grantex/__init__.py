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
    CheckoutResponse,
    CreateCheckoutParams,
    CreatePortalParams,
    CreateWebhookParams,
    DelegateParams,
    Grant,
    GrantTokenPayload,
    ListAgentsResponse,
    ListAuditParams,
    ListAuditResponse,
    ListGrantsParams,
    ListGrantsResponse,
    ListWebhooksResponse,
    LogAuditParams,
    PortalResponse,
    SubscriptionStatus,
    VerifiedGrant,
    VerifyGrantTokenOptions,
    VerifyTokenResponse,
    WebhookEndpoint,
    WebhookEndpointWithSecret,
)
from ._verify import verify_grant_token
from ._webhook import verify_webhook_signature

__version__ = "0.1.0"

__all__ = [
    # Main client
    "Grantex",
    # Standalone verify
    "verify_grant_token",
    # Webhook signature verification
    "verify_webhook_signature",
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
    "CheckoutResponse",
    "CreateCheckoutParams",
    "CreatePortalParams",
    "CreateWebhookParams",
    "DelegateParams",
    "Grant",
    "GrantTokenPayload",
    "ListAgentsResponse",
    "ListAuditParams",
    "ListAuditResponse",
    "ListGrantsParams",
    "ListGrantsResponse",
    "ListWebhooksResponse",
    "LogAuditParams",
    "PortalResponse",
    "SubscriptionStatus",
    "VerifiedGrant",
    "VerifyGrantTokenOptions",
    "VerifyTokenResponse",
    "WebhookEndpoint",
    "WebhookEndpointWithSecret",
    # Version
    "__version__",
]

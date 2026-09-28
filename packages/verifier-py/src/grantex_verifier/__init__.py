# SPDX-License-Identifier: Apache-2.0
"""grantex-verifier: what a relying party checks before it acts on an agent's request.

The Agent Passport (keys from the signed registry manifest only), the
issuer's status list and the registry's acceptance list, the grant, its
revocation state and audience, key equality, the key's status in the
registry, the RFC 9421 request signature and the transaction's fit with the
grant, under the staleness matrix of PRD section 9. See
spec/verification.md, "Relying-party verification". Not yet published.
"""

from __future__ import annotations

from grantex_agent_httpsig import HttpRequest, InMemoryNonceStore, NonceStore

from ._codes import APPENDIX_C_CODES, CAP_EXCEEDED, CHECK_ORDER, GRANT_REVOKED, TOKEN_INVALID
from ._grant_status import FeedGrantStatus, GrantStatus, GrantStatusSource, OnlineGrantStatus
from ._middleware import AsgiVerifierMiddleware, WsgiVerifierMiddleware, presentations_from_request
from ._registry import REGISTRY_MANIFEST_TYP, verify_manifest
from ._staleness import (
    FEED_FAIL_CLOSED_SECONDS,
    FEED_HEARTBEAT_SECONDS,
    LOOKUP_MAX_AGE_SECONDS,
    MANIFEST_MAX_AGE_SECONDS,
    REGISTRY_KEYS_MAX_AGE_SECONDS,
    STATUS_LIST_HIGH_RISK_STALENESS_SECONDS,
    STATUS_LIST_MAX_STALENESS_SECONDS,
    compute_tier,
    status_staleness_bound,
)
from ._verify import (
    TRUST_LEVELS,
    CheckResult,
    Transaction,
    VerifierConfig,
    VerifierDecision,
    verify,
)

__version__ = "0.1.0"

__all__ = [
    "APPENDIX_C_CODES",
    "CAP_EXCEEDED",
    "CHECK_ORDER",
    "FEED_FAIL_CLOSED_SECONDS",
    "FEED_HEARTBEAT_SECONDS",
    "GRANT_REVOKED",
    "LOOKUP_MAX_AGE_SECONDS",
    "MANIFEST_MAX_AGE_SECONDS",
    "REGISTRY_KEYS_MAX_AGE_SECONDS",
    "REGISTRY_MANIFEST_TYP",
    "STATUS_LIST_HIGH_RISK_STALENESS_SECONDS",
    "STATUS_LIST_MAX_STALENESS_SECONDS",
    "TOKEN_INVALID",
    "TRUST_LEVELS",
    "AsgiVerifierMiddleware",
    "CheckResult",
    "FeedGrantStatus",
    "GrantStatus",
    "GrantStatusSource",
    "HttpRequest",
    "InMemoryNonceStore",
    "NonceStore",
    "OnlineGrantStatus",
    "Transaction",
    "VerifierConfig",
    "VerifierDecision",
    "WsgiVerifierMiddleware",
    "compute_tier",
    "presentations_from_request",
    "status_staleness_bound",
    "verify",
    "verify_manifest",
]

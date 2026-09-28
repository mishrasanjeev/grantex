# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Union

from grantex_verifier import (
    GrantStatusSource,
    HttpRequest,
    InMemoryNonceStore,
    Transaction,
    VerificationResult,
    VerifierConfig,
    presentations_from_request,
    verify,
)


def make_config(
    *,
    fetch: Callable[[str], Union[str, bytes]],
    registry_lookup: Callable[[str], Optional[Mapping[str, Any]]],
    grant_status: GrantStatusSource,
) -> VerifierConfig:
    # Build this once per process and keep it: it holds the nonce store that
    # refuses a replayed request and the caches the staleness matrix governs.
    # A configuration built per request would accept every replay. fetch
    # reads a URL (https, no redirects); the registry lookup and the grant
    # status source are your clients for those calls.
    return VerifierConfig(
        origin="https://merchant.example",
        registry_issuer="https://registry.example",
        registry_jwks="https://registry.example/.well-known/jwks.json",
        manifest_url="https://registry.example/.well-known/agent-registry.json",
        fetch=fetch,
        registry_lookup=registry_lookup,
        grant_status=grant_status,
        nonce_store=InMemoryNonceStore(),
        hitl_threshold_minor=20_000,
    )


def verify_checkout(request: HttpRequest, *, config: VerifierConfig) -> VerificationResult:
    passport, grant = presentations_from_request(request)
    result = verify(
        passport or "",
        grant or "",
        request,
        Transaction(amount_minor=12_500, currency="EUR", merchant="https://merchant.example"),
        config=config,
    )
    if not result.ok:
        print("refused:", result.denial_code)
    return result

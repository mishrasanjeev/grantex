# SPDX-License-Identifier: Apache-2.0
from __future__ import annotations

from typing import Any, Callable, Dict, Iterable

from grantex_verifier import (
    HttpRequest,
    Transaction,
    VerifierConfig,
    WsgiVerifierMiddleware,
)


def checkout(environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
    result = environ["grantex.verification"]  # the VerificationResult, always ok here
    start_response("200 OK", [("Content-Type", "text/plain")])
    return [("accepted at level " + str(result.level)).encode()]


def transaction_for(request: HttpRequest) -> Transaction:
    # Take the amount from the signed content, never from the query string
    # (spec/verification.md section 4.5).
    return Transaction(amount_minor=12_500, currency="EUR", merchant="https://merchant.example")


def build_app(config: VerifierConfig) -> WsgiVerifierMiddleware:
    # Refuses with 401 (request signature), 503 (status_stale) or 403 (any
    # other denial code) and a JSON body naming the code.
    return WsgiVerifierMiddleware(checkout, config=config, transaction=transaction_for)

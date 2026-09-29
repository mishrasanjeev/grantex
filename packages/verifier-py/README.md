# grantex-verifier

> **Not yet published.** This package is in the repository at version 0.1.0 and
> is not on PyPI (its `Private :: Do Not Upload` classifier makes package
> indexes refuse it). Its API may change before the first release. It depends
> on `grantex-agent-passport` and `grantex-agent-httpsig`, which are not
> published either; install all three from the repository.

What a relying party (a merchant, a PSP, an API) checks before it acts on an
AI agent's request: the agent's **Agent Passport**, its **grant**, the RFC 9421
signature over the request, the issuer's and the registry's status lists, the
key's status in the registry and the transaction's fit with the grant. Every
check is reported; the first that fails, in a fixed order, names the denial.
The normative description is
[`spec/verification.md`](../../spec/verification.md), section 7
("Relying-party verification"); the guide for relying parties is
[`docs/relying-parties/verifying-agents.md`](../../docs/relying-parties/verifying-agents.md).
Python 3.9 or later.

## Verify a request

<!-- snippet: packages/verifier-py/tests/docs/examples/verify_checkout.py -->
```python
from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, Union

from grantex_verifier import (
    GrantStatusSource,
    HttpRequest,
    InMemoryNonceStore,
    Transaction,
    VerifierConfig,
    VerifierDecision,
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


def verify_checkout(request: HttpRequest, *, config: VerifierConfig) -> VerifierDecision:
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
```

Call `make_config` once when the process starts and pass the same
configuration to every `verify_checkout` call. Its nonce store is what
refuses a replayed request (`request_signature_invalid`); a configuration
built per request starts with an empty store and accepts every replay. If
several processes serve the same origin, give them one shared nonce store.

`verify()` returns a `VerifierDecision`: `ok`, `denial_code`, `checks` (for
each named check `ok`, `detail`, `cached_at` and, when it failed, `code`),
the registry's `level` and `flags`, the informational `tier` and an
`evidence` record of what the decision rested on (the passport's hash, the
attestation id, both status results and the level at verification time).

Where the trust comes from:

- issuer keys only from the signed registry manifest
  (`/.well-known/agent-registry.json`), verified with the registry JWK Set
  you configure; never from a URL or a key in a token;
- the grant, the manifest and the registry's acceptance lists verified with
  that JWK Set (`RS256` or `ES256`);
- the key's status and the agent's level from the registry lookup by key
  thumbprint, through the `registry_lookup` function you supply;
- the grant's revocation from `OnlineGrantStatus` (the auth service's
  revocation status endpoint, through a `get` function you supply) or
  `FeedGrantStatus` (a revocation feed, trusted within 10 seconds of its
  last heartbeat).

Nothing is fetched except through the `fetch` function you supply, and each
document is kept no longer than the staleness matrix allows (the manifest an
hour, registry keys a day, status lists their `ttl` and at most five
minutes, or 60 seconds above the HITL threshold or for a human-not-present
Tier A grant). A source that cannot be read again is `status_stale`.

## Middleware

<!-- snippet: packages/verifier-py/tests/docs/examples/wsgi_app.py -->
```python
from __future__ import annotations

from typing import Any, Callable, Dict, Iterable

from grantex_verifier import (
    HttpRequest,
    Transaction,
    VerifierConfig,
    WsgiVerifierMiddleware,
)


def checkout(environ: Dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
    result = environ["grantex.verification"]  # the VerifierDecision, always ok here
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
```

`AsgiVerifierMiddleware` does the same for ASGI applications and puts the
decision in `scope["grantex.verification"]`; it runs `verify()` (and so the
fetcher, registry lookup and grant-status client you inject) in the event
loop's default executor, so a cold cache does not block the loop. Pass
`reject=False` to receive every request with its decision attached and act
on it yourself, and `status_for` to change the HTTP status per denial code.

## Development

```bash
pip install -e ../agent-passport-py -e ../agent-httpsig-py -e ".[dev]"
mypy --strict src
pytest
```

The tests build a fake registry and issuer (manifest, JWK Set, status lists,
lookup) with keys generated at run time and serve them through an injected
fetcher; nothing touches the network. The examples above are
`tests/docs/examples/*.py`, embedded verbatim and run by
`tests/test_docs_examples.py`.

## License

Apache-2.0

# Verifying agents with the registry

This guide is for a **relying party**: a merchant, an API or any service that
receives requests from AI agents and decides whether to act on them. It
covers looking an agent up in the registry, what anyone can read and what an
authenticated relying party reads in addition, and the signed registry
manifest a relying party without OpenID Federation support uses to check
Agent Passports and attestations offline.

The normative text is `spec/registry-federation.md` ("Agent lookup" and
"Registry manifest"). The examples below use `registry.example` for the
registry, `issuer.example` for an accredited issuer, `provider.example` for
the agent's provider and `merchant.example` for you. The example agent is
`shopper-01`, running Nimbus Shopper 2.4.

## Before you start

The unauthenticated lookup and the manifest are served only when the
registry operator sets `REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true`. Without it,
the lookup answers only requests that carry a developer API key, and
`/.well-known/agent-registry.json` does not exist.

## Looking an agent up

Look an agent up by its DID:

```bash lookup-by-did
curl -s "https://registry.example/v1/registry/agents/did%3Agrantex%3Aag_01J8Z3K4M5N6P7Q8R9S0T1V2W3"
```

by the key that signed the request you received (its RFC 7638 SHA-256
thumbprint, base64url):

```bash lookup-by-key
curl -s "https://registry.example/v1/registry/agents?key_thumbprint=NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs"
```

or by the credential an accredited issuer attested, when a passport or an
attestation names it. All three values are required:

```bash lookup-by-credential
curl -s "https://registry.example/v1/registry/agents?issuer=https%3A%2F%2Fissuer.example&external_credential_id=case-000123&hash=sha-256%3AOiVR9AjgZRd6DJ8n_6dpLox_0KzFKt7gZ9MHpgHXOKQ"
```

A credential lookup matches on all three at once. If any one of them is
wrong, the answer is the same `404` as for a credential the registry has
never seen, so there is nothing to learn from guessing. Leaving one out is
`400`.

### Reading the answer

```json lookup-by-key-response
{
  "agent_did": "did:grantex:ag_01J8Z3K4M5N6P7Q8R9S0T1V2W3",
  "level": "attested",
  "flags": ["attestation_expiring"],
  "issuers": ["https://issuer.example"],
  "attestations": [
    { "type": "urn:grantex:tm:agent.identity", "issuer": "https://issuer.example", "expires_at": "2026-10-20T12:00:00.000Z" },
    { "type": "urn:grantex:tm:provider.entity", "issuer": "https://issuer.example", "expires_at": "2027-09-28T12:00:00.000Z" }
  ],
  "keys": [
    { "thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs", "status": "active", "current": true }
  ],
  "cimd_uri": "https://provider.example/agents/shopper-01/cimd.json",
  "key_thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
  "key_status": "active",
  "key_current": true
}
```

- `level` is computed when you ask: `basic`, `verified`, `attested` or
  `attested_verified`. A suspension anywhere in the chain reads `basic`.
  Compare it with your policy's minimum and deny with `level_below_policy`.
- `flags` warn of something you may want to act on, such as
  `key_compromised` or `issuer_suspended`.
- `key_current` says whether the key may sign now: `active`, or `rotated`
  and still inside its overlap. If the key that signed the request is not
  current, deny with `key_not_active`.
- `attestations` lists what counts toward the level, with each expiry.

### What is public and what needs a key

| | Without a key | With a developer API key |
|---|---|---|
| DID, level, flags, issuers | yes | yes |
| Attestation types, issuers and expiry | yes | yes |
| Key thumbprints, statuses and whether current | yes | yes |
| The agent's `cimd_uri` | yes | yes |
| The provider's DID, name and legal identifiers | no | yes |
| Each attestation's registry id and status list entries | no | yes |

To read the second column, send your developer API key as
`Authorization: Bearer <key>`. A key the registry does not accept is refused
with `401`, never answered as public. In Phase 1 a developer API key is the
relying-party credential; a dedicated one will follow.

Public answers may be cached for 60 seconds (`Cache-Control: public,
max-age=60`); authenticated answers are private and revalidated on every
read. Send the `ETag` back in `If-None-Match` to get `304` when nothing has
changed. Each lookup route allows 120 requests a minute per client address.

## The registry manifest

To check an Agent Passport or an attestation without calling the registry for
each one, fetch the signed manifest:

```bash manifest
curl -s "https://registry.example/.well-known/agent-registry.json"
```

The body is a compact JWS, `application/grantex-registry-manifest+jwt`, not
JSON. It lists every accredited issuer with its status and current keys, the
trust mark types, the registry's acceptance status lists and the lookup
endpoints. Before using it:

1. Fetch the registry's JWK Set from `https://registry.example/.well-known/jwks.json`.
2. Check the protected header: `typ` is exactly
   `grantex-registry-manifest+jwt`, `alg` is `RS256` or `ES256`, and there is
   no `jwk`, `jku`, `x5u`, `x5c` or `crit`.
3. Verify the signature with the key from the JWK Set whose `kid` matches,
   under that algorithm only.
4. Check `iss` is the registry you trust. Configure that value; never take
   it from the manifest, and refuse every manifest if it is not set.
5. Check freshness: now is before `exp`, not more than one hour after `iat`,
   and `iat` is not in the future.

If any check fails, do not use the manifest. Without a valid manifest you
cannot tell that an issuer is accredited: refuse what depends on it
(`passport_invalid_signature` for a manifest that does not verify,
`status_stale` for one that is too old). Never fall back to an expired copy.

Then, for a passport or attestation signed by an issuer:

- find the issuer by `entity_id` in `issuers`; if it is absent or
  `withdrawn`, deny with `issuer_not_accredited`; if `suspended`, deny with
  `issuer_suspended`; if its `trust_marks` do not include the type you need,
  deny with `trust_mark_missing`;
- verify the signature only with a key from that issuer's `jwks` (revoked
  keys are already left out);
- check the registry's acceptance entry in the status list the attestation
  names (`acceptance_status_lists`) and deny with `attestation_not_accepted`
  unless it is VALID.

Refetch the manifest at least every hour. Its `ETag` stays the same while
the registry has not changed and the manifest has not been re-signed, so a
conditional request is cheap. The manifest route allows 60 requests a minute
per client address.

## Verifying a request in Python

`grantex-verifier` (`packages/verifier-py`, 0.1.0, **not yet published**)
does everything above for each request: it checks the manifest, the Agent
Passport against the issuer's keys in it, both status lists, the grant, its
revocation and audience, that the passport, the grant and the request
signature name one key, the key's status in the lookup, the RFC 9421
signature and the transaction's fit with the grant. The checks, their order,
the staleness matrix and the denial codes are specified in
`spec/verification.md` section 7.

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

`result.checks` reports every check with `ok`, `detail` and `cached_at`, and
`result.denial_code` is the code of the first that failed. Keep
`result.evidence` with the order: it records the passport's hash, the
attestation id, both status results and the level when you verified.

To verify in front of a WSGI application (an ASGI middleware is included
too):

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

A refused request is answered `401` for a request signature failure, `503`
for `status_stale` (the request may be good, but you could not establish
it) and `403` for any other code, with `{"denial_code": ..., "check": ...}`.
Both examples are run by the package's tests.

---
title: "Implementing an Issuer Adapter"
sidebarTitle: "Issuer Adapters"
description: "The one interface between the registry and an accredited issuer: three operations, an entry point, and five environment variables. The mock issuer implements it in the repository; a real issuer's adapter lives in its own package."
---

The registry asks an accredited issuer to attest an agent through one seam,
`AccreditedIssuerClient` in the Python SDK (`grantex.issuers`). This stack
governs what a principal has allowed an agent to do; an accredited issuer
attests who the agent and its developer are. The adapter is where the two
meet, and it is deliberately small so that an issuer can write one without
reading the rest of this repository.

## The interface

Three operations, nothing else:

| Operation | Input | Output |
|---|---|---|
| `issuer_metadata()` | — | `IssuerMetadata`: `issuer_id`, trust-mark `scopes`, and either a static `jwks` or an `entity_configuration_url` (OpenID Federation, Phase 2); optionally `status_list_base` |
| `request_attestation(agent_record, proved_key)` | the agent's identifiers (`AgentRecord`) and a public key the registry has proved possession of (`ProvedKey`: RFC 7638 `thumbprint`, `public_jwk`, `possession_proved_at`) | `IssuedAttestation`: the compact JWS (`typ` `grantex-attestation+jwt`, [spec](https://github.com/mishrasanjeev/grantex/blob/main/spec/attestation-1.0.md)), its `attestation_type`, a `CredentialRef` (`issuer`, `external_credential_id`, `external_credential_hash`, and the issuer's own `issuer_attestation_id` when it has one) for later lookups, the bound `key_thumbprint`, `expires_at`, the issuer's own credential (`passport`) when it issued one, and `companions`: further attestations from the same issuance (an Agent Passport attests `provider.entity` as well as `agent.identity`), each ingested with it |
| `fetch_status(credential_ref)` | a `CredentialRef` | `IssuerStatus`: `valid`, `suspended` or `revoked`, with `checked_at` and `source` |

`external_credential_id` and `external_credential_hash` are what the attestation
says about the credential it attests (an Agent Passport's id and hash); the
registry's lookup by credential takes those. The issuer's own id of the
attestation (its `id` claim) travels as `issuer_attestation_id`, for the
issuer's status and revocation operations.

The adapter only ever sees public material. An issuer verifies the agent's
possession of `proved_key` its own way (its own challenge, signed by the
agent); the registry has already done the same for its record. Private keys,
API credentials and the issuer's URL never pass through the registry.

Every failure raises `IssuerAdapterError(code, message)`. The loader's codes
are `adapter_not_configured`, `adapter_not_installed`, `adapter_ambiguous` and
`adapter_invalid`; an adapter uses `issuer_unreachable`,
`issuer_response_invalid`, `key_binding_mismatch`, and otherwise the issuer's
own refusal code (`key_unproven`, `scope_not_accredited`, `passport_revoked`,
...), so a relying party sees one vocabulary. Nothing is caught and turned into
a success; a status that cannot be fetched is an error, not `valid`.

## Selecting an adapter

Adapters are found through the `grantex.issuers` entry point group and chosen
by name:

| Variable | Meaning |
|---|---|
| `GRANTEX_ISSUER_ADAPTER` | the entry point name; `mock` is the mock issuer in this repository |
| `GRANTEX_ISSUER_BASE_URL` | the issuer's API base URL |
| `GRANTEX_ISSUER_CLIENT_ID`, `GRANTEX_ISSUER_CLIENT_SECRET` | a client credential, or |
| `GRANTEX_ISSUER_TOKEN` | a bearer token |
| `GRANTEX_ISSUER_SCOPES` | the trust marks to request, space or comma separated |

```python
from grantex.issuers import load_issuer_client

client = load_issuer_client()  # GRANTEX_ISSUER_ADAPTER names it
metadata = client.issuer_metadata()
```

With `GRANTEX_ISSUER_ADAPTER=mock` everything runs locally and in CI with no
external party. Any other name must be installed: a name with no entry point
fails closed with `adapter_not_installed` and a message naming the variable.
The loader never falls back to the mock, and two packages providing the same
name are refused (`adapter_ambiguous`) rather than picked between.

## Writing one

An adapter is a class with the three operations and a factory that takes the
`IssuerAdapterConfig` the SDK read from the environment. This one, from the
SDK's test suite, talks to a fictional issuer at `issuer.example`:

{/* snippet: packages/sdk-py/tests/docs_examples/issuer_adapter.py */}
```python
"""An accredited issuer adapter, as a third party writes one.

Install it as its own package with this entry point in pyproject.toml:

    [project.entry-points."grantex.issuers"]
    example = "example_issuer_adapter:create_client"

then select it with GRANTEX_ISSUER_ADAPTER=example. The issuer's URL and
credential come from GRANTEX_ISSUER_BASE_URL and GRANTEX_ISSUER_TOKEN (or
GRANTEX_ISSUER_CLIENT_ID / GRANTEX_ISSUER_CLIENT_SECRET); nothing is hard-coded.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from grantex.issuers import (
    AgentRecord,
    CredentialRef,
    IssuedAttestation,
    IssuerAdapterConfig,
    IssuerAdapterError,
    IssuerMetadata,
    IssuerStatus,
    ProvedKey,
)


class ExampleIssuerClient:
    """Talks to https://issuer.example over its own API; shapes here are illustrative."""

    def __init__(self, config: IssuerAdapterConfig, transport: httpx.BaseTransport | None = None) -> None:
        if not config.base_url or not config.token:
            raise IssuerAdapterError("adapter_invalid", "GRANTEX_ISSUER_BASE_URL and GRANTEX_ISSUER_TOKEN are required")
        self._http = httpx.Client(
            base_url=config.base_url, headers={"Authorization": f"Bearer {config.token}"}, transport=transport
        )
        self._scopes = config.scopes or ("urn:grantex:tm:agent.identity",)

    def issuer_metadata(self) -> IssuerMetadata:
        body = self._get("/.well-known/issuer")
        return IssuerMetadata(issuer_id=body["issuer"], scopes=self._scopes, jwks=body["jwks"])

    def request_attestation(self, agent_record: AgentRecord, proved_key: ProvedKey) -> IssuedAttestation:
        # The issuer verifies possession of proved_key.public_jwk with the agent
        # itself; the adapter sends only public material.
        body = self._post(
            "/attestations",
            {"agent_did": agent_record.did, "key": dict(proved_key.public_jwk), "thumbprint": proved_key.thumbprint},
        )
        return IssuedAttestation(
            jws=body["attestation"],
            attestation_type=body["type"],
            credential_ref=CredentialRef(body["issuer"], body["credential_id"], body["credential_hash"]),
            key_thumbprint=proved_key.thumbprint,
            expires_at=datetime.fromtimestamp(body["exp"], tz=timezone.utc),
        )

    def fetch_status(self, credential_ref: CredentialRef) -> IssuerStatus:
        body = self._get(f"/credentials/{credential_ref.external_credential_id}/status")
        state = body["status"]
        if state not in ("valid", "suspended", "revoked"):
            raise IssuerAdapterError("issuer_response_invalid", f"unknown status {state!r}")
        return IssuerStatus(state=state, checked_at=datetime.now(tz=timezone.utc), source="api")

    def _get(self, path: str) -> dict:
        return self._call("GET", path, None)

    def _post(self, path: str, json: dict) -> dict:
        return self._call("POST", path, json)

    def _call(self, method: str, path: str, json: dict | None) -> dict:
        # Fail closed: a refusal keeps the issuer's code, a transport error has its own.
        try:
            response = self._http.request(method, path, json=json)
        except httpx.HTTPError as exc:
            raise IssuerAdapterError("issuer_unreachable", str(exc)) from exc
        if response.status_code >= 400:
            refusal = response.json()
            raise IssuerAdapterError(refusal.get("code", "issuer_refused"), refusal.get("message", ""))
        body = response.json()
        if not isinstance(body, dict):
            raise IssuerAdapterError("issuer_response_invalid", "expected a JSON object")
        return body


def create_client(config: IssuerAdapterConfig) -> ExampleIssuerClient:
    """The entry point: build the adapter from the configuration the SDK read."""
    return ExampleIssuerClient(config)
```

Package it on its own, outside this repository, with the entry point in its
`pyproject.toml`; install it beside the SDK; set the variables; select it.
Nothing in this repository changes, and nothing here needs to know the
issuer's name. The SDK's test
`test_stub_entry_point_is_loaded` proves the path with a stub distribution.

What the adapter must guarantee:

- `request_attestation` returns an attestation whose `key_thumbprint` is the
  thumbprint it was given, or raises `key_binding_mismatch`; the registry
  refuses an attestation for an unproven key with `key_unproven` in any case.
- The JWS header's `typ` is exactly `grantex-attestation+jwt` and carries the
  `kid` of a key in `issuer_metadata().jwks` (or resolvable from the Entity
  Configuration).
- `external_credential_hash` is `sha-256:` + base64url(SHA-256) of the
  issuer-signed credential, as the
  [Agent Passport hash rule](https://github.com/mishrasanjeev/grantex/blob/main/spec/agent-passport-1.0.md)
  states.
- `fetch_status` reflects the issuer's status list or API as of
  `checked_at`; a stale or unreadable source is an error.

## The registry side: requesting attestation

`grantex.issuers.attest_agent(client, agent_id, thumbprint)` is the step of
agent registration that uses the adapter. It reads the key from the agent's
history and refuses with `key_unproven` unless it is `active` (possession
proven through `POST /v1/agents/{id}/keys/{thumbprint}/challenge` and
`/prove`); hands the agent's identifiers and public key to the adapter;
posts the attestation JWS to `POST /v1/registry/attestations` with no API key
(the issuer's signature is the authentication); and reads the agent's
computed level back from the lookup. The registry's refusals keep their codes
(`issuer_not_accredited`, `scope_not_accredited`, `signature_invalid`,
`expired`, `key_unproven`).

The same step is the `grantex-attest` command, which also registers and
proves the key when it is new:

```bash
export GRANTEX_API_KEY=...            # the developer's key
export GRANTEX_ISSUER_ADAPTER=mock    # or a private adapter's name
grantex-attest ag_01ABC --key agent-key.json --generate-key
```

Each step is one JSON line: `key_generated`, `key_added`, `key_proved`,
`issuer`, `attestation_issued`, `attestation_ingested`, `lookup`, with a
`source` of `live` for the registry and the adapter's name for the issuer.

## The mock issuer's adapter

`GRANTEX_ISSUER_ADAPTER=mock` builds `grantex.issuers.MockIssuerClient`, which
drives the [mock issuer](running-the-mock-issuer.md) CLI in a subprocess (no
network): `keys` for metadata, `issue-passport` then `attest` for an
attestation, `status` for status. It reads:

| Variable | Meaning |
|---|---|
| `GRANTEX_MOCK_ISSUER_CLI` | the command, default `node packages/mock-issuer/src/cli.ts` when the SDK runs from the repository |
| `GRANTEX_MOCK_ISSUER_DIR` (or `MOCK_ISSUER_DIR`) | the mock's state directory |
| `GRANTEX_MOCK_ISSUER_AGENT_KEYS` | `thumbprint=path` pairs for agent key files, when they are not under `<state dir>/agents/` |
| `GRANTEX_MOCK_ISSUER_TYPES` | the trust marks to attest from one passport, comma separated; default `urn:grantex:tm:agent.identity,urn:grantex:tm:provider.entity`, which is what the level `attested` needs. `provider.entity` needs the agent's provider DID (`AgentRecord.provider_did`, `grantex-attest --provider-did`), or the request is refused before anything is issued |

The mock runs both sides of the possession proof itself, so it needs the
agent's private key file: the one `issue-passport --generate-agent-key` writes
under `<state dir>/agents/<thumbprint>.json`, a path named per thumbprint, or
the file `grantex-attest --key` names (the command hands it to the mock).
That is a property of the mock only; a real issuer proves possession with the
agent directly. The base URL and credential variables are ignored by the mock,
which has no network side.

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

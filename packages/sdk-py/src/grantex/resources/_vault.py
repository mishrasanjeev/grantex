from __future__ import annotations

from urllib.parse import quote

from typing import Any

import httpx

from .._http import HttpClient
from .._types import (
    ExchangeCredentialParams,
    ExchangeCredentialReferenceResponse,
    ExchangeCredentialResponse,
    ListVaultCredentialsParams,
    ListVaultCredentialsResponse,
    StoreCredentialParams,
    StoreCredentialResponse,
    VaultCredential,
)


class VaultClient:
    def __init__(self, http: HttpClient, base_url: str) -> None:
        self._http = http
        self._base_url = base_url.rstrip("/")

    def store(self, params: StoreCredentialParams) -> StoreCredentialResponse:
        """Store an encrypted credential in the vault (upserts on principal+service)."""
        data = self._http.post("/v1/vault/credentials", params.to_dict())
        return StoreCredentialResponse.from_dict(data)

    def list(self, params: ListVaultCredentialsParams | None = None) -> ListVaultCredentialsResponse:
        """List credential metadata (no raw tokens)."""
        query_parts: list[str] = []
        if params is not None:
            if params.principal_id is not None:
                query_parts.append(f"principalId={params.principal_id}")
            if params.service is not None:
                query_parts.append(f"service={params.service}")
        qs = "&".join(query_parts)
        path = f"/v1/vault/credentials?{qs}" if qs else "/v1/vault/credentials"
        data = self._http.get(path)
        return ListVaultCredentialsResponse.from_dict(data)

    def get(self, credential_id: str) -> VaultCredential:
        """Get credential metadata by ID (no raw token)."""
        data = self._http.get(f"/v1/vault/credentials/{quote(credential_id, safe='')}")
        return VaultCredential.from_dict(data)

    def delete(self, credential_id: str) -> None:
        """Delete a credential from the vault."""
        self._http.delete(f"/v1/vault/credentials/{quote(credential_id, safe='')}")

    def exchange(
        self,
        grant_token: str,
        params: ExchangeCredentialParams,
    ) -> ExchangeCredentialResponse:
        """Exchange a grant token for an upstream credential.

        Uses the grant token (not the API key) as the Bearer token.
        """
        return ExchangeCredentialResponse.from_dict(self._exchange(grant_token, params.to_dict()))

    def exchange_reference(
        self,
        grant_token: str,
        params: ExchangeCredentialParams,
    ) -> ExchangeCredentialReferenceResponse:
        """Exchange a grant token for a credential reference instead of the credential.

        The relying party (for example the gateway with ``credentialReference: on``)
        resolves the reference and injects the credential upstream; this process
        never holds the secret. Needs ``VAULT_CREDENTIAL_REFERENCES_ENABLED`` on
        the auth service.
        """
        body = {**params.to_dict(), "delivery": "reference"}
        return ExchangeCredentialReferenceResponse.from_dict(self._exchange(grant_token, body))

    def _exchange(self, grant_token: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}/v1/vault/credentials/exchange"
        response = httpx.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {grant_token}",
                "Accept": "application/json",
            },
        )
        if not response.is_success:
            payload: dict[str, Any] | None = None
            try:
                payload = response.json()
            except Exception:
                payload = None
            message = (
                payload["message"]
                if isinstance(payload, dict) and isinstance(payload.get("message"), str)
                else f"HTTP {response.status_code}"
            )
            raise ValueError(message)
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("unexpected response from the vault exchange")
        return data

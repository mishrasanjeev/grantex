from __future__ import annotations

from typing import Any

import httpx

from .._http import HttpClient
from .._types import (
    ExchangeCredentialParams,
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
        data = self._http.get(f"/v1/vault/credentials/{credential_id}")
        return VaultCredential.from_dict(data)

    def delete(self, credential_id: str) -> None:
        """Delete a credential from the vault."""
        self._http.delete(f"/v1/vault/credentials/{credential_id}")

    def exchange(
        self,
        grant_token: str,
        params: ExchangeCredentialParams,
    ) -> ExchangeCredentialResponse:
        """Exchange a grant token for an upstream credential.

        Uses the grant token (not the API key) as the Bearer token.
        """
        url = f"{self._base_url}/v1/vault/credentials/exchange"
        response = httpx.post(
            url,
            json=params.to_dict(),
            headers={
                "Authorization": f"Bearer {grant_token}",
                "Accept": "application/json",
            },
        )
        if not response.is_success:
            body: dict[str, Any] | None = None
            try:
                body = response.json()
            except Exception:
                pass
            message = (
                body["message"]
                if isinstance(body, dict) and isinstance(body.get("message"), str)
                else f"HTTP {response.status_code}"
            )
            raise ValueError(message)
        return ExchangeCredentialResponse.from_dict(response.json())

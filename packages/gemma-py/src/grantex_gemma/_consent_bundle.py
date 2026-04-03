"""Consent bundle creation via the Grantex API."""

from __future__ import annotations

from typing import Any

import httpx

from ._errors import GrantexAuthError
from ._types import ConsentBundle, JWKSSnapshot, OfflineAuditKey


async def create_consent_bundle(
    api_key: str,
    agent_id: str,
    user_id: str,
    scopes: list[str],
    offline_ttl: str = "72h",
    base_url: str = "https://api.grantex.dev",
) -> ConsentBundle:
    """Create a consent bundle for offline authorization.

    Makes an HTTP POST to ``/v1/consent-bundles`` on the Grantex API,
    returning a ``ConsentBundle`` that contains everything the device
    needs for offline operation.

    Args:
        api_key: Developer API key.
        agent_id: The agent's DID or identifier.
        user_id: The principal (user) identifier.
        scopes: List of scopes to authorize.
        offline_ttl: How long the bundle is valid offline (e.g. "72h").
        base_url: Grantex API base URL.

    Returns:
        A ConsentBundle ready for on-device use.

    Raises:
        GrantexAuthError: On authentication or API errors.
    """
    url = f"{base_url.rstrip('/')}/v1/consent-bundles"
    body = {
        "agentId": agent_id,
        "userId": user_id,
        "scopes": scopes,
        "offlineTTL": offline_ttl,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                url,
                json=body,
                headers=headers,
                timeout=30.0,
            )
        except httpx.HTTPError as exc:
            raise GrantexAuthError(
                f"Network error creating consent bundle: {exc}"
            ) from exc

    if resp.status_code == 401:
        raise GrantexAuthError(
            "Invalid API key",
            status_code=401,
        )
    if resp.status_code == 403:
        raise GrantexAuthError(
            "Forbidden: insufficient permissions",
            status_code=403,
        )
    if resp.status_code >= 400:
        raise GrantexAuthError(
            f"API error ({resp.status_code}): {resp.text}",
            status_code=resp.status_code,
        )

    data: dict[str, Any] = resp.json()
    return _parse_bundle(data)


def _parse_bundle(data: dict[str, Any]) -> ConsentBundle:
    """Parse a consent bundle from the API response."""
    jwks_data = data["jwksSnapshot"]
    jwks = JWKSSnapshot(
        keys=jwks_data["keys"],
        fetched_at=jwks_data["fetchedAt"],
        valid_until=jwks_data["validUntil"],
    )

    audit_key_data = data["offlineAuditKey"]
    audit_key = OfflineAuditKey(
        public_key=audit_key_data["publicKey"],
        private_key=audit_key_data["privateKey"],
        algorithm=audit_key_data["algorithm"],
    )

    return ConsentBundle(
        bundle_id=data["bundleId"],
        grant_token=data["grantToken"],
        jwks_snapshot=jwks,
        offline_audit_key=audit_key,
        checkpoint_at=data["checkpointAt"],
        sync_endpoint=data["syncEndpoint"],
        offline_expires_at=data["offlineExpiresAt"],
    )

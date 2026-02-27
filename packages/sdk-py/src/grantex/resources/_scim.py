from __future__ import annotations

from typing import Any

from .._http import HttpClient
from .._types import (
    CreateScimUserParams,
    ListScimTokensResponse,
    ScimListResponse,
    ScimToken,
    ScimTokenWithSecret,
    ScimUser,
)


class ScimClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # ── SCIM token management ─────────────────────────────────────────────

    def create_token(self, label: str) -> ScimTokenWithSecret:
        """Create a new SCIM bearer token. The raw token is returned once only."""
        data = self._http.post("/v1/scim/tokens", {"label": label})
        return ScimTokenWithSecret.from_dict(data)

    def list_tokens(self) -> ListScimTokensResponse:
        """List all SCIM tokens for this developer org (without raw secrets)."""
        data = self._http.get("/v1/scim/tokens")
        return ListScimTokensResponse.from_dict(data)

    def revoke_token(self, token_id: str) -> None:
        """Revoke a SCIM token by ID."""
        self._http.delete(f"/v1/scim/tokens/{token_id}")

    # ── SCIM 2.0 Users ────────────────────────────────────────────────────

    def list_users(
        self,
        *,
        start_index: int | None = None,
        count: int | None = None,
    ) -> ScimListResponse:
        """List provisioned users (SCIM 2.0 ListResponse)."""
        params: list[str] = []
        if start_index is not None:
            params.append(f"startIndex={start_index}")
        if count is not None:
            params.append(f"count={count}")
        path = "/scim/v2/Users"
        if params:
            path = f"{path}?{'&'.join(params)}"
        data = self._http.get(path)
        return ScimListResponse.from_dict(data)

    def get_user(self, user_id: str) -> ScimUser:
        """Get a single provisioned user by ID."""
        data = self._http.get(f"/scim/v2/Users/{user_id}")
        return ScimUser.from_dict(data)

    def create_user(self, params: CreateScimUserParams) -> ScimUser:
        """Provision a new user."""
        data = self._http.post("/scim/v2/Users", params.to_dict())
        return ScimUser.from_dict(data)

    def replace_user(self, user_id: str, params: CreateScimUserParams) -> ScimUser:
        """Full replace of a user (PUT)."""
        data = self._http.put(f"/scim/v2/Users/{user_id}", params.to_dict())
        return ScimUser.from_dict(data)

    def update_user(
        self,
        user_id: str,
        operations: list[dict[str, Any]],
    ) -> ScimUser:
        """Partial update via SCIM Operations (PATCH)."""
        data = self._http.patch(f"/scim/v2/Users/{user_id}", {"Operations": operations})
        return ScimUser.from_dict(data)

    def delete_user(self, user_id: str) -> None:
        """Deprovision a user (DELETE)."""
        self._http.delete(f"/scim/v2/Users/{user_id}")

    # Keep reference to avoid unused-import
    _ScimToken = ScimToken

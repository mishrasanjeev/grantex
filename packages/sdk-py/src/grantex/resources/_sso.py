from __future__ import annotations

from urllib.parse import quote

from .._http import HttpClient
from .._types import CreateSsoConfigParams, SsoCallbackResponse, SsoConfig, SsoLoginResponse


class SsoClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create_config(self, params: CreateSsoConfigParams) -> SsoConfig:
        """Create or update the OIDC SSO configuration for this developer org."""
        data = self._http.post("/v1/sso/config", params.to_dict())
        return SsoConfig.from_dict(data)

    def get_config(self) -> SsoConfig:
        """Get the current SSO configuration (client secret is not returned)."""
        data = self._http.get("/v1/sso/config")
        return SsoConfig.from_dict(data)

    def delete_config(self) -> None:
        """Remove the SSO configuration."""
        self._http.delete("/v1/sso/config")

    def get_login_url(self, org: str) -> SsoLoginResponse:
        """Get the OIDC authorization URL to redirect the user to."""
        data = self._http.get(f"/sso/login?org={quote(org)}")
        return SsoLoginResponse.from_dict(data)

    def handle_callback(self, code: str, state: str) -> SsoCallbackResponse:
        """Exchange the OIDC authorization code for user info."""
        path = f"/sso/callback?code={quote(code)}&state={quote(state)}"
        data = self._http.get(path)
        return SsoCallbackResponse.from_dict(data)

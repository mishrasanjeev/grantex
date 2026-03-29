from __future__ import annotations

from urllib.parse import quote

from .._http import HttpClient
from .._types import (
    CreateSsoConfigParams,
    CreateSsoConnectionParams,
    ListSsoConnectionsResponse,
    ListSsoSessionsResponse,
    SsoCallbackResponse,
    SsoCallbackResult,
    SsoConfig,
    SsoConnection,
    SsoConnectionTestResult,
    SsoEnforcementParams,
    SsoEnforcementResponse,
    SsoLdapCallbackParams,
    SsoLoginResponse,
    SsoOidcCallbackParams,
    SsoSamlCallbackParams,
    UpdateSsoConnectionParams,
)


class SsoClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    # ── Enterprise SSO Connections ────────────────────────────────────────

    def create_connection(self, params: CreateSsoConnectionParams) -> SsoConnection:
        """Create a new SSO connection (OIDC or SAML)."""
        data = self._http.post("/v1/sso/connections", params.to_dict())
        return SsoConnection.from_dict(data)

    def list_connections(self) -> ListSsoConnectionsResponse:
        """List all SSO connections for this org."""
        data = self._http.get("/v1/sso/connections")
        return ListSsoConnectionsResponse.from_dict(data)

    def get_connection(self, id: str) -> SsoConnection:
        """Get a single SSO connection by ID."""
        data = self._http.get(f"/v1/sso/connections/{quote(id)}")
        return SsoConnection.from_dict(data)

    def update_connection(self, id: str, params: UpdateSsoConnectionParams) -> SsoConnection:
        """Update an SSO connection."""
        data = self._http.patch(f"/v1/sso/connections/{quote(id)}", params.to_dict())
        return SsoConnection.from_dict(data)

    def delete_connection(self, id: str) -> None:
        """Delete an SSO connection."""
        self._http.delete(f"/v1/sso/connections/{quote(id)}")

    def test_connection(self, id: str) -> SsoConnectionTestResult:
        """Test an SSO connection's IdP reachability."""
        data = self._http.post(f"/v1/sso/connections/{quote(id)}/test", {})
        return SsoConnectionTestResult.from_dict(data)

    # ── SSO enforcement ───────────────────────────────────────────────────

    def set_enforcement(self, params: SsoEnforcementParams) -> SsoEnforcementResponse:
        """Enable or disable org-wide SSO enforcement."""
        data = self._http.post("/v1/sso/enforce", params.to_dict())
        return SsoEnforcementResponse.from_dict(data)

    # ── SSO sessions ──────────────────────────────────────────────────────

    def list_sessions(self) -> ListSsoSessionsResponse:
        """List active SSO sessions."""
        data = self._http.get("/v1/sso/sessions")
        return ListSsoSessionsResponse.from_dict(data)

    def revoke_session(self, id: str) -> None:
        """Revoke an SSO session by ID."""
        self._http.delete(f"/v1/sso/sessions/{quote(id)}")

    # ── SSO login flow ────────────────────────────────────────────────────

    def get_login_url(self, org: str, domain: str | None = None) -> SsoLoginResponse:
        """Get the IdP authorization URL. Optionally pass a domain for auto-routing."""
        url = f"/sso/login?org={quote(org)}"
        if domain is not None:
            url += f"&domain={quote(domain)}"
        data = self._http.get(url)
        return SsoLoginResponse.from_dict(data)

    def handle_oidc_callback(self, params: SsoOidcCallbackParams) -> SsoCallbackResult:
        """Handle an OIDC callback with ID-token verification."""
        data = self._http.post("/sso/callback/oidc", params.to_dict())
        return SsoCallbackResult.from_dict(data)

    def handle_saml_callback(self, params: SsoSamlCallbackParams) -> SsoCallbackResult:
        """Handle a SAML callback with assertion verification."""
        data = self._http.post("/sso/callback/saml", params.to_dict())
        return SsoCallbackResult.from_dict(data)

    def handle_ldap_callback(self, params: SsoLdapCallbackParams) -> SsoCallbackResult:
        """Handle an LDAP callback with bind authentication."""
        data = self._http.post("/sso/callback/ldap", params.to_dict())
        return SsoCallbackResult.from_dict(data)

    # ── Legacy methods (backward compatible) ──────────────────────────────

    def create_config(self, params: CreateSsoConfigParams) -> SsoConfig:
        """Create or update the OIDC SSO configuration for this developer org.

        .. deprecated:: Use :meth:`create_connection` instead.
        """
        data = self._http.post("/v1/sso/config", params.to_dict())
        return SsoConfig.from_dict(data)

    def get_config(self) -> SsoConfig:
        """Get the current SSO configuration (client secret is not returned).

        .. deprecated:: Use :meth:`list_connections` instead.
        """
        data = self._http.get("/v1/sso/config")
        return SsoConfig.from_dict(data)

    def delete_config(self) -> None:
        """Remove the SSO configuration.

        .. deprecated:: Use :meth:`delete_connection` instead.
        """
        self._http.delete("/v1/sso/config")

    def handle_callback(self, code: str, state: str) -> SsoCallbackResponse:
        """Exchange the OIDC authorization code for user info.

        .. deprecated:: Use :meth:`handle_oidc_callback` instead.
        """
        path = f"/sso/callback?code={quote(code)}&state={quote(state)}"
        data = self._http.get(path)
        return SsoCallbackResponse.from_dict(data)

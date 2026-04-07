from __future__ import annotations

import os
from typing import Any, Callable

import httpx

from ._http import HttpClient
from ._types import (
    AuthorizationRequest,
    AuthorizeParams,
    RateLimit,
    RotateKeyResponse,
    SignupParams,
    SignupResponse,
    UpdateDeveloperSettingsParams,
    UpdateDeveloperSettingsResponse,
)
from .resources._agents import AgentsClient
from .resources._audit import AuditClient
from .resources._anomalies import AnomaliesClient
from .resources._scim import ScimClient
from .resources._sso import SsoClient
from .resources._compliance import ComplianceClient
from .resources._grants import GrantsClient
from .resources._tokens import TokensClient
from .resources._webhooks import WebhooksClient
from .resources._billing import BillingClient
from .resources._policies import PoliciesClient
from .resources._principal_sessions import PrincipalSessionsClient
from .resources._vault import VaultClient
from .resources._budgets import BudgetsClient
from .resources._events import EventsClient
from .resources._usage import UsageClient
from .resources._domains import DomainsClient
from .resources._webauthn import WebAuthnClient
from .resources._credentials import CredentialsClient
from .resources._passports import PassportsClient
from .resources._dpdp import DpdpClient
from .manifest import ToolManifest, Permission, EnforceResult
from ._verify import verify_grant_token
from ._types import VerifyGrantTokenOptions

_DEFAULT_BASE_URL = "https://api.grantex.dev"


class Grantex:
    """Main entry point for the Grantex SDK."""

    agents: AgentsClient
    grants: GrantsClient
    tokens: TokensClient
    audit: AuditClient
    webhooks: WebhooksClient
    billing: BillingClient
    policies: PoliciesClient
    compliance: ComplianceClient
    anomalies: AnomaliesClient
    scim: ScimClient
    sso: SsoClient
    principal_sessions: PrincipalSessionsClient
    vault: VaultClient
    budgets: BudgetsClient
    events: EventsClient
    usage: UsageClient
    domains: DomainsClient
    webauthn: WebAuthnClient
    credentials: CredentialsClient
    passports: PassportsClient
    dpdp: DpdpClient

    @property
    def last_rate_limit(self) -> RateLimit | None:
        return self._http.last_rate_limit

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 3,
        enforce_mode: str = "strict",
    ) -> None:
        resolved_key = api_key or os.environ.get("GRANTEX_API_KEY", "")
        if not resolved_key:
            raise ValueError(
                "Grantex API key is required. Pass `api_key` or set the "
                "GRANTEX_API_KEY environment variable."
            )

        self._enforce_mode = enforce_mode

        self._http = HttpClient(
            base_url=base_url,
            api_key=resolved_key,
            timeout=timeout,
            max_retries=max_retries,
        )

        self.agents = AgentsClient(self._http)
        self.grants = GrantsClient(self._http)
        self.tokens = TokensClient(self._http)
        self.audit = AuditClient(self._http)
        self.webhooks = WebhooksClient(self._http)
        self.billing = BillingClient(self._http)
        self.policies = PoliciesClient(self._http)
        self.compliance = ComplianceClient(self._http)
        self.anomalies = AnomaliesClient(self._http)
        self.scim = ScimClient(self._http)
        self.sso = SsoClient(self._http)
        self.principal_sessions = PrincipalSessionsClient(self._http)
        self.vault = VaultClient(self._http, base_url)
        self.budgets = BudgetsClient(self._http)
        self.events = EventsClient(base_url, resolved_key)
        self.usage = UsageClient(self._http)
        self.domains = DomainsClient(self._http)
        self.webauthn = WebAuthnClient(self._http)
        self.credentials = CredentialsClient(self._http)
        self.passports = PassportsClient(self._http)
        self.dpdp = DpdpClient(self._http)
        self._manifests: dict[str, ToolManifest] = {}
        self._jwks_uri = f"{base_url.rstrip('/')}/.well-known/jwks.json"

    @staticmethod
    def signup(
        params: SignupParams,
        *,
        base_url: str = _DEFAULT_BASE_URL,
    ) -> SignupResponse:
        """Create a new developer account without an API key.

        Returns the developer ID and a one-time API key.
        """
        url = f"{base_url.rstrip('/')}/v1/signup"
        response = httpx.post(
            url,
            json=params.to_dict(),
            headers={"Accept": "application/json"},
        )
        if not response.is_success:
            body = None
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
        return SignupResponse.from_dict(response.json())

    def rotate_key(self) -> RotateKeyResponse:
        """Rotate the current API key. Returns a new key; the old key is invalidated."""
        data = self._http.post("/v1/keys/rotate")
        return RotateKeyResponse.from_dict(data)

    def update_settings(
        self, params: UpdateDeveloperSettingsParams
    ) -> UpdateDeveloperSettingsResponse:
        """Update developer settings (e.g. FIDO/WebAuthn requirements)."""
        data = self._http.patch("/v1/me", params.to_dict())
        return UpdateDeveloperSettingsResponse.from_dict(data)

    def authorize(self, params: AuthorizeParams) -> AuthorizationRequest:
        """Initiate the delegated authorization flow for a user.

        `user_id` is transparently mapped to `principalId` in the request body.
        """
        data = self._http.post("/v1/authorize", params.to_dict())
        return AuthorizationRequest.from_dict(data)

    def load_manifest(self, manifest: ToolManifest) -> None:
        """Load a tool manifest for scope enforcement."""
        self._manifests[manifest.connector] = manifest

    def load_manifests(self, manifests: list[ToolManifest]) -> None:
        """Load multiple tool manifests at once."""
        for m in manifests:
            self._manifests[m.connector] = m

    def load_manifests_from_dir(self, dir_path: str) -> None:
        """Load all JSON manifest files from a directory."""
        import os
        for fname in sorted(os.listdir(dir_path)):
            if fname.endswith(".json"):
                self.load_manifest(ToolManifest.from_file(os.path.join(dir_path, fname)))

    def enforce(
        self,
        grant_token: str,
        connector: str,
        tool: str,
        amount: float | None = None,
    ) -> EnforceResult:
        """Enforce scope for a tool call.

        1. Verifies the grant token JWT offline (JWKS cached, <1ms after first call)
        2. Looks up the tool's required permission from loaded manifests
        3. Checks if the granted scope level covers the required permission

        Fails closed: unknown connectors/tools are denied by default.

        Example::

            result = grantex.enforce(
                grant_token=token,
                connector="salesforce",
                tool="delete_contact",
            )
            if not result.allowed:
                raise PermissionError(result.reason)
        """
        grant_id = ""
        agent_did = ""
        scopes: list[str] = []
        permission = ""

        # 1. Verify the token offline via JWKS
        try:
            grant = verify_grant_token(
                grant_token,
                VerifyGrantTokenOptions(jwks_uri=self._jwks_uri),
            )
        except Exception as e:
            return self._apply_enforce_mode(EnforceResult(
                allowed=False, reason=f"Token verification failed: {e}",
                grant_id=grant_id, agent_did=agent_did, scopes=scopes,
                permission=permission, connector=connector, tool=tool,
            ))

        grant_id = getattr(grant, "grant_id", "")
        agent_did = getattr(grant, "agent_did", "")
        scopes = list(getattr(grant, "scopes", []))

        def _denied(reason: str) -> EnforceResult:
            return EnforceResult(
                allowed=False, reason=reason,
                grant_id=grant_id, agent_did=agent_did, scopes=scopes,
                permission=permission, connector=connector, tool=tool,
            )

        # 2. Look up manifest for the connector
        manifest = self._manifests.get(connector)
        if not manifest:
            return self._apply_enforce_mode(_denied(f"No manifest loaded for connector '{connector}'. Load a manifest first."))

        # 3. Look up tool permission from manifest
        required_permission = manifest.get_permission(tool)
        if not required_permission:
            return self._apply_enforce_mode(_denied(f"Unknown tool '{tool}' on connector '{connector}'. Tool not found in manifest."))
        permission = required_permission

        # 4. Find the best matching scope for this connector
        granted_permission = self._resolve_granted_permission(scopes, connector)
        if not granted_permission:
            return self._apply_enforce_mode(_denied(f"No scope grants access to connector '{connector}'."))

        # 5. Check permission hierarchy
        if not Permission.covers(granted_permission, required_permission):
            return self._apply_enforce_mode(_denied(f"{granted_permission} scope does not permit {required_permission} operations on {connector}."))

        # 6. Check capped amount if provided
        if amount is not None:
            cap = self._extract_cap(scopes, connector)
            if cap is not None and amount > cap:
                return self._apply_enforce_mode(_denied(f"Amount {amount} exceeds budget cap of {cap} on {connector}."))

        return EnforceResult(
            allowed=True, reason="",
            grant_id=grant_id, agent_did=agent_did, scopes=scopes,
            permission=permission, connector=connector, tool=tool,
        )

    @staticmethod
    def _resolve_granted_permission(
        scopes: list[str], connector: str
    ) -> str | None:
        """Resolve the highest granted permission level for a connector."""
        levels = {"read": 0, "write": 1, "delete": 2, "admin": 3}
        best: str | None = None
        best_level = -1

        for scope in scopes:
            parts = scope.split(":")
            if len(parts) >= 3 and parts[0] in ("tool", "agenticorg") and parts[1] == connector:
                level = levels.get(parts[2], -1)
                if level > best_level:
                    best_level = level
                    best = parts[2]

        return best

    @staticmethod
    def _extract_cap(scopes: list[str], connector: str) -> float | None:
        """Extract budget cap from capped scopes."""
        for scope in scopes:
            parts = scope.split(":")
            if parts[0] == "tool" and len(parts) > 1 and parts[1] == connector:
                try:
                    idx = parts.index("capped")
                    if idx + 1 < len(parts):
                        return float(parts[idx + 1])
                except ValueError:
                    continue
        return None

    def _apply_enforce_mode(self, result: EnforceResult) -> EnforceResult:
        """In permissive mode, allow denied results with a warning."""
        if not result.allowed and self._enforce_mode == "permissive":
            import warnings
            warnings.warn(
                f"[grantex] PERMISSIVE MODE — would deny: {result.reason} "
                f"(connector={result.connector}, tool={result.tool})",
                stacklevel=2,
            )
            return EnforceResult(
                allowed=True,
                reason=result.reason,
                grant_id=result.grant_id,
                agent_did=result.agent_did,
                scopes=result.scopes,
                permission=result.permission,
                connector=result.connector,
                tool=result.tool,
            )
        return result

    def wrap_tool(
        self,
        tool: Any,
        *,
        connector: str,
        tool_name: str,
        grant_token: str | Callable[[], str],
    ) -> Any:
        """Wrap a LangChain StructuredTool with automatic Grantex scope enforcement.

        Before each invocation, the grant token is verified and scopes are checked.
        If denied, raises PermissionError instead of calling the tool.

        Args:
            tool: A LangChain StructuredTool or compatible object with _run/_arun methods.
            connector: Connector name for scope lookup.
            tool_name: Tool name for manifest permission lookup.
            grant_token: Static token string or callable that returns the current token.

        Example::

            protected = grantex.wrap_tool(
                my_tool,
                connector="salesforce",
                tool_name="create_lead",
                grant_token=lambda: state["grant_token"],
            )
        """
        from typing import Callable as _Callable
        grantex = self

        original_run = getattr(tool, '_run', None)
        original_arun = getattr(tool, '_arun', None)

        def _get_token() -> str:
            return grant_token() if callable(grant_token) else grant_token

        def _check() -> None:
            token = _get_token()
            result = grantex.enforce(grant_token=token, connector=connector, tool=tool_name)
            # Retry once with refreshed token if expired and grant_token is callable
            if not result.allowed and "expired" in result.reason.lower() and callable(grant_token):
                token = _get_token()
                result = grantex.enforce(grant_token=token, connector=connector, tool=tool_name)
            if not result.allowed:
                raise PermissionError(f"Grantex scope denied: {result.reason}")

        if original_run:
            original = original_run
            def wrapped_run(*args: Any, **kwargs: Any) -> Any:
                _check()
                return original(*args, **kwargs)
            tool._run = wrapped_run

        if original_arun:
            original_async = original_arun
            async def wrapped_arun(*args: Any, **kwargs: Any) -> Any:
                _check()
                return await original_async(*args, **kwargs)
            tool._arun = wrapped_arun

        return tool

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Grantex:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

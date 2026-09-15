from __future__ import annotations

import math
import os
import re
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
from .resources._commerce import CommerceClient
from .prepaid_wallets import WalletSpendPoliciesClient
from .manifest import ManifestValidationError, ToolManifest, Permission, EnforceResult
from .denials import (
    CapSubReason,
    DenialReason,
    ManifestSubReason,
    PurposeSubReason,
    TokenSubReason,
    ToolSubReason,
)
from ._authorization_details import (
    AuthorizationDetailsError,
    DecisionReference,
    ToolsAuthorization,
    parse_decision_references,
    parse_tools_authorization,
)
from .purpose import is_known_purpose, match_purpose
from .caps import (
    MALFORMED_GRANT_CAPS,
    CapExceededError,
    CapsConfigurationError,
    CapsMeter,
    MeterUnavailableError,
    Reservation,
    build_cap_limits,
)
from ._verify import verify_grant_token
from ._types import VerifyGrantTokenOptions

_DEFAULT_BASE_URL = "https://api.grantex.dev"


_CAP_RE = re.compile(r"^\d+(\.\d+)?$")

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
    commerce: CommerceClient
    wallet_spend_policies: WalletSpendPoliciesClient

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
        caps_meter: CapsMeter | None = None,
        legacy_claims: bool = True,
    ) -> None:
        resolved_key = (api_key or os.environ.get("GRANTEX_API_KEY", "")).strip()
        if not resolved_key:
            raise ValueError(
                "Grantex API key is required. Pass `api_key` or set the "
                "GRANTEX_API_KEY environment variable."
            )

        self._enforce_mode = enforce_mode
        self._caps_meter = caps_meter
        # Whether enforce() reads legacy grant token claim aliases; True in 0.6,
        # False by default from 0.7.
        self._legacy_claims = legacy_claims

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
        self.commerce = CommerceClient(self._http)
        self.wallet_spend_policies = WalletSpendPoliciesClient(self._http)
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
        *,
        case_id: str | None = None,
        cost_components: list[str] | None = None,
    ) -> EnforceResult:
        """Enforce scope for a tool call.

        When the tool (manifest) or the grant declares caps, the call is
        metered with the client's ``caps_meter``: units are reserved as the
        last step, only if every other check passed, and ``result.reservation``
        identifies them. ``case_id`` is required for per-case caps;
        ``cost_components`` names the manifest cost units the call incurs
        (default: all of them). Reserve means the call counts even if it later
        fails; see ``CapsMeter.refund_unsent``.

        1. Verifies the grant token JWT locally using the issuer's JWKS
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

        # 1. Verify the token locally using JWKS retrieved from the configured URI
        try:
            grant = verify_grant_token(
                grant_token,
                VerifyGrantTokenOptions(
                    jwks_uri=self._jwks_uri, legacy_claims=self._legacy_claims
                ),
            )
        except Exception as e:
            return self._apply_enforce_mode(EnforceResult(
                allowed=False, reason=f"Token verification failed: {e}",
                grant_id=grant_id, agent_did=agent_did, scopes=scopes,
                permission=permission, connector=connector, tool=tool,
                reason_code=DenialReason.TOKEN_INVALID,
            ))

        grant_id = getattr(grant, "grant_id", "")
        agent_did = getattr(grant, "agent_did", "")
        scopes = list(getattr(grant, "scopes", []))

        result_purpose = ""

        def _denied(
            reason: str,
            code: str,
            sub_reason: str = "",
            details: dict[str, Any] | None = None,
        ) -> EnforceResult:
            return self._apply_enforce_mode(EnforceResult(
                allowed=False, reason=reason,
                grant_id=grant_id, agent_did=agent_did, scopes=scopes,
                permission=permission, connector=connector, tool=tool,
                reason_code=code, sub_reason=sub_reason, details=dict(details or {}),
                purpose=result_purpose,
            ))

        # 2. Read the grant's tools authorization for this connector. A claim
        #    that cannot be read unambiguously denies every call.
        try:
            tools_auth = parse_tools_authorization(
                getattr(grant, "authorization_details", None)
            )
            decision_refs = parse_decision_references(
                getattr(grant, "authorization_details", None)
            )
        except AuthorizationDetailsError as exc:
            return _denied(
                f"Grant token authorization_details cannot be used: {exc}.",
                DenialReason.TOKEN_INVALID, TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
            )
        entry: ToolsAuthorization | None = tools_auth.get(connector)
        decision_ref: DecisionReference | None = decision_refs.get(connector)
        purpose = entry.purpose if entry is not None else None
        result_purpose = purpose or ""

        # 3. Look up manifest for the connector
        manifest = self._manifests.get(connector)
        if not manifest:
            return _denied(
                f"No manifest loaded for connector '{connector}'. Load a manifest first.",
                DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.UNKNOWN_CONNECTOR,
            )

        # 4. Look up tool permission from manifest
        required_permission = manifest.get_permission(tool)
        if not required_permission:
            return _denied(
                f"Unknown tool '{tool}' on connector '{connector}'. Tool not found in manifest.",
                DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.UNKNOWN_TOOL,
            )
        permission = required_permission
        try:
            spec = manifest.get_tool_spec(tool)
        except ManifestValidationError as exc:
            return _denied(
                f"Tool '{tool}' on connector '{connector}' has an invalid declaration: {exc}",
                DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.INVALID_DECLARATION,
            )
        if spec is None:
            return _denied(
                f"Unknown tool '{tool}' on connector '{connector}'. Tool not found in manifest.",
                DenialReason.MANIFEST_UNKNOWN_TOOL, ManifestSubReason.UNKNOWN_TOOL,
            )

        # 5. Find the best matching scope for this connector
        granted_permission = self._resolve_granted_permission(scopes, connector)
        if not granted_permission:
            return _denied(
                f"No scope grants access to connector '{connector}'.",
                DenialReason.TOOL_NOT_GRANTED,
            )

        # 6. Check permission hierarchy
        if not Permission.covers(granted_permission, required_permission):
            return _denied(
                f"{granted_permission} scope does not permit {required_permission} operations on {connector}.",
                DenialReason.PERMISSION_INSUFFICIENT,
            )

        # 7. The grant's tools list, when it has one, must name the tool.
        if entry is not None and not entry.allows_tool(tool):
            return _denied(
                f"Grant does not list tool '{tool}' on connector '{connector}'.",
                DenialReason.TOOL_NOT_GRANTED, ToolSubReason.NOT_IN_AUTHORIZATION_DETAILS,
            )

        # 8. Purpose. A tool that declares allowed_purposes needs a grant whose
        #    purpose is known and matches one of them.
        if spec.allowed_purposes is not None:
            allowed = list(spec.allowed_purposes)
            if purpose is None:
                return _denied(
                    f"Tool '{tool}' on {connector} is restricted to purposes "
                    f"{', '.join(allowed)}; the grant carries no purpose.",
                    DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.MISSING,
                    {"allowed_purposes": allowed},
                )
            if not is_known_purpose(purpose):
                return _denied(
                    f"Grant purpose {purpose!r} is not in the purpose vocabulary.",
                    DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.UNKNOWN_PURPOSE,
                    {"allowed_purposes": allowed, "purpose": purpose},
                )
            if match_purpose(allowed, purpose) is None:
                return _denied(
                    f"Grant purpose '{purpose}' is not allowed for tool '{tool}' on "
                    f"{connector}; allowed purposes: {', '.join(allowed)}.",
                    DenialReason.PURPOSE_NOT_ALLOWED, PurposeSubReason.NOT_MATCHED,
                    {"allowed_purposes": allowed, "purpose": purpose},
                )

        # 9. Decision. Decision grants are not accepted yet, so a tool that
        #    requires one, in the manifest or in the grant's decision
        #    references, is always denied.
        if spec.requires_decision or (decision_ref is not None and tool in decision_ref.tools):
            return _denied(
                f"Tool '{tool}' on {connector} requires a decision grant.",
                DenialReason.DECISION_REQUIRED,
            )

        # 10. Check capped amount if provided
        if amount is not None:
            if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount):
                return _denied(
                    f"Amount must be a finite number to enforce a budget cap on {connector}.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.INVALID_AMOUNT,
                )
            try:
                cap = self._extract_cap(scopes, connector)
            except ValueError:
                return _denied(
                    f"A capped scope on {connector} carries a malformed cap; refusing to authorize amount {amount}.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.MALFORMED_CAP,
                )
            if cap is not None and amount > cap:
                return _denied(
                    f"Amount {amount} exceeds budget cap of {cap} on {connector}.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.AMOUNT_CAP,
                    {"limit": cap, "amount": amount},
                )

        # 11. Call caps and cost units (declared by the manifest or by the
        #     grant). Reserving is the last step, so a denied call never
        #     consumes a cap; without a meter the call is denied.
        grant_caps = entry.caps if entry is not None else None
        grant_caps_apply = grant_caps is not None and (
            tool in grant_caps or (spec.cost_units is not None and "cost_units" in grant_caps)
        )
        reservation: Reservation | None = None
        if spec.caps is not None or spec.cost_units is not None or grant_caps_apply:
            meter = self._caps_meter
            if meter is None:
                return _denied(
                    f"Tool '{tool}' on {connector} declares caps or cost units and no "
                    "caps meter is configured.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE,
                )
            try:
                limits = build_cap_limits(
                    connector=connector, tool=tool, spec=spec, grant_id=grant_id,
                    grant_caps=grant_caps, case_id=case_id, cost_components=cost_components,
                )
            except CapsConfigurationError as exc:
                if exc.sub_reason == MALFORMED_GRANT_CAPS:
                    return _denied(
                        f"Grant token authorization_details cannot be used: {exc}.",
                        DenialReason.TOKEN_INVALID, TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
                    )
                return _denied(
                    f"Cannot meter tool '{tool}' on {connector}: {exc}.",
                    DenialReason.CAP_EXCEEDED, exc.sub_reason,
                )
            try:
                reservation = meter.reserve(getattr(grant, "developer_id", ""), limits)
            except CapExceededError as exc:
                return _denied(
                    f"{exc} on {connector}.{tool}.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.LIMIT_REACHED,
                    {
                        "code": exc.code, "limit": exc.limit, "window": exc.window,
                        "used": exc.used, "requested": exc.requested,
                        "scope": exc.scope, "kind": exc.kind,
                    },
                )
            except (MeterUnavailableError, CapsConfigurationError) as exc:
                return _denied(
                    f"Caps meter could not evaluate tool '{tool}' on {connector}: {exc}.",
                    DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE,
                )

        return EnforceResult(
            allowed=True, reason="",
            grant_id=grant_id, agent_did=agent_did, scopes=scopes,
            permission=permission, connector=connector, tool=tool,
            purpose=result_purpose, reservation=reservation,
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
        """Extract the tightest budget cap from capped scopes for a connector.

        Returning the first capped scope encountered let
        ``tool:x:read:capped:1000`` shadow ``tool:x:write:capped:10`` purely by
        ordering, and a malformed cap (``capped:abc``) silently disabled the
        check. A malformed or negative cap now raises ``ValueError`` so the
        caller fails closed.
        """
        cap: float | None = None
        for scope in scopes:
            parts = scope.split(":")
            if parts[0] not in ("tool", "agenticorg") or len(parts) < 2 or parts[1] != connector:
                continue
            if "capped" not in parts:
                continue
            idx = parts.index("capped")
            raw = parts[idx + 1] if idx + 1 < len(parts) else ""
            if not _CAP_RE.match(raw):
                raise ValueError(f"malformed cap in scope {scope!r}")
            value = float(raw)
            cap = value if cap is None else min(cap, value)
        return cap

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
                reason_code=result.reason_code,
                sub_reason=result.sub_reason,
                details=result.details,
                purpose=result.purpose,
                reservation=result.reservation,
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

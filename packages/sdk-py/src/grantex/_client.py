from __future__ import annotations

import dataclasses
import math
import os
import re
from typing import Any, Callable, Mapping, Sequence

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
    CAPS_MODES,
    CAPS_ENFORCE,
    CAPS_OFF,
    CAPS_WARN,
    MALFORMED_GRANT_CAPS,
    CapLimit,
    CapExceededError,
    CapsConfigurationError,
    CapsMeter,
    MeterUnavailableError,
    Reservation,
    build_cap_limits,
)
from ._verify import _derive_issuer_from_jwks_uri, verify_grant_token
from .denials import DecisionSubReason
from .decisions import (
    DECISIONS_MODES,
    DECISIONS_WARN,
    ActionValidationError,
    ConsumedDecision,
    DecisionAction,
    DecisionConsumer,
    DecisionGrantError,
    DecisionGrantSet,
    DecisionsClient,
    verify_decision_grants,
)
from .decisions._client import _ClientConsumer
from ._types import VerifyGrantTokenOptions

_DEFAULT_BASE_URL = "https://api.grantex.dev"


_CAP_RE = re.compile(r"^\d+(\.\d+)?$")


def _check_decisions_mode(mode: object) -> str:
    if mode not in DECISIONS_MODES:
        raise ValueError(f"decisions_mode must be one of {', '.join(DECISIONS_MODES)}, not {mode!r}")
    return str(mode)


def _check_caps_mode(mode: object) -> str:
    if mode not in CAPS_MODES:
        raise ValueError(f"caps_mode must be one of {', '.join(CAPS_MODES)}, not {mode!r}")
    return str(mode)


def _check_caps(meter: CapsMeter, tenant_id: str, limits: tuple[CapLimit, ...]) -> None:
    """Raise CapExceededError if reserving ``limits`` now would exceed a cap.

    A point-in-time check that consumes nothing: a concurrent call can still
    take the last unit before the reservation is made.
    """
    for usage in meter.usage(tenant_id, limits):
        limit = usage.limit
        if limit.units > 0 and (limit.limit == 0 or usage.used + limit.units > limit.limit):
            raise CapExceededError(
                limit=limit.limit, window=limit.window, used=usage.used,
                requested=limit.units, scope=limit.scope, kind=limit.kind,
            )

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
    decisions: DecisionsClient

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
        caps_mode: str = CAPS_ENFORCE,
        decisions_mode: str = "enforce",
        decision_consumer: DecisionConsumer | None = None,
        decision_algorithms: Sequence[str] = ("RS256", "ES256"),
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
        self._caps_mode = _check_caps_mode(caps_mode)
        self._decisions_mode = _check_decisions_mode(decisions_mode)
        if not decision_algorithms or any(a not in ("RS256", "ES256") for a in decision_algorithms):
            raise ValueError("decision_algorithms must be a non-empty subset of RS256, ES256")
        self._decision_algorithms = tuple(decision_algorithms)

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
        self.decisions = DecisionsClient(self._http)
        self._decision_consumer: DecisionConsumer = (
            decision_consumer if decision_consumer is not None else _ClientConsumer(self.decisions)
        )
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
                body = None
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
        reserve: bool = True,
        caps_mode: str | None = None,
        caps_tenant_id: str | None = None,
        decision_grants: Sequence[str] | None = None,
        decision_action: DecisionAction | Mapping[str, Any] | None = None,
        arguments: Mapping[str, Any] | None = None,
        case_version: str | None = None,
        decisions_mode: str | None = None,
    ) -> EnforceResult:
        """Enforce scope for a tool call.

        When the tool (manifest) or the grant declares caps, the call is
        metered with the client's ``caps_meter``: units are reserved as the
        last step, only if every other check passed, and ``result.reservation``
        identifies them. A reserved call counts even if it later fails; see
        ``CapsMeter.refund_unsent``.

        - ``case_id`` (required for per-case caps) and ``cost_components`` (the
          manifest cost units the call incurs; default all of them) must come
          from the tool gateway, never from the agent or model.
        - ``reserve=False`` checks the caps against current usage without
          consuming anything; ``result.cap_limits`` and
          ``result.caps_tenant_id`` can then be reserved with
          ``CapsMeter.reserve`` at the call that incurs cost, or call
          ``enforce()`` again there with ``reserve=True``.
        - ``caps_mode`` overrides the client's mode: ``enforce`` denies,
          ``warn`` allows a call a cap would deny and reports it in
          ``result.would_deny`` (reserving only calls that fit), ``off``
          skips caps.
        - ``caps_tenant_id`` replaces the grant's developer as the tenant of
          every counter of this call.

        For a tool whose manifest entry has ``requires_decision`` (PRD G-3):

        - ``decision_grants`` are the decision grant tokens for this call (one,
          or two for a decision in ``four_eyes_on``). Without them the call is
          denied with ``decision_required``.
        - The action they must approve is ``decision_action``, or is derived
          from the call's ``arguments`` (tool name plus ``case_id``,
          ``decision``, ``subject``, ``amount``). ``case_version`` is the case's
          current version from the application's own case state.
        - The grants are verified offline (signature, issuer, audience, expiry,
          developer, connector, action hash, case version, four eyes) and then
          consumed at the auth service as the last step, after caps are
          reserved; a failed consumption releases the reservation. Any failure
          is ``decision_invalid`` with a ``DecisionSubReason``.
          ``result.decision`` records what was consumed.
        - A tool's ``decision_fields`` (manifest) are read from ``arguments``
          into the action. When both ``decision_action`` and ``arguments`` are
          given they must describe the same action (``action_mismatch``).
        - Consumption spends the grant. If the consumption response is lost,
          or the tool call fails after consumption, the grant is still spent
          and the person must approve again.
        - ``decisions_mode`` overrides the client's mode: ``enforce`` denies;
          ``warn`` allows the call, still consumes valid grants, and reports
          the denial in ``result.would_deny``. Platforms map their
          ``decisions.required`` flag to ``enforce`` (on) or ``warn`` (off).

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

        # 9. Decision. A tool that requires a decision, in the manifest or in
        #    the grant's decision references, needs decision grants that verify
        #    offline for this exact action; they are consumed at the issuer as
        #    the last step, after caps are reserved. A decision needs two
        #    approvers if either the manifest or the grant says so.
        decision_mode = self._decisions_mode if decisions_mode is None else _check_decisions_mode(decisions_mode)
        decision_set: DecisionGrantSet | None = None
        would_deny: dict[str, Any] | None = None
        ref_tools = decision_ref.tools if decision_ref is not None else ()
        if spec.requires_decision or tool in ref_tools:
            four_eyes_on = tuple(spec.four_eyes_on) + tuple(
                d for d in (decision_ref.four_eyes_on.get(tool, ()) if decision_ref is not None else ())
                if d not in spec.four_eyes_on
            )
            requirement = {"decision_required": f"{connector}:{tool}"}
            decision_denial: tuple[str, str, str] | None = None
            try:
                decision_set = self._verify_decision(
                    grant, connector, tool, four_eyes_on, spec.decision_fields,
                    decision_grants, decision_action, arguments, case_version,
                )
            except DecisionGrantError as exc:
                if exc.sub_reason == DecisionSubReason.ABSENT:
                    decision_denial = (
                        DenialReason.DECISION_REQUIRED, "",
                        f"Tool '{tool}' on {connector} requires a decision grant.",
                    )
                else:
                    decision_denial = (
                        DenialReason.DECISION_INVALID, exc.sub_reason,
                        f"The decision grant for tool '{tool}' on {connector} is not valid: {exc}",
                    )
            if decision_denial is not None:
                code, sub_reason, message = decision_denial
                if decision_mode != DECISIONS_WARN:
                    return _denied(message, code, sub_reason, requirement)
                would_deny = {
                    "reason_code": code, "sub_reason": sub_reason,
                    "reason": message, "details": requirement,
                }

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
        mode = self._caps_mode if caps_mode is None else _check_caps_mode(caps_mode)
        grant_caps = entry.caps if entry is not None else None
        grant_caps_apply = grant_caps is not None and (
            tool in grant_caps or (spec.cost_units is not None and "cost_units" in grant_caps)
        )
        reservation: Reservation | None = None
        cap_limits: tuple[CapLimit, ...] = ()
        caps_tenant = caps_tenant_id if caps_tenant_id is not None else getattr(grant, "developer_id", "")
        caps_declared = spec.caps is not None or spec.cost_units is not None or grant_caps_apply
        if caps_declared and mode != CAPS_OFF:
            # (reason, sub_reason, message, details) when the caps would deny.
            cap_denial: tuple[str, str, str, dict[str, Any]] | None = None
            meter = self._caps_meter
            if meter is None:
                cap_denial = (
                    DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE,
                    f"Tool '{tool}' on {connector} declares caps or cost units and no "
                    "caps meter is configured.", {},
                )
            else:
                try:
                    cap_limits = tuple(build_cap_limits(
                        connector=connector, tool=tool, spec=spec, grant_id=grant_id,
                        grant_caps=grant_caps, case_id=case_id, cost_components=cost_components,
                    ))
                except CapsConfigurationError as exc:
                    if exc.sub_reason == MALFORMED_GRANT_CAPS:
                        # A token problem, not a cap decision: denied in every mode.
                        return _denied(
                            f"Grant token authorization_details cannot be used: {exc}.",
                            DenialReason.TOKEN_INVALID, TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
                        )
                    cap_denial = (
                        DenialReason.CAP_EXCEEDED, exc.sub_reason,
                        f"Cannot meter tool '{tool}' on {connector}: {exc}.", {},
                    )
                if cap_denial is None:
                    try:
                        if reserve:
                            reservation = meter.reserve(caps_tenant, cap_limits)
                        else:
                            _check_caps(meter, caps_tenant, cap_limits)
                    except CapExceededError as exc:
                        cap_denial = (
                            DenialReason.CAP_EXCEEDED, CapSubReason.LIMIT_REACHED,
                            f"{exc} on {connector}.{tool}.",
                            {
                                "code": exc.code, "limit": exc.limit, "window": exc.window,
                                "used": exc.used, "requested": exc.requested,
                                "scope": exc.scope, "kind": exc.kind,
                            },
                        )
                    except (MeterUnavailableError, CapsConfigurationError) as exc:
                        cap_denial = (
                            DenialReason.CAP_EXCEEDED, CapSubReason.METER_UNAVAILABLE,
                            f"Caps meter could not evaluate tool '{tool}' on {connector}: {exc}.", {},
                        )
            if cap_denial is not None:
                code, sub_reason, message, details = cap_denial
                if mode != CAPS_WARN:
                    return _denied(message, code, sub_reason, details)
                if would_deny is None:
                    would_deny = {
                        "reason_code": code, "sub_reason": sub_reason,
                        "reason": message, "details": details,
                    }

        # 12. Consume the decision grants at the issuer. Offline verification
        #     alone never allows a call: one grant authorises one call.
        consumed: ConsumedDecision | None = None
        if decision_set is not None:
            try:
                consumed = self._decision_consumer.consume(decision_set, grant_id=grant_id or None)
            except Exception as exc:  # noqa: BLE001 - any failure leaves the grant unconsumed: deny
                sub_reason = exc.sub_reason if isinstance(exc, DecisionGrantError) else DecisionSubReason.CONSUME_UNAVAILABLE
                if reservation is not None and self._caps_meter is not None:
                    try:
                        self._caps_meter.refund_unsent(reservation)
                    except Exception:  # noqa: BLE001 - the call is refused either way
                        pass
                    reservation = None
                message = f"The decision grant for tool '{tool}' on {connector} was not consumed: {exc}"
                details = {"decision_required": f"{connector}:{tool}"}
                if decision_mode != DECISIONS_WARN:
                    return _denied(message, DenialReason.DECISION_INVALID, sub_reason, details)
                if would_deny is None:
                    would_deny = {
                        "reason_code": DenialReason.DECISION_INVALID, "sub_reason": sub_reason,
                        "reason": message, "details": details,
                    }

        return EnforceResult(
            allowed=True, reason="",
            grant_id=grant_id, agent_did=agent_did, scopes=scopes,
            permission=permission, connector=connector, tool=tool,
            purpose=result_purpose, reservation=reservation,
            cap_limits=cap_limits, caps_tenant_id=caps_tenant if cap_limits else "",
            would_deny=would_deny, decision=consumed,
        )

    def _verify_decision(
        self,
        grant: Any,
        connector: str,
        tool: str,
        four_eyes_on: tuple[str, ...],
        decision_fields: tuple[str, ...],
        decision_grants: Sequence[str] | None,
        decision_action: DecisionAction | Mapping[str, Any] | None,
        arguments: Mapping[str, Any] | None,
        case_version: str | None,
    ) -> DecisionGrantSet:
        """Offline checks of the decision grants for one call (see ``enforce``)."""
        if decision_grants is None or len(decision_grants) == 0:
            raise DecisionGrantError(DecisionSubReason.ABSENT, "no decision grant was presented")
        try:
            from_arguments = (
                DecisionAction.from_tool_call(tool, arguments, decision_fields)
                if arguments is not None else None
            )
            given = (
                decision_action if isinstance(decision_action, DecisionAction)
                else DecisionAction.from_dict(decision_action)
            ) if decision_action is not None else None
        except ActionValidationError as exc:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, f"the call's action is invalid: {exc}") from exc
        if given is not None and from_arguments is not None and given.action_hash() != from_arguments.action_hash():
            # The call would do something other than what the caller says it approves.
            raise DecisionGrantError(
                DecisionSubReason.ACTION_MISMATCH,
                "decision_action does not match the action derived from the call's arguments",
            )
        action = given if given is not None else from_arguments
        if action is None:
            raise DecisionGrantError(
                DecisionSubReason.MALFORMED,
                "enforce() needs decision_action or arguments to compare the decision grant with",
            )
        missing_fields = [name for name in decision_fields if name not in action.extra]
        if missing_fields:
            raise DecisionGrantError(
                DecisionSubReason.MALFORMED,
                f"the action does not bind the declared decision fields: {', '.join(missing_fields)}",
            )
        if action.action != tool:
            raise DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, "the decision action names another tool")
        if not case_version:
            raise DecisionGrantError(DecisionSubReason.MALFORMED, "enforce() needs case_version for a decision")
        return verify_decision_grants(
            decision_grants, action, case_version,
            issuer=_derive_issuer_from_jwks_uri(self._jwks_uri),
            approvals_required=2 if action.decision in four_eyes_on else 1,
            jwks_uri=self._jwks_uri,
            developer_id=getattr(grant, "developer_id", None),
            connector=connector,
            algorithms=self._decision_algorithms,
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
            return dataclasses.replace(result, allowed=True)
        return result

    def wrap_tool(
        self,
        tool: Any,
        *,
        connector: str,
        tool_name: str,
        grant_token: str | Callable[[], str],
        case_id: str | Callable[[], str | None] | None = None,
        cost_components: list[str] | Callable[[], list[str] | None] | None = None,
        decision_grants: Sequence[str] | Callable[[], Sequence[str] | None] | None = None,
        case_version: str | Callable[[], str | None] | None = None,
    ) -> Any:
        """Wrap a LangChain StructuredTool with automatic Grantex scope enforcement.

        Before each invocation, the grant token is verified and scopes are checked.
        If denied, raises PermissionError instead of calling the tool. When the
        tool or grant declares caps, the call is reserved before the tool runs.

        Args:
            tool: A LangChain StructuredTool or compatible object with _run/_arun methods.
            connector: Connector name for scope lookup.
            tool_name: Tool name for manifest permission lookup.
            grant_token: Static token string or callable that returns the current token.
            case_id: Case for per-case caps, or a callable returning it per call.
            cost_components: Cost units the call incurs, or a callable returning them.
                Both must come from the application, never from the tool's
                (model-supplied) arguments.
            decision_grants: For a tool that requires a decision, the decision
                grant tokens (or a callable returning them per call). The action
                is derived from the tool call's keyword arguments.
            case_version: The case's current version (or a callable), from the
                application's case state.

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

        def _check(call_arguments: Mapping[str, Any]) -> None:
            token = _get_token()
            call_case = case_id() if callable(case_id) else case_id
            call_costs = cost_components() if callable(cost_components) else cost_components
            decision_kwargs: dict[str, Any] = {}
            if decision_grants is not None or case_version is not None:
                grants = decision_grants() if callable(decision_grants) else decision_grants
                version = case_version() if callable(case_version) else case_version
                decision_kwargs = {
                    "decision_grants": list(grants) if grants is not None else None,
                    "arguments": call_arguments,
                    "case_version": version,
                }
            result = grantex.enforce(
                grant_token=token, connector=connector, tool=tool_name,
                case_id=call_case, cost_components=call_costs, **decision_kwargs,
            )
            # Retry once with refreshed token if expired and grant_token is callable.
            # An expired token is denied before caps are reserved, so the retry
            # cannot reserve twice.
            if not result.allowed and "expired" in result.reason.lower() and callable(grant_token):
                token = _get_token()
                result = grantex.enforce(
                    grant_token=token, connector=connector, tool=tool_name,
                    case_id=call_case, cost_components=call_costs, **decision_kwargs,
                )
            if not result.allowed:
                raise PermissionError(f"Grantex scope denied: {result.reason}")

        if original_run:
            original = original_run
            def wrapped_run(*args: Any, **kwargs: Any) -> Any:
                _check(kwargs)
                return original(*args, **kwargs)
            tool._run = wrapped_run

        if original_arun:
            original_async = original_arun
            async def wrapped_arun(*args: Any, **kwargs: Any) -> Any:
                _check(kwargs)
                return await original_async(*args, **kwargs)
            tool._arun = wrapped_arun

        return tool

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Grantex:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

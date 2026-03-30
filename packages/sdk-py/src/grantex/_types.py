from __future__ import annotations

from dataclasses import dataclass
from typing import Any


# ─── Rate Limits ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RateLimit:
    limit: int
    remaining: int
    reset: int
    retry_after: int | None = None


# ─── Signup ───────────────────────────────────────────────────────────────────


@dataclass
class SignupParams:
    name: str
    email: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"name": self.name}
        if self.email is not None:
            body["email"] = self.email
        return body


@dataclass(frozen=True)
class SignupResponse:
    developer_id: str
    api_key: str
    name: str
    email: str | None
    mode: str
    created_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SignupResponse:
        return cls(
            developer_id=data["developerId"],
            api_key=data["apiKey"],
            name=data["name"],
            email=data.get("email"),
            mode=data["mode"],
            created_at=data["createdAt"],
        )


@dataclass(frozen=True)
class RotateKeyResponse:
    api_key: str
    rotated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RotateKeyResponse:
        return cls(
            api_key=data["apiKey"],
            rotated_at=data["rotatedAt"],
        )


# ─── Agent ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Agent:
    id: str
    did: str
    name: str
    description: str
    scopes: tuple[str, ...]
    status: str
    developer_id: str
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Agent:
        return cls(
            id=data.get("id") or data.get("agentId", ""),
            did=data.get("did", ""),
            name=data["name"],
            description=data.get("description", ""),
            scopes=tuple(data.get("scopes", [])),
            status=data["status"],
            developer_id=data["developerId"],
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
        )


@dataclass(frozen=True)
class ListAgentsResponse:
    agents: tuple[Agent, ...]
    total: int
    page: int
    page_size: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ListAgentsResponse:
        return cls(
            agents=tuple(Agent.from_dict(a) for a in data.get("agents", [])),
            total=data["total"],
            page=data["page"],
            page_size=data["pageSize"],
        )


# ─── Authorization ────────────────────────────────────────────────────────────


@dataclass
class AuthorizeParams:
    agent_id: str
    user_id: str
    scopes: list[str]
    expires_in: str | None = None
    redirect_uri: str | None = None
    code_challenge: str | None = None
    code_challenge_method: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agentId": self.agent_id,
            "principalId": self.user_id,
            "scopes": self.scopes,
        }
        if self.expires_in is not None:
            body["expiresIn"] = self.expires_in
        if self.redirect_uri is not None:
            body["redirectUri"] = self.redirect_uri
        if self.code_challenge is not None:
            body["codeChallenge"] = self.code_challenge
        if self.code_challenge_method is not None:
            body["codeChallengeMethod"] = self.code_challenge_method
        return body


@dataclass(frozen=True)
class AuthorizationRequest:
    request_id: str
    consent_url: str
    agent_id: str
    principal_id: str
    scopes: tuple[str, ...]
    expires_in: str
    expires_at: str
    status: str
    created_at: str
    code: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AuthorizationRequest:
        return cls(
            request_id=data.get("authRequestId", ""),
            consent_url=data.get("consentUrl", ""),
            agent_id=data.get("agentId", ""),
            principal_id=data.get("principalId", ""),
            scopes=tuple(data.get("scopes", [])),
            expires_in=data.get("expiresIn", ""),
            expires_at=data.get("expiresAt", ""),
            status=data.get("status", ""),
            created_at=data.get("createdAt", ""),
            code=data.get("code"),
        )


# ─── Grants ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Grant:
    id: str
    agent_id: str
    agent_did: str
    principal_id: str
    developer_id: str
    scopes: tuple[str, ...]
    status: str
    issued_at: str
    expires_at: str
    revoked_at: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Grant:
        return cls(
            id=data.get("id") or data.get("grantId", ""),
            agent_id=data.get("agentId", ""),
            agent_did=data.get("agentDid", ""),
            principal_id=data.get("principalId", ""),
            developer_id=data.get("developerId", ""),
            scopes=tuple(data.get("scopes", [])),
            status=data.get("status", ""),
            issued_at=data.get("issuedAt", ""),
            expires_at=data.get("expiresAt", ""),
            revoked_at=data.get("revokedAt"),
        )


@dataclass
class ListGrantsParams:
    agent_id: str | None = None
    principal_id: str | None = None
    status: str | None = None
    page: int | None = None
    page_size: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.agent_id is not None:
            result["agentId"] = self.agent_id
        if self.principal_id is not None:
            result["principalId"] = self.principal_id
        if self.status is not None:
            result["status"] = self.status
        if self.page is not None:
            result["page"] = self.page
        if self.page_size is not None:
            result["pageSize"] = self.page_size
        return result


@dataclass(frozen=True)
class ListGrantsResponse:
    grants: tuple[Grant, ...]
    total: int
    page: int
    page_size: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ListGrantsResponse:
        return cls(
            grants=tuple(Grant.from_dict(g) for g in data.get("grants", [])),
            total=data.get("total", 0),
            page=data.get("page", 1),
            page_size=data.get("pageSize", 50),
        )


@dataclass(frozen=True)
class VerifiedGrant:
    token_id: str
    grant_id: str
    principal_id: str
    agent_did: str
    developer_id: str
    scopes: tuple[str, ...]
    issued_at: int
    expires_at: int
    parent_agent_did: str | None = None
    parent_grant_id: str | None = None
    delegation_depth: int | None = None


# ─── Tokens ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VerifyTokenResponse:
    valid: bool
    grant_id: str | None
    scopes: tuple[str, ...] | None
    principal: str | None
    agent: str | None
    expires_at: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> VerifyTokenResponse:
        raw_scopes = data.get("scopes")
        return cls(
            valid=data["valid"],
            grant_id=data.get("grantId"),
            scopes=tuple(raw_scopes) if raw_scopes is not None else None,
            principal=data.get("principal"),
            agent=data.get("agent"),
            expires_at=data.get("expiresAt"),
        )


@dataclass
class ExchangeTokenParams:
    code: str
    agent_id: str
    code_verifier: str | None = None
    credential_format: str | None = None  # 'jwt' | 'vc-jwt' | 'both'

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "agentId": self.agent_id}
        if self.code_verifier is not None:
            body["codeVerifier"] = self.code_verifier
        if self.credential_format is not None:
            body["credentialFormat"] = self.credential_format
        return body


@dataclass(frozen=True)
class ExchangeTokenResponse:
    grant_token: str
    expires_at: str
    scopes: tuple[str, ...]
    refresh_token: str
    grant_id: str
    verifiable_credential: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExchangeTokenResponse:
        return cls(
            grant_token=data["grantToken"],
            expires_at=data["expiresAt"],
            scopes=tuple(data.get("scopes", [])),
            refresh_token=data["refreshToken"],
            grant_id=data["grantId"],
            verifiable_credential=data.get("verifiableCredential"),
        )


@dataclass
class RefreshTokenParams:
    refresh_token: str
    agent_id: str

    def to_dict(self) -> dict[str, Any]:
        return {"refreshToken": self.refresh_token, "agentId": self.agent_id}


# ─── Principal Sessions ──────────────────────────────────────────────────────


@dataclass
class CreatePrincipalSessionParams:
    principal_id: str
    expires_in: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"principalId": self.principal_id}
        if self.expires_in is not None:
            body["expiresIn"] = self.expires_in
        return body


@dataclass(frozen=True)
class PrincipalSessionResponse:
    session_token: str
    dashboard_url: str
    expires_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PrincipalSessionResponse:
        return cls(
            session_token=data["sessionToken"],
            dashboard_url=data["dashboardUrl"],
            expires_at=data["expiresAt"],
        )


# ─── Audit ────────────────────────────────────────────────────────────────────


@dataclass
class LogAuditParams:
    agent_id: str
    agent_did: str
    grant_id: str
    principal_id: str
    action: str
    metadata: dict[str, Any] | None = None
    status: str = "success"

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agentId": self.agent_id,
            "agentDid": self.agent_did,
            "grantId": self.grant_id,
            "principalId": self.principal_id,
            "action": self.action,
            "status": self.status,
        }
        if self.metadata is not None:
            body["metadata"] = self.metadata
        return body


@dataclass(frozen=True)
class AuditEntry:
    entry_id: str
    agent_id: str
    agent_did: str
    grant_id: str
    principal_id: str
    action: str
    metadata: dict[str, Any]
    hash: str
    prev_hash: str | None
    timestamp: str
    status: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AuditEntry:
        return cls(
            entry_id=data["entryId"],
            agent_id=data["agentId"],
            agent_did=data["agentDid"],
            grant_id=data["grantId"],
            principal_id=data["principalId"],
            action=data["action"],
            metadata=data.get("metadata", {}),
            hash=data["hash"],
            prev_hash=data.get("prevHash"),
            timestamp=data["timestamp"],
            status=data.get("status", "success"),
        )


@dataclass
class ListAuditParams:
    agent_id: str | None = None
    grant_id: str | None = None
    principal_id: str | None = None
    action: str | None = None
    since: str | None = None
    until: str | None = None
    page: int | None = None
    page_size: int | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.agent_id is not None:
            result["agentId"] = self.agent_id
        if self.grant_id is not None:
            result["grantId"] = self.grant_id
        if self.principal_id is not None:
            result["principalId"] = self.principal_id
        if self.action is not None:
            result["action"] = self.action
        if self.since is not None:
            result["since"] = self.since
        if self.until is not None:
            result["until"] = self.until
        if self.page is not None:
            result["page"] = self.page
        if self.page_size is not None:
            result["pageSize"] = self.page_size
        return result


@dataclass(frozen=True)
class ListAuditResponse:
    entries: tuple[AuditEntry, ...]
    total: int
    page: int
    page_size: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ListAuditResponse:
        return cls(
            entries=tuple(AuditEntry.from_dict(e) for e in data.get("entries", [])),
            total=data.get("total", 0),
            page=data.get("page", 1),
            page_size=data.get("pageSize", 50),
        )


# ─── Verify ───────────────────────────────────────────────────────────────────


@dataclass
class VerifyGrantTokenOptions:
    jwks_uri: str
    required_scopes: list[str] | None = None
    clock_tolerance: int = 0
    audience: str | None = None
    issuer_did: str | None = None


# ─── Raw JWT payload shape ────────────────────────────────────────────────────


@dataclass(frozen=True)
class GrantTokenPayload:
    iss: str
    sub: str
    agt: str
    dev: str
    scp: tuple[str, ...]
    iat: int
    exp: int
    jti: str
    grnt: str | None = None
    parent_agt: str | None = None
    parent_grnt: str | None = None
    delegation_depth: int | None = None


@dataclass
class DelegateParams:
    parent_grant_token: str
    sub_agent_id: str
    scopes: list[str]
    expires_in: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "parentGrantToken": self.parent_grant_token,
            "subAgentId": self.sub_agent_id,
            "scopes": self.scopes,
        }
        if self.expires_in is not None:
            body["expiresIn"] = self.expires_in
        return body


# ─── Webhooks ──────────────────────────────────────────────────────────────────


@dataclass
class CreateWebhookParams:
    url: str
    events: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {"url": self.url, "events": self.events}


@dataclass(frozen=True)
class WebhookEndpoint:
    id: str
    url: str
    events: tuple[str, ...]
    created_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WebhookEndpoint":
        return cls(
            id=data["id"],
            url=data["url"],
            events=tuple(data.get("events", [])),
            created_at=data["createdAt"],
        )


@dataclass(frozen=True)
class WebhookEndpointWithSecret:
    id: str
    url: str
    events: tuple[str, ...]
    created_at: str
    secret: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WebhookEndpointWithSecret":
        return cls(
            id=data["id"],
            url=data["url"],
            events=tuple(data.get("events", [])),
            created_at=data["createdAt"],
            secret=data.get("secret", ""),
        )


@dataclass(frozen=True)
class ListWebhooksResponse:
    webhooks: tuple[WebhookEndpoint, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListWebhooksResponse":
        return cls(
            webhooks=tuple(WebhookEndpoint.from_dict(w) for w in data.get("webhooks", [])),
        )


# ─── Billing ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SubscriptionStatus:
    plan: str  # 'free' | 'pro' | 'enterprise'
    status: str  # 'active' | 'past_due' | 'canceled'
    current_period_end: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SubscriptionStatus":
        return cls(
            plan=data.get("plan", "free"),
            status=data.get("status", "active"),
            current_period_end=data.get("currentPeriodEnd"),
        )


@dataclass
class CreateCheckoutParams:
    plan: str  # 'pro' | 'enterprise'
    success_url: str
    cancel_url: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "plan": self.plan,
            "successUrl": self.success_url,
            "cancelUrl": self.cancel_url,
        }


@dataclass
class CreatePortalParams:
    return_url: str

    def to_dict(self) -> dict[str, Any]:
        return {"returnUrl": self.return_url}


@dataclass(frozen=True)
class CheckoutResponse:
    checkout_url: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CheckoutResponse":
        return cls(checkout_url=data["checkoutUrl"])


@dataclass(frozen=True)
class PortalResponse:
    portal_url: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PortalResponse":
        return cls(portal_url=data["portalUrl"])


# ─── Policies ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Policy:
    id: str
    name: str
    effect: str  # 'allow' | 'deny'
    priority: int
    agent_id: str | None
    principal_id: str | None
    scopes: tuple[str, ...] | None
    time_of_day_start: str | None
    time_of_day_end: str | None
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Policy":
        raw_scopes = data.get("scopes")
        return cls(
            id=data["id"],
            name=data["name"],
            effect=data["effect"],
            priority=data.get("priority", 0),
            agent_id=data.get("agentId"),
            principal_id=data.get("principalId"),
            scopes=tuple(raw_scopes) if raw_scopes is not None else None,
            time_of_day_start=data.get("timeOfDayStart"),
            time_of_day_end=data.get("timeOfDayEnd"),
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
        )


@dataclass
class CreatePolicyParams:
    name: str
    effect: str  # 'allow' | 'deny'
    priority: int = 0
    agent_id: str | None = None
    principal_id: str | None = None
    scopes: list[str] | None = None
    time_of_day_start: str | None = None
    time_of_day_end: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": self.name,
            "effect": self.effect,
            "priority": self.priority,
        }
        if self.agent_id is not None:
            body["agentId"] = self.agent_id
        if self.principal_id is not None:
            body["principalId"] = self.principal_id
        if self.scopes is not None:
            body["scopes"] = self.scopes
        if self.time_of_day_start is not None:
            body["timeOfDayStart"] = self.time_of_day_start
        if self.time_of_day_end is not None:
            body["timeOfDayEnd"] = self.time_of_day_end
        return body


@dataclass
class UpdatePolicyParams:
    name: str | None = None
    effect: str | None = None
    priority: int | None = None
    agent_id: str | None = None
    principal_id: str | None = None
    scopes: list[str] | None = None
    time_of_day_start: str | None = None
    time_of_day_end: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if self.name is not None:
            body["name"] = self.name
        if self.effect is not None:
            body["effect"] = self.effect
        if self.priority is not None:
            body["priority"] = self.priority
        if self.agent_id is not None:
            body["agentId"] = self.agent_id
        if self.principal_id is not None:
            body["principalId"] = self.principal_id
        if self.scopes is not None:
            body["scopes"] = self.scopes
        if self.time_of_day_start is not None:
            body["timeOfDayStart"] = self.time_of_day_start
        if self.time_of_day_end is not None:
            body["timeOfDayEnd"] = self.time_of_day_end
        return body


@dataclass(frozen=True)
class ListPoliciesResponse:
    policies: tuple[Policy, ...]
    total: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListPoliciesResponse":
        return cls(
            policies=tuple(Policy.from_dict(p) for p in data.get("policies", [])),
            total=data.get("total", 0),
        )


# ─── Compliance ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ComplianceSummary:
    generated_at: str
    agents: dict[str, int]
    grants: dict[str, int]
    audit_entries: dict[str, int]
    policies: dict[str, int]
    plan: str
    since: str | None = None
    until: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ComplianceSummary":
        return cls(
            generated_at=data["generatedAt"],
            agents=data["agents"],
            grants=data["grants"],
            audit_entries=data["auditEntries"],
            policies=data["policies"],
            plan=data["plan"],
            since=data.get("since"),
            until=data.get("until"),
        )


@dataclass
class ComplianceExportGrantsParams:
    since: str | None = None
    until: str | None = None
    status: str | None = None  # 'active' | 'revoked' | 'expired'

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.since is not None:
            result["since"] = self.since
        if self.until is not None:
            result["until"] = self.until
        if self.status is not None:
            result["status"] = self.status
        return result


@dataclass
class ComplianceExportAuditParams:
    since: str | None = None
    until: str | None = None
    agent_id: str | None = None
    status: str | None = None  # 'success' | 'failure' | 'blocked'

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.since is not None:
            result["since"] = self.since
        if self.until is not None:
            result["until"] = self.until
        if self.agent_id is not None:
            result["agentId"] = self.agent_id
        if self.status is not None:
            result["status"] = self.status
        return result


@dataclass(frozen=True)
class ComplianceGrantsExport:
    generated_at: str
    total: int
    grants: tuple[Grant, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ComplianceGrantsExport":
        return cls(
            generated_at=data["generatedAt"],
            total=data["total"],
            grants=tuple(Grant.from_dict(g) for g in data.get("grants", [])),
        )


@dataclass(frozen=True)
class ComplianceAuditExport:
    generated_at: str
    total: int
    entries: tuple[AuditEntry, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ComplianceAuditExport":
        return cls(
            generated_at=data["generatedAt"],
            total=data["total"],
            entries=tuple(AuditEntry.from_dict(e) for e in data.get("entries", [])),
        )


# ─── Anomalies ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Anomaly:
    id: str
    type: str  # 'rate_spike' | 'high_failure_rate' | 'new_principal' | 'off_hours_activity'
    severity: str  # 'low' | 'medium' | 'high'
    agent_id: str | None
    principal_id: str | None
    description: str
    metadata: dict[str, Any]
    detected_at: str
    acknowledged_at: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Anomaly":
        return cls(
            id=data["id"],
            type=data["type"],
            severity=data["severity"],
            agent_id=data.get("agentId"),
            principal_id=data.get("principalId"),
            description=data["description"],
            metadata=data.get("metadata", {}),
            detected_at=data["detectedAt"],
            acknowledged_at=data.get("acknowledgedAt"),
        )


@dataclass(frozen=True)
class DetectAnomaliesResponse:
    detected_at: str
    total: int
    anomalies: tuple[Anomaly, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DetectAnomaliesResponse":
        return cls(
            detected_at=data["detectedAt"],
            total=data["total"],
            anomalies=tuple(Anomaly.from_dict(a) for a in data.get("anomalies", [])),
        )


@dataclass(frozen=True)
class ListAnomaliesResponse:
    anomalies: tuple[Anomaly, ...]
    total: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListAnomaliesResponse":
        return cls(
            anomalies=tuple(Anomaly.from_dict(a) for a in data.get("anomalies", [])),
            total=data.get("total", 0),
        )


# ─── Evidence pack ─────────────────────────────────────────────────────────────


@dataclass
class EvidencePackParams:
    since: str | None = None
    until: str | None = None
    framework: str | None = None  # 'soc2' | 'gdpr' | 'all'

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if self.since is not None:
            result["since"] = self.since
        if self.until is not None:
            result["until"] = self.until
        if self.framework is not None:
            result["framework"] = self.framework
        return result


@dataclass(frozen=True)
class ChainIntegrity:
    valid: bool
    checked_entries: int
    first_broken_at: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ChainIntegrity":
        return cls(
            valid=data["valid"],
            checked_entries=data["checkedEntries"],
            first_broken_at=data.get("firstBrokenAt"),
        )


@dataclass(frozen=True)
class EvidencePackMeta:
    schema_version: str
    generated_at: str
    framework: str
    since: str | None = None
    until: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidencePackMeta":
        return cls(
            schema_version=data["schemaVersion"],
            generated_at=data["generatedAt"],
            framework=data["framework"],
            since=data.get("since"),
            until=data.get("until"),
        )


@dataclass(frozen=True)
class EvidencePack:
    meta: EvidencePackMeta
    summary: dict[str, Any]
    grants: tuple[Grant, ...]
    audit_entries: tuple[AuditEntry, ...]
    policies: tuple[Policy, ...]
    chain_integrity: ChainIntegrity

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EvidencePack":
        return cls(
            meta=EvidencePackMeta.from_dict(data["meta"]),
            summary=data["summary"],
            grants=tuple(Grant.from_dict(g) for g in data.get("grants", [])),
            audit_entries=tuple(AuditEntry.from_dict(e) for e in data.get("auditEntries", [])),
            policies=tuple(Policy.from_dict(p) for p in data.get("policies", [])),
            chain_integrity=ChainIntegrity.from_dict(data["chainIntegrity"]),
        )


# ─── SCIM ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ScimEmail:
    value: str
    primary: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimEmail":
        return cls(value=data["value"], primary=data.get("primary", False))

    def to_dict(self) -> dict[str, Any]:
        return {"value": self.value, "primary": self.primary}


@dataclass(frozen=True)
class ScimUserMeta:
    resource_type: str
    created: str
    last_modified: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimUserMeta":
        return cls(
            resource_type=data["resourceType"],
            created=data["created"],
            last_modified=data["lastModified"],
        )


@dataclass(frozen=True)
class ScimUser:
    id: str
    user_name: str
    active: bool
    emails: tuple[ScimEmail, ...]
    meta: ScimUserMeta
    external_id: str | None = None
    display_name: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimUser":
        return cls(
            id=data["id"],
            user_name=data["userName"],
            active=data.get("active", True),
            emails=tuple(ScimEmail.from_dict(e) for e in data.get("emails", [])),
            meta=ScimUserMeta.from_dict(data["meta"]),
            external_id=data.get("externalId"),
            display_name=data.get("displayName"),
        )


@dataclass(frozen=True)
class ScimListResponse:
    total_results: int
    start_index: int
    items_per_page: int
    resources: tuple[ScimUser, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimListResponse":
        return cls(
            total_results=data["totalResults"],
            start_index=data["startIndex"],
            items_per_page=data["itemsPerPage"],
            resources=tuple(ScimUser.from_dict(u) for u in data.get("Resources", [])),
        )


@dataclass
class CreateScimUserParams:
    user_name: str
    display_name: str | None = None
    external_id: str | None = None
    emails: list[dict[str, Any]] | None = None
    active: bool = True

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"userName": self.user_name, "active": self.active}
        if self.display_name is not None:
            body["displayName"] = self.display_name
        if self.external_id is not None:
            body["externalId"] = self.external_id
        if self.emails is not None:
            body["emails"] = self.emails
        return body


@dataclass(frozen=True)
class ScimToken:
    id: str
    label: str
    created_at: str
    last_used_at: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimToken":
        return cls(
            id=data["id"],
            label=data["label"],
            created_at=data["createdAt"],
            last_used_at=data.get("lastUsedAt"),
        )


@dataclass(frozen=True)
class ScimTokenWithSecret(ScimToken):
    token: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ScimTokenWithSecret":
        return cls(
            id=data["id"],
            label=data["label"],
            created_at=data["createdAt"],
            last_used_at=data.get("lastUsedAt"),
            token=data.get("token", ""),
        )


@dataclass(frozen=True)
class ListScimTokensResponse:
    tokens: tuple[ScimToken, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListScimTokensResponse":
        return cls(tokens=tuple(ScimToken.from_dict(t) for t in data.get("tokens", [])))


# ─── SSO ───────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SsoConfig:
    issuer_url: str
    client_id: str
    redirect_uri: str
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoConfig":
        return cls(
            issuer_url=data["issuerUrl"],
            client_id=data["clientId"],
            redirect_uri=data["redirectUri"],
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
        )


@dataclass
class CreateSsoConfigParams:
    issuer_url: str
    client_id: str
    client_secret: str
    redirect_uri: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "issuerUrl": self.issuer_url,
            "clientId": self.client_id,
            "clientSecret": self.client_secret,
            "redirectUri": self.redirect_uri,
        }


@dataclass(frozen=True)
class SsoLoginResponse:
    authorize_url: str
    protocol: str | None = None
    connection_id: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoLoginResponse":
        return cls(
            authorize_url=data["authorizeUrl"],
            protocol=data.get("protocol"),
            connection_id=data.get("connectionId"),
        )


@dataclass(frozen=True)
class SsoCallbackResponse:
    developer_id: str
    email: str | None = None
    name: str | None = None
    sub: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoCallbackResponse":
        return cls(
            developer_id=data["developerId"],
            email=data.get("email"),
            name=data.get("name"),
            sub=data.get("sub"),
        )


# ─── Enterprise SSO ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SsoConnection:
    id: str
    developer_id: str
    name: str
    protocol: str
    status: str
    domains: tuple[str, ...]
    jit_provisioning: bool
    enforce: bool
    group_mappings: dict[str, list[str]]
    default_scopes: tuple[str, ...]
    created_at: str
    updated_at: str
    issuer_url: str | None = None
    client_id: str | None = None
    idp_entity_id: str | None = None
    idp_sso_url: str | None = None
    sp_entity_id: str | None = None
    sp_acs_url: str | None = None
    group_attribute: str | None = None
    ldap_url: str | None = None
    ldap_bind_dn: str | None = None
    ldap_search_base: str | None = None
    ldap_search_filter: str | None = None
    ldap_group_search_base: str | None = None
    ldap_group_search_filter: str | None = None
    ldap_tls_enabled: bool | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoConnection":
        return cls(
            id=data["id"],
            developer_id=data["developerId"],
            name=data["name"],
            protocol=data["protocol"],
            status=data["status"],
            domains=tuple(data.get("domains", [])),
            jit_provisioning=data.get("jitProvisioning", False),
            enforce=data.get("enforce", False),
            group_mappings=data.get("groupMappings", {}),
            default_scopes=tuple(data.get("defaultScopes", [])),
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
            issuer_url=data.get("issuerUrl"),
            client_id=data.get("clientId"),
            idp_entity_id=data.get("idpEntityId"),
            idp_sso_url=data.get("idpSsoUrl"),
            sp_entity_id=data.get("spEntityId"),
            sp_acs_url=data.get("spAcsUrl"),
            group_attribute=data.get("groupAttribute"),
            ldap_url=data.get("ldapUrl"),
            ldap_bind_dn=data.get("ldapBindDn"),
            ldap_search_base=data.get("ldapSearchBase"),
            ldap_search_filter=data.get("ldapSearchFilter"),
            ldap_group_search_base=data.get("ldapGroupSearchBase"),
            ldap_group_search_filter=data.get("ldapGroupSearchFilter"),
            ldap_tls_enabled=data.get("ldapTlsEnabled"),
        )


@dataclass
class CreateSsoConnectionParams:
    name: str
    protocol: str
    issuer_url: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    idp_entity_id: str | None = None
    idp_sso_url: str | None = None
    idp_certificate: str | None = None
    sp_entity_id: str | None = None
    sp_acs_url: str | None = None
    ldap_url: str | None = None
    ldap_bind_dn: str | None = None
    ldap_bind_password: str | None = None
    ldap_search_base: str | None = None
    ldap_search_filter: str | None = None
    ldap_group_search_base: str | None = None
    ldap_group_search_filter: str | None = None
    ldap_tls_enabled: bool | None = None
    domains: list[str] | None = None
    jit_provisioning: bool | None = None
    enforce: bool | None = None
    group_attribute: str | None = None
    group_mappings: dict[str, list[str]] | None = None
    default_scopes: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "protocol": self.protocol,
            **({"issuerUrl": self.issuer_url} if self.issuer_url is not None else {}),
            **({"clientId": self.client_id} if self.client_id is not None else {}),
            **({"clientSecret": self.client_secret} if self.client_secret is not None else {}),
            **({"idpEntityId": self.idp_entity_id} if self.idp_entity_id is not None else {}),
            **({"idpSsoUrl": self.idp_sso_url} if self.idp_sso_url is not None else {}),
            **({"idpCertificate": self.idp_certificate} if self.idp_certificate is not None else {}),
            **({"spEntityId": self.sp_entity_id} if self.sp_entity_id is not None else {}),
            **({"spAcsUrl": self.sp_acs_url} if self.sp_acs_url is not None else {}),
            **({"ldapUrl": self.ldap_url} if self.ldap_url is not None else {}),
            **({"ldapBindDn": self.ldap_bind_dn} if self.ldap_bind_dn is not None else {}),
            **({"ldapBindPassword": self.ldap_bind_password} if self.ldap_bind_password is not None else {}),
            **({"ldapSearchBase": self.ldap_search_base} if self.ldap_search_base is not None else {}),
            **({"ldapSearchFilter": self.ldap_search_filter} if self.ldap_search_filter is not None else {}),
            **({"ldapGroupSearchBase": self.ldap_group_search_base} if self.ldap_group_search_base is not None else {}),
            **({"ldapGroupSearchFilter": self.ldap_group_search_filter} if self.ldap_group_search_filter is not None else {}),
            **({"ldapTlsEnabled": self.ldap_tls_enabled} if self.ldap_tls_enabled is not None else {}),
            **({"domains": self.domains} if self.domains is not None else {}),
            **({"jitProvisioning": self.jit_provisioning} if self.jit_provisioning is not None else {}),
            **({"enforce": self.enforce} if self.enforce is not None else {}),
            **({"groupAttribute": self.group_attribute} if self.group_attribute is not None else {}),
            **({"groupMappings": self.group_mappings} if self.group_mappings is not None else {}),
            **({"defaultScopes": self.default_scopes} if self.default_scopes is not None else {}),
        }


@dataclass
class UpdateSsoConnectionParams:
    name: str | None = None
    status: str | None = None
    issuer_url: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    idp_entity_id: str | None = None
    idp_sso_url: str | None = None
    idp_certificate: str | None = None
    sp_entity_id: str | None = None
    sp_acs_url: str | None = None
    ldap_url: str | None = None
    ldap_bind_dn: str | None = None
    ldap_bind_password: str | None = None
    ldap_search_base: str | None = None
    ldap_search_filter: str | None = None
    ldap_group_search_base: str | None = None
    ldap_group_search_filter: str | None = None
    ldap_tls_enabled: bool | None = None
    domains: list[str] | None = None
    jit_provisioning: bool | None = None
    enforce: bool | None = None
    group_attribute: str | None = None
    group_mappings: dict[str, list[str]] | None = None
    default_scopes: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            **({"name": self.name} if self.name is not None else {}),
            **({"status": self.status} if self.status is not None else {}),
            **({"issuerUrl": self.issuer_url} if self.issuer_url is not None else {}),
            **({"clientId": self.client_id} if self.client_id is not None else {}),
            **({"clientSecret": self.client_secret} if self.client_secret is not None else {}),
            **({"idpEntityId": self.idp_entity_id} if self.idp_entity_id is not None else {}),
            **({"idpSsoUrl": self.idp_sso_url} if self.idp_sso_url is not None else {}),
            **({"idpCertificate": self.idp_certificate} if self.idp_certificate is not None else {}),
            **({"spEntityId": self.sp_entity_id} if self.sp_entity_id is not None else {}),
            **({"spAcsUrl": self.sp_acs_url} if self.sp_acs_url is not None else {}),
            **({"ldapUrl": self.ldap_url} if self.ldap_url is not None else {}),
            **({"ldapBindDn": self.ldap_bind_dn} if self.ldap_bind_dn is not None else {}),
            **({"ldapBindPassword": self.ldap_bind_password} if self.ldap_bind_password is not None else {}),
            **({"ldapSearchBase": self.ldap_search_base} if self.ldap_search_base is not None else {}),
            **({"ldapSearchFilter": self.ldap_search_filter} if self.ldap_search_filter is not None else {}),
            **({"ldapGroupSearchBase": self.ldap_group_search_base} if self.ldap_group_search_base is not None else {}),
            **({"ldapGroupSearchFilter": self.ldap_group_search_filter} if self.ldap_group_search_filter is not None else {}),
            **({"ldapTlsEnabled": self.ldap_tls_enabled} if self.ldap_tls_enabled is not None else {}),
            **({"domains": self.domains} if self.domains is not None else {}),
            **({"jitProvisioning": self.jit_provisioning} if self.jit_provisioning is not None else {}),
            **({"enforce": self.enforce} if self.enforce is not None else {}),
            **({"groupAttribute": self.group_attribute} if self.group_attribute is not None else {}),
            **({"groupMappings": self.group_mappings} if self.group_mappings is not None else {}),
            **({"defaultScopes": self.default_scopes} if self.default_scopes is not None else {}),
        }


@dataclass(frozen=True)
class ListSsoConnectionsResponse:
    connections: tuple[SsoConnection, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListSsoConnectionsResponse":
        return cls(
            connections=tuple(SsoConnection.from_dict(c) for c in data.get("connections", [])),
        )


@dataclass(frozen=True)
class SsoConnectionTestResult:
    success: bool
    protocol: str
    issuer: str | None = None
    authorization_endpoint: str | None = None
    token_endpoint: str | None = None
    jwks_uri: str | None = None
    idp_entity_id: str | None = None
    idp_sso_url: str | None = None
    error: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoConnectionTestResult":
        return cls(
            success=data["success"],
            protocol=data["protocol"],
            issuer=data.get("issuer"),
            authorization_endpoint=data.get("authorizationEndpoint"),
            token_endpoint=data.get("tokenEndpoint"),
            jwks_uri=data.get("jwksUri"),
            idp_entity_id=data.get("idpEntityId"),
            idp_sso_url=data.get("idpSsoUrl"),
            error=data.get("error"),
        )


@dataclass
class SsoEnforcementParams:
    enforce: bool

    def to_dict(self) -> dict[str, Any]:
        return {"enforce": self.enforce}


@dataclass(frozen=True)
class SsoEnforcementResponse:
    enforce: bool
    developer_id: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoEnforcementResponse":
        return cls(
            enforce=data["enforce"],
            developer_id=data["developerId"],
        )


@dataclass(frozen=True)
class SsoSession:
    id: str
    connection_id: str
    idp_subject: str
    groups: tuple[str, ...]
    mapped_scopes: tuple[str, ...]
    expires_at: str
    created_at: str
    principal_id: str | None = None
    email: str | None = None
    name: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoSession":
        return cls(
            id=data["id"],
            connection_id=data["connectionId"],
            idp_subject=data["idpSubject"],
            groups=tuple(data.get("groups", [])),
            mapped_scopes=tuple(data.get("mappedScopes", [])),
            expires_at=data["expiresAt"],
            created_at=data["createdAt"],
            principal_id=data.get("principalId"),
            email=data.get("email"),
            name=data.get("name"),
        )


@dataclass(frozen=True)
class ListSsoSessionsResponse:
    sessions: tuple[SsoSession, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListSsoSessionsResponse":
        return cls(
            sessions=tuple(SsoSession.from_dict(s) for s in data.get("sessions", [])),
        )


@dataclass
class SsoOidcCallbackParams:
    code: str
    state: str
    redirect_uri: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "state": self.state,
            **({"redirect_uri": self.redirect_uri} if self.redirect_uri is not None else {}),
        }


@dataclass
class SsoSamlCallbackParams:
    saml_response: str
    relay_state: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "SAMLResponse": self.saml_response,
            "RelayState": self.relay_state,
        }


@dataclass
class SsoLdapCallbackParams:
    username: str
    password: str
    connection_id: str
    org: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "username": self.username,
            "password": self.password,
            "connectionId": self.connection_id,
            "org": self.org,
        }


@dataclass(frozen=True)
class SsoCallbackResult:
    session_id: str
    groups: tuple[str, ...]
    mapped_scopes: tuple[str, ...]
    developer_id: str
    expires_at: str
    email: str | None = None
    name: str | None = None
    sub: str | None = None
    principal_id: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoCallbackResult":
        return cls(
            session_id=data["sessionId"],
            groups=tuple(data.get("groups", [])),
            mapped_scopes=tuple(data.get("mappedScopes", [])),
            developer_id=data["developerId"],
            expires_at=data["expiresAt"],
            email=data.get("email"),
            name=data.get("name"),
            sub=data.get("sub"),
            principal_id=data.get("principalId"),
        )


# ── Credential Vault ─────────────────────────────────────────────────────────


@dataclass
class StoreCredentialParams:
    principal_id: str
    service: str
    access_token: str
    credential_type: str | None = None
    refresh_token: str | None = None
    token_expires_at: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "principalId": self.principal_id,
            "service": self.service,
            "accessToken": self.access_token,
            **({"credentialType": self.credential_type} if self.credential_type is not None else {}),
            **({"refreshToken": self.refresh_token} if self.refresh_token is not None else {}),
            **({"tokenExpiresAt": self.token_expires_at} if self.token_expires_at is not None else {}),
            **({"metadata": self.metadata} if self.metadata is not None else {}),
        }


@dataclass(frozen=True)
class StoreCredentialResponse:
    id: str
    principal_id: str
    service: str
    credential_type: str
    created_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StoreCredentialResponse":
        return cls(
            id=data["id"],
            principal_id=data["principalId"],
            service=data["service"],
            credential_type=data["credentialType"],
            created_at=data["createdAt"],
        )


@dataclass(frozen=True)
class VaultCredential:
    id: str
    principal_id: str
    service: str
    credential_type: str
    token_expires_at: str | None
    metadata: dict[str, Any]
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VaultCredential":
        return cls(
            id=data["id"],
            principal_id=data["principalId"],
            service=data["service"],
            credential_type=data["credentialType"],
            token_expires_at=data.get("tokenExpiresAt"),
            metadata=data.get("metadata", {}),
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
        )


@dataclass
class ListVaultCredentialsParams:
    principal_id: str | None = None
    service: str | None = None


@dataclass(frozen=True)
class ListVaultCredentialsResponse:
    credentials: tuple[VaultCredential, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListVaultCredentialsResponse":
        return cls(
            credentials=tuple(VaultCredential.from_dict(c) for c in data["credentials"]),
        )


@dataclass
class ExchangeCredentialParams:
    service: str

    def to_dict(self) -> dict[str, Any]:
        return {"service": self.service}


@dataclass(frozen=True)
class ExchangeCredentialResponse:
    access_token: str
    service: str
    credential_type: str
    token_expires_at: str | None
    metadata: dict[str, Any]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExchangeCredentialResponse":
        return cls(
            access_token=data["accessToken"],
            service=data["service"],
            credential_type=data["credentialType"],
            token_expires_at=data.get("tokenExpiresAt"),
            metadata=data.get("metadata", {}),
        )


# ─── Budgets ─────────────────────────────────────────────────────────────────


@dataclass
class AllocateBudgetParams:
    grant_id: str
    initial_budget: float
    currency: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "grantId": self.grant_id,
            "initialBudget": self.initial_budget,
        }
        if self.currency is not None:
            body["currency"] = self.currency
        return body


@dataclass(frozen=True)
class BudgetAllocation:
    id: str
    grant_id: str
    developer_id: str
    initial_budget: str
    remaining_budget: str
    currency: str
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BudgetAllocation":
        return cls(
            id=data["id"],
            grant_id=data["grantId"],
            developer_id=data["developerId"],
            initial_budget=data["initialBudget"],
            remaining_budget=data["remainingBudget"],
            currency=data["currency"],
            created_at=data["createdAt"],
            updated_at=data["updatedAt"],
        )


@dataclass
class DebitBudgetParams:
    grant_id: str
    amount: float
    description: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "grantId": self.grant_id,
            "amount": self.amount,
        }
        if self.description is not None:
            body["description"] = self.description
        if self.metadata is not None:
            body["metadata"] = self.metadata
        return body


@dataclass(frozen=True)
class DebitBudgetResponse:
    remaining: str
    transaction_id: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DebitBudgetResponse":
        return cls(
            remaining=data["remaining"],
            transaction_id=data["transactionId"],
        )


@dataclass(frozen=True)
class BudgetTransaction:
    id: str
    grant_id: str
    allocation_id: str
    amount: str
    description: str
    metadata: dict[str, Any]
    created_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BudgetTransaction":
        return cls(
            id=data["id"],
            grant_id=data["grantId"],
            allocation_id=data["allocationId"],
            amount=data["amount"],
            description=data["description"],
            metadata=data.get("metadata", {}),
            created_at=data["createdAt"],
        )


@dataclass(frozen=True)
class BudgetTransactionsResponse:
    transactions: tuple[BudgetTransaction, ...]
    total: int
    page: int
    page_size: int

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BudgetTransactionsResponse":
        return cls(
            transactions=tuple(
                BudgetTransaction.from_dict(t)
                for t in data.get("transactions", [])
            ),
            total=data["total"],
            page=data["page"],
            page_size=data["pageSize"],
        )


# ─── Event streaming ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class GrantexStreamEvent:
    """Event received from the SSE/WebSocket stream."""
    id: str
    type: str
    created_at: str
    data: dict[str, Any]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GrantexStreamEvent":
        return cls(
            id=d["id"],
            type=d["type"],
            created_at=d["createdAt"],
            data=d.get("data", {}),
        )


# ─── WebAuthn / FIDO ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class WebAuthnRegistrationOptions:
    challenge_id: str
    public_key: dict[str, Any]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WebAuthnRegistrationOptions":
        return cls(
            challenge_id=data["challengeId"],
            public_key=data["publicKey"],
        )


@dataclass
class WebAuthnRegistrationVerifyParams:
    challenge_id: str
    response: dict[str, Any]
    device_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "challengeId": self.challenge_id,
            "response": self.response,
        }
        if self.device_name is not None:
            body["deviceName"] = self.device_name
        return body


@dataclass(frozen=True)
class WebAuthnCredential:
    id: str
    principal_id: str
    device_name: str | None
    backed_up: bool
    transports: tuple[str, ...]
    created_at: str
    last_used_at: str | None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WebAuthnCredential":
        return cls(
            id=data["id"],
            principal_id=data["principalId"],
            device_name=data.get("deviceName"),
            backed_up=data.get("backedUp", False),
            transports=tuple(data.get("transports", [])),
            created_at=data["createdAt"],
            last_used_at=data.get("lastUsedAt"),
        )


@dataclass(frozen=True)
class ListWebAuthnCredentialsResponse:
    credentials: tuple[WebAuthnCredential, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListWebAuthnCredentialsResponse":
        return cls(
            credentials=tuple(
                WebAuthnCredential.from_dict(c)
                for c in data.get("credentials", [])
            ),
        )


# ─── Verifiable Credentials ─────────────────────────────────────────────────


@dataclass(frozen=True)
class VerifiableCredentialRecord:
    id: str
    grant_id: str
    credential_type: str
    format: str
    credential: str
    status: str
    issued_at: str
    expires_at: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VerifiableCredentialRecord":
        return cls(
            id=data["id"],
            grant_id=data["grantId"],
            credential_type=data["credentialType"],
            format=data["format"],
            credential=data["credential"],
            status=data["status"],
            issued_at=data["issuedAt"],
            expires_at=data["expiresAt"],
        )


@dataclass
class ListCredentialsParams:
    grant_id: str | None = None
    principal_id: str | None = None
    status: str | None = None

    def to_query(self) -> dict[str, str]:
        result: dict[str, str] = {}
        if self.grant_id is not None:
            result["grantId"] = self.grant_id
        if self.principal_id is not None:
            result["principalId"] = self.principal_id
        if self.status is not None:
            result["status"] = self.status
        return result


@dataclass(frozen=True)
class ListCredentialsResponse:
    credentials: tuple[VerifiableCredentialRecord, ...]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ListCredentialsResponse":
        return cls(
            credentials=tuple(
                VerifiableCredentialRecord.from_dict(c)
                for c in data.get("credentials", [])
            ),
        )


@dataclass(frozen=True)
class VCVerificationResult:
    valid: bool
    credential_type: str | None = None
    issuer: str | None = None
    subject: dict[str, Any] | None = None
    expires_at: str | None = None
    revoked: bool | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VCVerificationResult":
        return cls(
            valid=data["valid"],
            credential_type=data.get("credentialType"),
            issuer=data.get("issuer"),
            subject=data.get("subject"),
            expires_at=data.get("expiresAt"),
            revoked=data.get("revoked"),
        )


# ─── SD-JWT Presentation ─────────────────────────────────────────────────────


@dataclass
class SDJWTPresentParams:
    sd_jwt: str
    nonce: str | None = None
    audience: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"sdJwt": self.sd_jwt}
        if self.nonce is not None:
            body["nonce"] = self.nonce
        if self.audience is not None:
            body["audience"] = self.audience
        return body


@dataclass
class SDJWTPresentResult:
    valid: bool
    disclosed_claims: dict[str, Any] | None = None
    error: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SDJWTPresentResult":
        return cls(
            valid=data["valid"],
            disclosed_claims=data.get("disclosedClaims"),
            error=data.get("error"),
        )


# ─── Developer Settings ──────────────────────────────────────────────────────


@dataclass
class UpdateDeveloperSettingsParams:
    fido_required: bool | None = None
    fido_rp_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if self.fido_required is not None:
            body["fidoRequired"] = self.fido_required
        if self.fido_rp_name is not None:
            body["fidoRpName"] = self.fido_rp_name
        return body


@dataclass(frozen=True)
class UpdateDeveloperSettingsResponse:
    updated: bool

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "UpdateDeveloperSettingsResponse":
        return cls(updated=data["updated"])

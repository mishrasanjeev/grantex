from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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
            id=data["id"],
            did=data["did"],
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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AuthorizationRequest:
        return cls(
            request_id=data["authRequestId"],
            consent_url=data["consentUrl"],
            agent_id=data["agentId"],
            principal_id=data["principalId"],
            scopes=tuple(data.get("scopes", [])),
            expires_in=data["expiresIn"],
            expires_at=data["expiresAt"],
            status=data["status"],
            created_at=data["createdAt"],
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
            id=data["id"],
            agent_id=data["agentId"],
            agent_did=data["agentDid"],
            principal_id=data["principalId"],
            developer_id=data["developerId"],
            scopes=tuple(data.get("scopes", [])),
            status=data["status"],
            issued_at=data["issuedAt"],
            expires_at=data["expiresAt"],
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
            total=data["total"],
            page=data["page"],
            page_size=data["pageSize"],
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

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "agentId": self.agent_id}
        if self.code_verifier is not None:
            body["codeVerifier"] = self.code_verifier
        return body


@dataclass(frozen=True)
class ExchangeTokenResponse:
    grant_token: str
    expires_at: str
    scopes: tuple[str, ...]
    refresh_token: str
    grant_id: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExchangeTokenResponse:
        return cls(
            grant_token=data["grantToken"],
            expires_at=data["expiresAt"],
            scopes=tuple(data.get("scopes", [])),
            refresh_token=data["refreshToken"],
            grant_id=data["grantId"],
        )


@dataclass
class RefreshTokenParams:
    refresh_token: str
    agent_id: str

    def to_dict(self) -> dict[str, Any]:
        return {"refreshToken": self.refresh_token, "agentId": self.agent_id}


# ─── Audit ────────────────────────────────────────────────────────────────────


@dataclass
class LogAuditParams:
    agent_id: str
    grant_id: str
    action: str
    metadata: dict[str, Any] | None = None
    status: str = "success"

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "agentId": self.agent_id,
            "grantId": self.grant_id,
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
            total=data["total"],
            page=data["page"],
            page_size=data["pageSize"],
        )


# ─── Verify ───────────────────────────────────────────────────────────────────


@dataclass
class VerifyGrantTokenOptions:
    jwks_uri: str
    required_scopes: list[str] | None = None
    clock_tolerance: int = 0
    audience: str | None = None


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

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SsoLoginResponse":
        return cls(authorize_url=data["authorizeUrl"])


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

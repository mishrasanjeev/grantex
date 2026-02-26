from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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

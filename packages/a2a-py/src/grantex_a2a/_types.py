"""A2A protocol types with Grantex extensions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class A2ATask:
    id: str
    status: A2ATaskStatus
    artifacts: Optional[List[A2AArtifact]] = None
    history: Optional[List[A2AMessage]] = None


@dataclass
class A2ATaskStatus:
    state: str  # submitted, working, input-required, completed, canceled, failed
    message: Optional[A2AMessage] = None
    timestamp: Optional[str] = None


@dataclass
class A2AMessage:
    role: str  # user, agent
    parts: List[A2APart]
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class A2APart:
    type: str  # text, data, file
    text: Optional[str] = None
    data: Optional[Dict[str, Any]] = None
    mime_type: Optional[str] = None
    file: Optional[Dict[str, str]] = None


@dataclass
class A2AArtifact:
    parts: List[A2APart]
    name: Optional[str] = None
    description: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class TaskSendParams:
    message: A2AMessage
    id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class TaskGetParams:
    id: str
    history_length: Optional[int] = None


@dataclass
class TaskCancelParams:
    id: str


@dataclass
class VerifiedGrant:
    grant_id: str
    agent_did: str
    principal_id: str
    developer_id: str
    scopes: List[str]
    expires_at: str
    delegation_depth: Optional[int] = None


@dataclass
class GrantexAuthConfig:
    jwks_uri: str
    issuer: str
    required_scopes: Optional[List[str]] = None
    delegation_allowed: Optional[bool] = None


@dataclass
class A2AAgentCard:
    name: str
    description: str
    url: str
    version: Optional[str] = None
    provider: Optional[Dict[str, str]] = None
    capabilities: Optional[Dict[str, bool]] = None
    authentication: Optional[Dict[str, Any]] = None
    default_input_modes: List[str] = field(default_factory=lambda: ["text/plain"])
    default_output_modes: List[str] = field(default_factory=lambda: ["text/plain"])
    skills: Optional[List[Dict[str, Any]]] = None


@dataclass
class GrantexAgentCardOptions:
    name: str
    description: str
    url: str
    jwks_uri: str
    issuer: str
    required_scopes: Optional[List[str]] = None
    delegation_allowed: Optional[bool] = None
    version: Optional[str] = None
    provider: Optional[Dict[str, str]] = None
    capabilities: Optional[Dict[str, bool]] = None
    skills: Optional[List[Dict[str, Any]]] = None


@dataclass
class A2AAuthMiddlewareOptions:
    jwks_uri: str
    issuer: Optional[str] = None
    required_scopes: Optional[List[str]] = None


@dataclass
class A2AGrantexClientOptions:
    agent_url: str
    grant_token: str
    required_scope: Optional[str] = None

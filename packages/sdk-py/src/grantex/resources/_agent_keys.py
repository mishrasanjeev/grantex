"""Agent key history and possession proof (spec/agent-keys.md).

Developer-authenticated, for the developer's own agents: add a key, ask for a
challenge, answer it with a proof (the key becomes ``active``), rotate and
compromise. ``grantex.issuers.sign_key_proof`` builds the proof on the agent's
side.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional
from urllib.parse import quote

from .._http import HttpClient


@dataclass(frozen=True)
class AgentKey:
    thumbprint: str
    agent_id: str
    jwk: dict[str, Any]
    alg: str
    #: ``pending``, ``active``, ``rotated`` or ``compromised``.
    status: str
    valid_from: Optional[str]
    valid_to: Optional[str]
    possession_proved_at: Optional[str]
    rotated_from: Optional[str]
    created_at: Optional[str]
    #: Whether the registry would accept the key now; ``denial`` says why not.
    usable: bool
    denial: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentKey:
        return cls(
            thumbprint=data["thumbprint"],
            agent_id=data["agentId"],
            jwk=dict(data.get("jwk") or {}),
            alg=data["alg"],
            status=data["status"],
            valid_from=data.get("validFrom"),
            valid_to=data.get("validTo"),
            possession_proved_at=data.get("possessionProvedAt"),
            rotated_from=data.get("rotatedFrom"),
            created_at=data.get("createdAt"),
            usable=bool(data.get("usable", False)),
            denial=data.get("denial"),
        )


@dataclass(frozen=True)
class KeyChallenge:
    """What ``challenge()`` returns and what the agent signs (spec §4.1)."""

    thumbprint: str
    challenge: str
    audience: str
    subject: str
    typ: str
    alg: str
    expires_at: Optional[str]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KeyChallenge:
        return cls(
            thumbprint=data["thumbprint"],
            challenge=data["challenge"],
            audience=data["audience"],
            subject=data["subject"],
            typ=data["typ"],
            alg=data["alg"],
            expires_at=data.get("expiresAt"),
        )


def _agent_path(agent_id: str) -> str:
    return f"/v1/agents/{quote(agent_id, safe='')}/keys"


def _key_path(agent_id: str, thumbprint: str) -> str:
    return f"{_agent_path(agent_id)}/{quote(thumbprint, safe='')}"


class AgentKeysClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, agent_id: str) -> List[AgentKey]:
        """Every key in the agent's history, newest first."""
        data = self._http.get(_agent_path(agent_id))
        rows = data.get("keys", []) if isinstance(data, dict) else data
        return [AgentKey.from_dict(row) for row in rows]

    def add(self, agent_id: str, public_jwk: dict[str, Any]) -> AgentKey:
        """Register a public key; it is ``pending`` until its possession is proven."""
        return AgentKey.from_dict(self._http.post(_agent_path(agent_id), {"publicJwk": public_jwk}, retry=False))

    def challenge(self, agent_id: str, thumbprint: str) -> KeyChallenge:
        """A single-use challenge for a pending key (spec §4.1)."""
        return KeyChallenge.from_dict(self._http.post(f"{_key_path(agent_id, thumbprint)}/challenge"))

    def prove(self, agent_id: str, thumbprint: str, proof: str) -> AgentKey:
        """Answer the challenge with a compact JWS; the key becomes ``active`` (spec §4.3)."""
        # Single use: a retry after a lost answer would replay a consumed challenge.
        return AgentKey.from_dict(self._http.post(f"{_key_path(agent_id, thumbprint)}/prove", {"proof": proof}, retry=False))

    def rotate(
        self, agent_id: str, thumbprint: str, replacement_thumbprint: str, overlap_seconds: Optional[int] = None
    ) -> dict[str, Any]:
        """End the key after an overlap; the replacement must already be active (spec §5)."""
        body: dict[str, Any] = {"replacementThumbprint": replacement_thumbprint}
        if overlap_seconds is not None:
            body["overlapSeconds"] = overlap_seconds
        data = self._http.post(f"{_key_path(agent_id, thumbprint)}/rotate", body, retry=False)
        return dict(data) if isinstance(data, dict) else {}

    def compromise(self, agent_id: str, thumbprint: str, reason: Optional[str] = None) -> dict[str, Any]:
        """End the key now and revoke every grant bound to it (spec §6)."""
        body: dict[str, Any] = {} if reason is None else {"reason": reason}
        data = self._http.post(f"{_key_path(agent_id, thumbprint)}/compromise", body, retry=False)
        return dict(data) if isinstance(data, dict) else {}

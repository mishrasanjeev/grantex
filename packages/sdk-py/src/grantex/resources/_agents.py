from __future__ import annotations

from urllib.parse import quote

from typing import Any, List, Optional

from .._http import HttpClient
from .._types import Agent, ListAgentsResponse
from ._agent_keys import AgentKeysClient


class AgentsClient:
    def __init__(self, http: HttpClient) -> None:
        self._http = http
        #: Key history and possession proof (spec/agent-keys.md).
        self.keys = AgentKeysClient(http)

    def register(
        self,
        *,
        name: str,
        scopes: List[str],
        description: str = "",
        redirect_uris: List[str] | None = None,
        resource_servers: List[str] | None = None,
        public_jwk: dict[str, Any] | None = None,
    ) -> Agent:
        body: dict[str, Any] = {
            "name": name,
            "description": description,
            "scopes": scopes,
        }
        if redirect_uris is not None:
            body["redirectUris"] = redirect_uris
        if resource_servers is not None:
            body["resourceServers"] = resource_servers
        if public_jwk is not None:
            body["publicJwk"] = public_jwk
        data = self._http.post("/v1/agents", body)
        return Agent.from_dict(data)

    def get(self, agent_id: str) -> Agent:
        data = self._http.get(f"/v1/agents/{quote(agent_id, safe='')}")
        return Agent.from_dict(data)

    def list(self) -> ListAgentsResponse:
        data = self._http.get("/v1/agents")
        return ListAgentsResponse.from_dict(data)

    def update(
        self,
        agent_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        scopes: Optional[List[str]] = None,
        redirect_uris: Optional[List[str]] = None,
        resource_servers: Optional[List[str]] = None,
        public_jwk: dict[str, Any] | None = None,
        status: str | None = None,
        status_reason: str | None = None,
    ) -> Agent:
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if status_reason is not None:
            body["statusReason"] = status_reason
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if scopes is not None:
            body["scopes"] = scopes
        if redirect_uris is not None:
            body["redirectUris"] = redirect_uris
        if resource_servers is not None:
            body["resourceServers"] = resource_servers
        if public_jwk is not None:
            body["publicJwk"] = public_jwk
        data = self._http.post(f"/v1/agents/{quote(agent_id, safe='')}", body)
        return Agent.from_dict(data)

    def delete(self, agent_id: str) -> None:
        self._http.delete(f"/v1/agents/{quote(agent_id, safe='')}")

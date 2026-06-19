"""A2A client with Grantex grant token authentication."""

from __future__ import annotations

import json
from http.client import HTTPConnection, HTTPException, HTTPSConnection
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from ._jwt import decode_jwt_payload, is_token_expired
from ._types import (
    A2AGrantexClientOptions,
    A2ATask,
    A2ATaskStatus,
    A2AMessage,
    A2APart,
    TaskSendParams,
    TaskGetParams,
    TaskCancelParams,
)


class A2AGrantexClient:
    """A2A JSON-RPC 2.0 client with Grantex grant token authentication.

    Args:
        options: Client configuration including agent URL and grant token.

    Example::

        client = A2AGrantexClient(A2AGrantexClientOptions(
            agent_url="https://agent.example.com/a2a",
            grant_token="eyJ...",
        ))
        task = client.send_task(TaskSendParams(
            message=A2AMessage(role="user", parts=[A2APart(type="text", text="Hello")])
        ))
    """

    def __init__(self, options: A2AGrantexClientOptions) -> None:
        parsed_agent_url = urlparse(options.agent_url)
        if (
            parsed_agent_url.scheme not in {"http", "https"}
            or not parsed_agent_url.netloc
            or not parsed_agent_url.hostname
        ):
            raise ValueError("agent_url must be an absolute http(s) URL")
        try:
            parsed_agent_url.port
        except ValueError as exc:
            raise ValueError("agent_url has an invalid port") from exc
        self._agent_url = parsed_agent_url
        self._grant_token = options.grant_token
        self._required_scope = options.required_scope
        self._request_id = 0
        self._validate_token()

    def _validate_token(self) -> None:
        payload = decode_jwt_payload(self._grant_token)
        if is_token_expired(payload):
            raise ValueError("Grant token is expired")
        if self._required_scope:
            scopes = payload.get("scp", [])
            if self._required_scope not in scopes:
                raise ValueError(
                    f"Grant token missing required scope: {self._required_scope}"
                )

    def _rpc(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._request_id += 1
        request_body: Dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._request_id,
            "method": method,
        }
        if params is not None:
            request_body["params"] = params

        data = json.dumps(request_body).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._grant_token}",
        }
        target = self._agent_url.path or "/"
        if self._agent_url.query:
            target = f"{target}?{self._agent_url.query}"

        conn_cls = HTTPSConnection if self._agent_url.scheme == "https" else HTTPConnection
        conn = conn_cls(self._agent_url.hostname, self._agent_url.port, timeout=30)
        try:
            conn.request("POST", target, body=data, headers=headers)
            resp = conn.getresponse()
            raw_body = resp.read()
            if resp.status >= 400:
                raise RuntimeError(f"A2A request failed: {resp.status} {resp.reason}")
            return json.loads(raw_body.decode("utf-8"))  # type: ignore[no-any-return]
        except HTTPException as e:
            raise RuntimeError(
                f"A2A request failed: {e}"
            ) from e
        finally:
            conn.close()

    def _parse_task(self, result: Any) -> A2ATask:
        status = A2ATaskStatus(state=result["status"]["state"])
        return A2ATask(id=result["id"], status=status)

    def send_task(self, params: TaskSendParams) -> A2ATask:
        """Send a task to the remote A2A agent."""
        rpc_params: Dict[str, Any] = {
            "message": {
                "role": params.message.role,
                "parts": [self._serialize_part(p) for p in params.message.parts],
            }
        }
        if params.id is not None:
            rpc_params["id"] = params.id
        if params.metadata is not None:
            rpc_params["metadata"] = params.metadata

        response = self._rpc("tasks/send", rpc_params)
        if "error" in response:
            err = response["error"]
            raise RuntimeError(f"A2A error {err['code']}: {err['message']}")
        return self._parse_task(response["result"])

    def get_task(self, params: TaskGetParams) -> A2ATask:
        """Get the current state of a task."""
        rpc_params: Dict[str, Any] = {"id": params.id}
        if params.history_length is not None:
            rpc_params["historyLength"] = params.history_length

        response = self._rpc("tasks/get", rpc_params)
        if "error" in response:
            err = response["error"]
            raise RuntimeError(f"A2A error {err['code']}: {err['message']}")
        return self._parse_task(response["result"])

    def cancel_task(self, params: TaskCancelParams) -> A2ATask:
        """Cancel a running task."""
        response = self._rpc("tasks/cancel", {"id": params.id})
        if "error" in response:
            err = response["error"]
            raise RuntimeError(f"A2A error {err['code']}: {err['message']}")
        return self._parse_task(response["result"])

    def get_token_info(self) -> Dict[str, Any]:
        """Get the decoded grant token payload (without verification)."""
        return decode_jwt_payload(self._grant_token)

    @staticmethod
    def _serialize_part(part: A2APart) -> Dict[str, Any]:
        result: Dict[str, Any] = {"type": part.type}
        if part.text is not None:
            result["text"] = part.text
        if part.data is not None:
            result["data"] = part.data
        if part.mime_type is not None:
            result["mimeType"] = part.mime_type
        if part.file is not None:
            result["file"] = part.file
        return result

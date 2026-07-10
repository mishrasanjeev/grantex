"""Tests for the A2A client validation boundary."""

import base64
import json
import time

import pytest

from grantex_a2a import A2AGrantexClient, A2AGrantexClientOptions


def _make_token(payload: object) -> str:
    def encode(value: object) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(value).encode()
        ).decode().rstrip("=")

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode(payload)}.signature"


def test_rejects_relative_agent_url() -> None:
    token = _make_token({"exp": int(time.time()) + 60, "scp": ["tasks:send"]})

    with pytest.raises(ValueError, match=r"absolute http\(s\) URL"):
        A2AGrantexClient(
            A2AGrantexClientOptions(agent_url="/a2a", grant_token=token)
        )


def test_required_scope_uses_exact_list_membership() -> None:
    token = _make_token(
        {"exp": int(time.time()) + 60, "scp": "tasks:send-with-escalation"}
    )

    with pytest.raises(ValueError, match="list of strings"):
        A2AGrantexClient(
            A2AGrantexClientOptions(
                agent_url="https://agent.example/a2a",
                grant_token=token,
                required_scope="tasks:send",
            )
        )


def test_rejects_non_string_scope_items() -> None:
    token = _make_token({"exp": int(time.time()) + 60, "scp": ["tasks:send", 7]})

    with pytest.raises(ValueError, match="list of strings"):
        A2AGrantexClient(
            A2AGrantexClientOptions(
                agent_url="https://agent.example/a2a",
                grant_token=token,
                required_scope="tasks:send",
            )
        )


def test_accepts_valid_required_scope() -> None:
    token = _make_token(
        {"exp": int(time.time()) + 60, "scp": ["tasks:read", "tasks:send"]}
    )

    client = A2AGrantexClient(
        A2AGrantexClientOptions(
            agent_url="https://agent.example/a2a",
            grant_token=token,
            required_scope="tasks:send",
        )
    )

    assert client.get_token_info()["scp"] == ["tasks:read", "tasks:send"]

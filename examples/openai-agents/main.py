"""
Grantex + OpenAI Agents SDK — Scoped Tools

Shows OpenAI Agents SDK tools with Grantex scope enforcement:
  1. Register agent & get a grant token (sandbox flow)
  2. Create scoped tools via create_grantex_tool (calendar + email)
  3. Invoke tools directly
  4. Demonstrate scope enforcement (PermissionError on unauthorized scope)
  5. Inspect audit trail

Prerequisites:
  docker compose up          # from repo root
  cd examples/openai-agents
  pip install -r requirements.txt
  python main.py
"""

from __future__ import annotations

import json
import os

import httpx

from grantex import ExchangeTokenParams, Grantex
from grantex_openai_agents import create_grantex_tool

BASE_URL = os.environ.get("GRANTEX_URL", "http://localhost:3001")
API_KEY = os.environ.get("GRANTEX_API_KEY", "sandbox-api-key-local")


def get_grant_token(
    client: Grantex, agent_id: str
) -> tuple[str, str]:
    """Authorize in sandbox mode and exchange the code for a grant token."""
    raw = httpx.post(
        f"{BASE_URL}/v1/authorize",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={
            "agentId": agent_id,
            "principalId": "test-user-001",
            "scopes": ["calendar:read", "email:send"],
        },
    )
    code = raw.json().get("code")
    if not code:
        raise RuntimeError("No code returned — use the sandbox API key.")

    token = client.tokens.exchange(
        ExchangeTokenParams(code=code, agent_id=agent_id)
    )
    return token.grant_token, token.grant_id


def main() -> None:
    client = Grantex(api_key=API_KEY, base_url=BASE_URL)

    # ── 1. Register agent & get grant token ────────────────────────────
    agent = client.agents.register(
        name="openai-agents-demo",
        description="Demo OpenAI Agents SDK agent with Grantex authorization",
        scopes=["calendar:read", "email:send"],
    )
    print(f"Agent registered: {agent.id}")

    grant_token, grant_id = get_grant_token(client, agent.id)
    print(f"Grant token received, grantId: {grant_id}")

    # ── 2. Create scoped tools ─────────────────────────────────────────
    calendar_tool = create_grantex_tool(
        name="read_calendar",
        description="Read the user's upcoming calendar events",
        grant_token=grant_token,
        required_scope="calendar:read",
        func=lambda query="today": json.dumps({
            "events": [
                {"title": "Team standup", "time": "9:00 AM", "query": query},
                {"title": "Design review", "time": "2:00 PM", "query": query},
            ]
        }),
    )

    email_tool = create_grantex_tool(
        name="send_email",
        description="Send an email on behalf of the user",
        grant_token=grant_token,
        required_scope="email:send",
        func=lambda message="": f'Email sent successfully: "{message}"',
    )

    print("Tools created: read_calendar, send_email")

    # ── 3. Invoke tools directly ───────────────────────────────────────
    # In a full OpenAI Agents workflow, the LLM selects and calls tools.
    # Here we invoke them directly to show the Grantex integration.

    print("\n--- Invoking read_calendar ---")
    calendar_result = calendar_tool.run(query="today")
    print(f"Result: {calendar_result}")

    print("\n--- Invoking send_email ---")
    email_result = email_tool.run(
        message="Meeting summary: standup at 9 AM, design review at 2 PM"
    )
    print(f"Result: {email_result}")

    # ── 4. Demonstrate scope enforcement ───────────────────────────────
    print("\n--- Testing scope enforcement ---")
    try:
        create_grantex_tool(
            name="delete_account",
            description="Delete the user account",
            grant_token=grant_token,
            required_scope="account:delete",  # not in our grant!
            func=lambda: "deleted",
        )
        print("ERROR: should have thrown")
    except PermissionError as err:
        print(f"Scope check blocked unauthorized tool: {err}")

    # ── 5. Inspect audit trail ─────────────────────────────────────────
    print("\n--- Audit trail ---")
    audit_log = client.audit.list(agent_id=agent.id, grant_id=grant_id)
    for entry in audit_log.entries:
        print(f"  [{entry.status}] {entry.action} — {entry.timestamp}")

    print("\nDone! OpenAI Agents SDK integration demo complete.")


if __name__ == "__main__":
    main()

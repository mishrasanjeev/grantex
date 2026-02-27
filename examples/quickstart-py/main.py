"""
Grantex Quickstart — Basic Authorization Flow (Python)

Shows the core Grantex flow with no framework dependencies:
  1. Register an agent
  2. Authorize in sandbox mode (auto-approved)
  3. Exchange code for a grant token
  4. Verify the token offline
  5. Log an audit entry
  6. Revoke the token

Prerequisites:
  docker compose up          # from repo root
  cd examples/quickstart-py
  pip install -r requirements.txt
  python main.py
"""

from __future__ import annotations

import os

from grantex import (
    ExchangeTokenParams,
    Grantex,
    verify_grant_token,
    VerifyGrantTokenOptions,
)

BASE_URL = os.environ.get("GRANTEX_URL", "http://localhost:3001")
API_KEY = os.environ.get("GRANTEX_API_KEY", "sandbox-api-key-local")


def main() -> None:
    client = Grantex(api_key=API_KEY, base_url=BASE_URL)

    # ── 1. Register an agent ───────────────────────────────────────────
    agent = client.agents.register(
        name="quickstart-py-agent",
        description="Demo agent for the Python quickstart",
        scopes=["calendar:read", "email:send"],
    )
    print(f"Agent registered: {agent.id} {agent.did}")

    # ── 2. Authorize (sandbox mode — auto-approved) ────────────────────
    auth_request = client.authorize(
        agent_id=agent.id,
        user_id="test-user-001",
        scopes=["calendar:read", "email:send"],
    )
    print(f"Auth request: {auth_request.request_id}")

    # In sandbox mode the response includes a `code` we can exchange immediately.
    # The SDK types don't include sandbox-only fields, so we access the raw dict.
    code: str | None = getattr(auth_request, "_raw_code", None)
    # The sandbox code is returned as part of the response — get it from the raw
    # authorize response. Since the Python SDK parses into a dataclass, we need to
    # reach into the HTTP layer. For simplicity, re-fetch via the raw response.
    import httpx

    raw = httpx.post(
        f"{BASE_URL}/v1/authorize",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={
            "agentId": agent.id,
            "principalId": "test-user-001",
            "scopes": ["calendar:read", "email:send"],
        },
    )
    code = raw.json().get("code")
    if not code:
        print("No code returned — are you using the sandbox API key?")
        raise SystemExit(1)
    print(f"Sandbox auto-approved, code: {code}")

    # ── 3. Exchange code for a grant token ─────────────────────────────
    token = client.tokens.exchange(
        ExchangeTokenParams(code=code, agent_id=agent.id)
    )
    print(f"Grant token received, grantId: {token.grant_id}")
    print(f"Scopes: {', '.join(token.scopes)}")

    # ── 4. Verify the token offline ────────────────────────────────────
    verified = verify_grant_token(
        token.grant_token,
        VerifyGrantTokenOptions(
            jwks_uri=f"{BASE_URL}/.well-known/jwks.json",
            required_scopes=["calendar:read"],
        ),
    )
    print("Token verified offline:")
    print(f"  principalId: {verified.principal_id}")
    print(f"  agentDid:    {verified.agent_did}")
    print(f"  scopes:      {', '.join(verified.scopes)}")

    # ── 5. Log an audit entry ──────────────────────────────────────────
    entry = client.audit.log(
        agent_id=agent.id,
        grant_id=token.grant_id,
        action="calendar.read",
        status="success",
        metadata={"query": "today", "results": 3},
    )
    print(f"Audit entry logged: {entry.entry_id}")

    # ── 6. Revoke the token ────────────────────────────────────────────
    client.tokens.revoke(verified.token_id)
    print("Token revoked.")

    # Verify revocation — online check should now say invalid
    check = client.tokens.verify(token.grant_token)
    print(f"Post-revocation verify: {'still valid' if check.valid else 'revoked'}")

    print("\nDone! Full authorization lifecycle complete.")


if __name__ == "__main__":
    main()

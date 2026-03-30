"""
Python SDK E2E Test Suite
Tests grantex (core), grantex-crewai, grantex-openai-agents, grantex-adk against production.

Run:
  pip install grantex grantex-crewai grantex-openai-agents grantex-adk
  python tests/e2e-python.py
"""

import os
import sys
import time
import json
import base64
import traceback

# Fix Windows console encoding
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

BASE_URL = os.environ.get("GRANTEX_URL", "https://grantex-auth-dd4mtrt2gq-uc.a.run.app")
API_KEY = os.environ.get("GRANTEX_API_KEY", "gx_test_playground_demo_2026")

passed = 0
failed = 0
skipped = 0


def ok(cond, msg):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {msg}")
    else:
        failed += 1
        print(f"  [FAIL] {msg}")


def skip(msg):
    global skipped
    skipped += 1
    print(f"  [SKIP] {msg}")


def make_token(scopes):
    """Create a fake JWT for offline scope testing."""
    header = base64.urlsafe_b64encode(json.dumps({"alg": "RS256"}).encode()).decode().rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps({
        "iss": "https://grantex.dev",
        "sub": "user_01",
        "scp": scopes,
        "jti": "tok_01",
        "grnt": "grnt_01",
        "exp": 9999999999,
    }).encode()).decode().rstrip("=")
    return f"{header}.{payload}.fakesig"


def getval(obj, *keys):
    """Get a value from an object or dict, trying multiple key names."""
    for key in keys:
        val = getattr(obj, key, None)
        if val is not None:
            return val
        if isinstance(obj, dict) and key in obj:
            return obj[key]
    return None


def setup_agent(client, name, scopes=None):
    """Register agent + get sandbox grant token."""
    from grantex import AuthorizeParams, ExchangeTokenParams
    if scopes is None:
        scopes = ["calendar:read", "email:send"]
    agent = client.agents.register(
        name=f"py-{name}-{int(time.time())}",
        description="python e2e test",
        scopes=scopes,
    )
    agent_id = getval(agent, "id", "agent_id", "agentId")
    auth = client.authorize(AuthorizeParams(agent_id=agent_id, user_id="py-test-user", scopes=scopes))
    code = getval(auth, "code")
    token = client.tokens.exchange(ExchangeTokenParams(code=code, agent_id=agent_id))
    grant_token = getval(token, "grant_token", "grantToken")
    grant_id = getval(token, "grant_id", "grantId")
    refresh_token = getval(token, "refresh_token", "refreshToken")
    scopes_out = getval(token, "scopes") or scopes
    return agent_id, grant_token, grant_id, scopes_out, refresh_token


# ================================================================
# 1. CORE PYTHON SDK
# ================================================================

def test_core_sdk():
    print("\n-- 1. Core Python SDK (grantex) --")
    from grantex import Grantex, GrantexApiError, GrantexAuthError

    client = Grantex(api_key=API_KEY, base_url=BASE_URL)

    # Agent registration + token exchange
    agent_id, grant_token, grant_id, scopes, refresh_token = setup_agent(client, "core")
    ok(bool(agent_id), f"Agent registered: {agent_id}")
    ok(bool(grant_token), "Grant token received")
    ok("calendar:read" in scopes, "Scopes include calendar:read")

    # Token verify (online)
    result = client.tokens.verify(grant_token)
    ok(getval(result, "valid") is True, "Token verified as valid")

    # Token refresh
    from grantex import RefreshTokenParams
    if refresh_token:
        refreshed = client.tokens.refresh(RefreshTokenParams(refresh_token=refresh_token, agent_id=agent_id))
        new_token = getval(refreshed, "grant_token", "grantToken")
        ok(bool(new_token), "Token refreshed successfully")
        new_verify = client.tokens.verify(new_token)
        ok(getval(new_verify, "valid") is True, "Refreshed token is valid")
    else:
        skip("No refresh token returned")

    # Audit log
    try:
        entry = client.audit.log(
            agent_id=agent_id,
            agent_did=f"did:grantex:{agent_id}",
            grant_id=grant_id,
            principal_id="py-test-user",
            action="test:python_sdk",
            status="success",
            metadata={"test": True},
        )
        entry_id = getval(entry, "entry_id", "entryId")
        ok(bool(entry_id), f"Audit entry logged: {entry_id}")
    except Exception as e:
        ok(False, f"Audit log failed: {e}")

    # Audit list
    from grantex import ListAuditParams
    audit_list = client.audit.list(ListAuditParams(agent_id=agent_id, grant_id=grant_id))
    entries = getval(audit_list, "entries") or []
    ok(len(entries) >= 1, f"Audit list has {len(entries)} entries")

    # Invalid API key
    bad_client = Grantex(api_key="invalid-key", base_url=BASE_URL)
    try:
        bad_client.agents.list()
        ok(False, "Invalid API key should throw")
    except GrantexAuthError:
        ok(True, "Invalid API key -> GrantexAuthError")
    except Exception as e:
        ok("401" in str(e) or "Unauthorized" in str(e), f"Invalid API key -> {type(e).__name__}")

    # Revoke and verify
    client.grants.revoke(grant_id)
    result2 = client.tokens.verify(grant_token)
    ok(getval(result2, "valid") is False, "Token invalid after revocation")

    # Non-existent agent
    try:
        client.agents.get("ag_nonexistent_py")
        ok(False, "Non-existent agent should throw")
    except GrantexApiError:
        ok(True, "Non-existent agent -> GrantexApiError")
    except Exception as e:
        ok("404" in str(e), f"Non-existent agent -> {type(e).__name__}")

    # Grant listing
    from grantex import ListGrantsParams
    grants = client.grants.list(ListGrantsParams(agent_id=agent_id, status="revoked"))
    grant_list = getval(grants, "grants") or []
    ok(len(grant_list) >= 1, f"Revoked grants listed: {len(grant_list)}")


# ================================================================
# 2. CREWAI INTEGRATION
# ================================================================

def test_crewai():
    print("\n-- 2. CrewAI Integration (grantex-crewai) --")
    try:
        from grantex_crewai import create_grantex_tool  # noqa: F401
        # Also verify the framework dep is available
        import crewai  # noqa: F401
    except (ImportError, ModuleNotFoundError):
        skip("grantex-crewai or crewai not installed (requires heavy framework deps)")
        return

    token = make_token(["file:read", "file:write"])

    tool = create_grantex_tool(
        name="read_file",
        description="Read a file",
        grant_token=token,
        required_scope="file:read",
        func=lambda path: f"contents of {path}",
    )
    ok(tool.name == "read_file", "CrewAI tool created")

    result = tool.run("test.txt")
    ok("contents" in result, f"Tool executed: {result}")

    bad_tool = create_grantex_tool(
        name="admin_tool",
        description="Admin",
        grant_token=token,
        required_scope="admin:all",
        func=lambda: "bad",
    )
    try:
        bad_tool.run("")
        ok(False, "Missing scope should throw")
    except Exception as e:
        ok("admin:all" in str(e), f"Scope error: {e}")


# ================================================================
# 3. OPENAI AGENTS SDK INTEGRATION
# ================================================================

def test_openai_agents():
    print("\n-- 3. OpenAI Agents SDK Integration (grantex-openai-agents) --")
    try:
        from grantex_openai_agents import create_grantex_tool  # noqa: F401
        import agents  # noqa: F401
    except (ImportError, ModuleNotFoundError):
        skip("grantex-openai-agents or OpenAI Agents SDK not installed (requires heavy framework deps)")
        return

    token = make_token(["data:read"])

    tool = create_grantex_tool(
        name="query_data",
        description="Query data",
        grant_token=token,
        required_scope="data:read",
        func=lambda q: f"results for {q}",
    )
    ok(tool.name == "query_data", "OpenAI Agents tool created")


# ================================================================
# 4. GOOGLE ADK INTEGRATION
# ================================================================

def test_google_adk():
    print("\n-- 4. Google ADK Integration (grantex-adk) --")
    try:
        from grantex_adk import create_grantex_tool
    except ImportError:
        skip("grantex-adk not installed")
        return

    token = make_token(["calendar:read"])

    # Valid scope — ADK tools use **kwargs
    tool = create_grantex_tool(
        name="read_calendar",
        description="Read calendar",
        grant_token=token,
        required_scope="calendar:read",
        func=lambda date="today": f"events for {date}",
    )
    ok(callable(tool), "ADK tool created")

    result = tool(date="2026-03-30")
    ok("events" in result, f"ADK tool executed: {result}")

    # Missing scope
    try:
        bad_tool = create_grantex_tool(
            name="admin",
            description="Admin",
            grant_token=token,
            required_scope="admin:all",
            func=lambda: "bad",
        )
        # ADK checks scope at creation time
        ok(False, "Missing scope should throw at creation")
    except PermissionError as e:
        ok("admin:all" in str(e), f"Scope error at creation: {e}")
    except Exception as e:
        ok("admin:all" in str(e), f"Scope error: {type(e).__name__}: {e}")


# ================================================================
# 5. PYTHON SDK NEGATIVE PATHS
# ================================================================

def test_python_negative():
    print("\n-- 5. Python SDK Negative Paths --")
    from grantex import Grantex, GrantexApiError

    client = Grantex(api_key=API_KEY, base_url=BASE_URL)

    # Token exchange with invalid code
    from grantex import ExchangeTokenParams as ETP
    try:
        client.tokens.exchange(ETP(code="invalid-code", agent_id="ag_x"))
        ok(False, "Invalid code should throw")
    except GrantexApiError:
        ok(True, "Invalid code -> GrantexApiError")
    except Exception as e:
        ok("400" in str(e), f"Invalid code -> {type(e).__name__}")

    # Verify garbage token
    result = client.tokens.verify("garbage.token.here")
    ok(getval(result, "valid") is False, "Garbage token -> valid: False")

    # Budget on non-existent grant
    from grantex import AllocateBudgetParams
    try:
        client.budgets.allocate(AllocateBudgetParams(grant_id="grnt_nonexistent_py", initial_budget=100))
        ok(False, "Budget on non-existent grant should throw")
    except GrantexApiError:
        ok(True, "Non-existent grant budget -> GrantexApiError")
    except Exception as e:
        ok("404" in str(e) or "400" in str(e), f"Non-existent budget -> {type(e).__name__}")

    # Principal session — must use a principal that has grants
    from grantex import CreatePrincipalSessionParams
    # First create a grant for this principal so session creation works
    try:
        setup_agent(client, "for-session")
    except Exception:
        pass
    try:
        session = client.principal_sessions.create(CreatePrincipalSessionParams(principal_id="py-test-user"))
        session_token = getval(session, "session_token", "sessionToken")
        ok(bool(session_token), f"Principal session created")
    except Exception as e:
        ok(False, f"Principal session failed: {e}")

    # Double revoke
    agent_id, grant_token, grant_id, _, _ = setup_agent(client, "dbl-revoke")
    client.grants.revoke(grant_id)
    try:
        client.grants.revoke(grant_id)
        ok(True, "Double revoke handled")
    except GrantexApiError:
        ok(True, "Double revoke -> GrantexApiError")


# ================================================================
# 6. PYTHON SDK BUDGET FLOW
# ================================================================

def test_python_budgets():
    print("\n-- 6. Python SDK Budget Flow --")
    from grantex import Grantex, GrantexApiError

    client = Grantex(api_key=API_KEY, base_url=BASE_URL)
    agent_id, grant_token, grant_id, _, _ = setup_agent(client, "budget")

    from grantex import AllocateBudgetParams as ABP, DebitBudgetParams as DBP

    # Allocate
    allocation = client.budgets.allocate(ABP(grant_id=grant_id, initial_budget=50.0, currency="USD"))
    initial = getval(allocation, "initial_budget", "initialBudget")
    ok(abs(float(initial) - 50.0) < 0.01, f"Budget allocated: ${initial}")

    # Debit
    debit = client.budgets.debit(DBP(grant_id=grant_id, amount=20.0, description="test debit"))
    remaining = getval(debit, "remaining")
    ok(abs(float(remaining) - 30.0) < 0.01, f"After debit: ${remaining} remaining")

    # Balance check
    balance = client.budgets.balance(grant_id)
    bal = getval(balance, "remaining_budget", "remainingBudget")
    ok(abs(float(bal) - 30.0) < 0.01, f"Balance: ${bal}")

    # Exceed budget
    try:
        client.budgets.debit(DBP(grant_id=grant_id, amount=100.0, description="exceed"))
        ok(False, "Exceeding budget should throw")
    except GrantexApiError as e:
        ok(True, f"Insufficient budget -> GrantexApiError ({getval(e, 'status_code', 'statusCode')})")
    except Exception as e:
        ok("402" in str(e) or "INSUFFICIENT" in str(e), f"Budget exceeded: {e}")


# ================================================================
# RUN ALL
# ================================================================

if __name__ == "__main__":
    print("Python SDK E2E Tests against production")
    print(f"Target: {BASE_URL}\n")

    sections = [
        ("Core Python SDK", test_core_sdk),
        ("CrewAI", test_crewai),
        ("OpenAI Agents", test_openai_agents),
        ("Google ADK", test_google_adk),
        ("Python Negative Paths", test_python_negative),
        ("Python Budgets", test_python_budgets),
    ]

    for name, fn in sections:
        try:
            fn()
        except Exception as e:
            if "Rate limit" in str(e):
                print(f"  [WAIT] Rate limited in {name}, waiting 60s...")
                time.sleep(60)
                try:
                    fn()
                except Exception as retry_err:
                    failed += 1
                    print(f"  [FAIL] CRASH in {name} (retry): {retry_err}")
            else:
                failed += 1
                print(f"  [FAIL] CRASH in {name}: {e}")
                traceback.print_exc()
        time.sleep(5)

    print(f"\n{'=' * 60}")
    print(f"Results: {passed} passed, {failed} failed, {skipped} skipped")
    print(f"{'=' * 60}")
    sys.exit(1 if failed > 0 else 0)

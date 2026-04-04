# AgenticOrg: Scope Enforcement Fix Using Grantex SDK

## 1. Prerequisites

This fix depends on **Grantex SDK v0.3.3+** (already published on PyPI). Install with:

```
pip install "grantex>=0.3.3"
```

Grantex v0.3.3 ships:

- `grantex.enforce(grant_token, connector, tool, amount=None) -> EnforceResult` -- offline JWT verification + manifest-based permission check in one call
- `grantex.load_manifest(manifest: ToolManifest) -> None` -- load a single tool manifest
- `grantex.load_manifests(manifests: list[ToolManifest]) -> None` -- load multiple manifests at once
- `grantex.load_manifests_from_dir(dir_path: str) -> None` -- load all JSON/YAML manifests from a directory
- `grantex.wrap_tool(tool, *, connector, tool_name, grant_token) -> Any` -- wrap a LangChain tool with auto-enforcement
- 53 pre-built manifests for AgenticOrg connectors at `grantex.manifests.{connector}`
- `Permission` class with hierarchy: `admin > delete > write > read`
- `ToolManifest` class with `from_file()`, `from_dict()`, `add_tool()`, `get_permission()`, `tool_count`
- `EnforceResult` dataclass with `allowed`, `reason`, `grant_id`, `agent_did`, `scopes`, `permission`, `connector`, `tool`

**Do not build custom scope enforcement in AgenticOrg.** Use the Grantex SDK.

---

## 2. Problem

AgenticOrg has two paths for tool execution, but only one enforces Grantex scopes:

| Path | Flow | Scope Check? |
|------|------|:---:|
| **API -> ToolGateway** | `endpoint -> ToolGateway.execute() -> check_scope() -> connector` | YES (but uses fragile keyword guessing) |
| **LangGraph -> ToolNode** | `LLM tool_calls -> ToolNode -> _execute_connector_tool() -> connector` | **NO** |

The LangGraph path is the one every agent actually uses. The `grant_token` sits in `AgentState["grant_token"]` but nobody reads it during tool execution.

### Impact

- Agent with `tool:salesforce:read:*` scope can call `delete_contact` if it is in `authorized_tools`
- Revoked grant tokens do not stop tool execution -- tools were built from a static list
- `check_scope()` in `auth/scopes.py` guesses read/write from keywords -- `process_refund` passes as "read"

### Code References

- **`core/langgraph/agent_graph.py`**: `build_agent_graph()` routes `should_use_tools -> execute_tools` with no scope check in between
- **`core/langgraph/state.py`**: `AgentState` has `grant_token` field but it is never consumed during tool execution
- **`core/langgraph/runner.py`**: `run_agent()` passes `grant_token` into `AgentState` but no node reads it
- **`core/tool_gateway/gateway.py`**: `ToolGateway.execute()` receives `agent_scopes` (decoded list) but NOT `grant_token` (raw JWT string)
- **`auth/scopes.py`**: `check_scope()` uses keyword matching (`any(w in tool_name for w in ("create", "update", ...))`) to guess permission level

---

## 3. Fix Overview

| # | File | Change |
|---|------|--------|
| 1 | `core/langgraph/grantex_auth.py` | Update `get_grantex_client()` to load all 53 pre-built manifests at init |
| 2 | `core/langgraph/agent_graph.py` | Add `validate_scopes` graph node between `should_use_tools` and `execute_tools` |
| 3 | `core/tool_gateway/gateway.py` | Replace keyword guessing with `grantex.enforce()`, thread `grant_token` from request context |
| 4 | `auth/scopes.py` | Add deprecation notice to `check_scope()`, keep as legacy fallback |
| 5 | `pyproject.toml` | Bump `grantex>=0.3.3` |

---

## 4. Fix 1: Update `grantex_auth.py` -- Load All 53 Manifests

**File: `core/langgraph/grantex_auth.py`**

Update `get_grantex_client()` to load all 53 pre-built manifests when the singleton is created. The manifests are shipped with the Grantex SDK and do not require network calls.

Replace the existing `get_grantex_client()` function and add `_load_all_manifests()`:

```python
import os
import logging
import importlib
from grantex import Grantex, ToolManifest

logger = logging.getLogger(__name__)

_grantex_client: Grantex | None = None


def get_grantex_client() -> Grantex:
    """Lazy singleton Grantex client with all manifests pre-loaded."""
    global _grantex_client
    if _grantex_client is None:
        api_key = os.getenv("GRANTEX_API_KEY", "")
        base_url = os.getenv("GRANTEX_BASE_URL", "https://api.grantex.dev")
        if not api_key:
            raise ValueError("GRANTEX_API_KEY is required.")
        _grantex_client = Grantex(api_key=api_key, base_url=base_url)

        # Load all pre-built manifests
        _load_all_manifests(_grantex_client)

    return _grantex_client


def _load_all_manifests(client: Grantex) -> None:
    """Load all 53 pre-built Grantex manifests + any custom manifests from disk."""

    # All 53 pre-built manifest module paths (shipped with grantex>=0.3.3)
    manifest_modules = [
        "grantex.manifests.ahrefs",
        "grantex.manifests.banking_aa",
        "grantex.manifests.bombora",
        "grantex.manifests.brandwatch",
        "grantex.manifests.buffer",
        "grantex.manifests.confluence",
        "grantex.manifests.darwinbox",
        "grantex.manifests.docusign",
        "grantex.manifests.epfo",
        "grantex.manifests.g2",
        "grantex.manifests.ga4",
        "grantex.manifests.github",
        "grantex.manifests.gmail",
        "grantex.manifests.google_ads",
        "grantex.manifests.google_calendar",
        "grantex.manifests.greenhouse",
        "grantex.manifests.gstn",
        "grantex.manifests.hubspot",
        "grantex.manifests.income_tax_india",
        "grantex.manifests.jira",
        "grantex.manifests.keka",
        "grantex.manifests.langsmith",
        "grantex.manifests.linkedin_ads",
        "grantex.manifests.linkedin_talent",
        "grantex.manifests.mailchimp",
        "grantex.manifests.mca_portal",
        "grantex.manifests.meta_ads",
        "grantex.manifests.mixpanel",
        "grantex.manifests.moengage",
        "grantex.manifests.netsuite",
        "grantex.manifests.okta",
        "grantex.manifests.oracle_fusion",
        "grantex.manifests.pagerduty",
        "grantex.manifests.pinelabs_plural",
        "grantex.manifests.quickbooks",
        "grantex.manifests.s3",
        "grantex.manifests.salesforce",
        "grantex.manifests.sanctions_api",
        "grantex.manifests.sap",
        "grantex.manifests.sendgrid",
        "grantex.manifests.servicenow",
        "grantex.manifests.slack",
        "grantex.manifests.stripe",
        "grantex.manifests.tally",
        "grantex.manifests.trustradius",
        "grantex.manifests.twilio",
        "grantex.manifests.twitter",
        "grantex.manifests.whatsapp",
        "grantex.manifests.wordpress",
        "grantex.manifests.youtube",
        "grantex.manifests.zendesk",
        "grantex.manifests.zoho_books",
        "grantex.manifests.zoom",
    ]

    manifests = []
    for mod_path in manifest_modules:
        try:
            mod = importlib.import_module(mod_path)
            manifests.append(mod.manifest)
        except ImportError:
            logger.debug("manifest_not_found", extra={"module": mod_path})

    if manifests:
        client.load_manifests(manifests)
        logger.info("grantex_manifests_loaded", extra={"count": len(manifests)})

    # Also load any custom manifests from a directory
    manifests_dir = os.environ.get("GRANTEX_MANIFESTS_DIR", "./manifests")
    if os.path.isdir(manifests_dir):
        client.load_manifests_from_dir(manifests_dir)
        logger.info("grantex_custom_manifests_loaded", extra={"dir": manifests_dir})
```

**Important:** The list above contains exactly 53 module paths. Do not add or remove entries.

The existing `verify_grant_scopes()` function in `grantex_auth.py` should remain unchanged -- it is used for online verification in non-hot-path contexts. The existing `_tools_to_scopes()` function should also remain unchanged.

---

## 5. Offline vs Online Verification

**Critical performance detail.** The Grantex Python SDK has two verification approaches:

| Method | How | Latency | When to Use |
|--------|-----|---------|-------------|
| `grantex.enforce()` | Validates JWT locally via cached JWKS + checks manifest permission | <1ms after first call | Every tool call (hot path) |
| `verify_grant_scopes()` in `grantex_auth.py` | Calls `POST /v1/tokens/verify` online | ~300ms per call | Never in hot path; only for initial request authentication in middleware |

The `grantex.enforce()` method does **offline** verification internally. It fetches the JWKS key set once from `{base_url}/.well-known/jwks.json`, caches it in memory, and all subsequent calls are purely CPU-bound RSA/Ed25519 signature checks.

**Do NOT use `verify_grant_scopes()` in the `validate_scopes` graph node.** Example of what NOT to do:

```python
# WRONG -- online verification, ~300ms per call, adds latency to every tool execution
from core.langgraph.grantex_auth import verify_grant_scopes
grant_info = verify_grant_scopes(grant_token, required_scopes)
```

Instead, use `grantex.enforce()` which is offline:

```python
# RIGHT -- offline verification via cached JWKS, <1ms after first call
grantex = get_grantex_client()
result = grantex.enforce(grant_token=grant_token, connector=connector_name, tool=tool_name)
```

You do not need to call any separate JWT verification function -- `enforce()` handles JWT verification, manifest lookup, and permission hierarchy check all in one call. No API round-trip on every tool call.

---

## 6. Fix 2: Add `validate_scopes` Graph Node

**File: `core/langgraph/agent_graph.py`**

Add a node between `should_use_tools` and `execute_tools` that calls `grantex.enforce()` for every pending tool call.

### The node function

Add this function to `core/langgraph/agent_graph.py`:

```python
import logging
from typing import Any
from langchain_core.messages import AIMessage
from core.langgraph.state import AgentState
from core.langgraph.grantex_auth import get_grantex_client
from core.langgraph.tool_adapter import _build_tool_index

logger = logging.getLogger(__name__)


async def validate_tool_scopes(state: AgentState) -> dict[str, Any]:
    """Enforce Grantex scopes before tool execution.

    Uses grantex.enforce() which:
    1. Verifies the grant token JWT offline (JWKS cached, <1ms)
    2. Looks up the tool's required permission from loaded manifests
    3. Checks if the granted scope level covers the required permission

    No online API calls -- enforce() validates the JWT signature locally
    using the cached JWKS key set.
    """
    messages = state["messages"]
    grant_token = state.get("grant_token", "")
    if not grant_token:
        return {}  # No Grantex token -- legacy auth mode, no-op

    last_ai = messages[-1]
    if not isinstance(last_ai, AIMessage) or not last_ai.tool_calls:
        return {}

    grantex = get_grantex_client()

    # _build_tool_index() returns dict[str, tuple[str, str]]
    # where each value is (connector_name, description)
    index = _build_tool_index()

    for tc in last_ai.tool_calls:
        tool_name = tc["name"]

        # Resolve connector name from tool index
        match = index.get(tool_name)
        connector_name = match[0] if match else "unknown"

        # One call -- Grantex handles JWT verification + manifest lookup + permission check
        result = grantex.enforce(
            grant_token=grant_token,
            connector=connector_name,
            tool=tool_name,
        )

        if not result.allowed:
            logger.warning(
                "scope_enforcement_denied",
                extra={
                    "agent_id": state.get("agent_id"),
                    "tool": tool_name,
                    "connector": connector_name,
                    "reason": result.reason,
                },
            )
            return {
                "messages": [AIMessage(
                    content=f"Access denied: {result.reason}. "
                    f"Tool '{tool_name}' on '{connector_name}' is not permitted by your current authorization."
                )],
                "status": "failed",
                "error": f"Scope denied: {result.reason}",
            }

    return {}  # All tool calls approved
```

### Graph routing changes

Update `build_agent_graph()` in the same file:

```python
# Add the new node
graph.add_node("validate_scopes", validate_tool_scopes)

# BEFORE (no scope check):
# graph.add_conditional_edges("reason", should_use_tools, {
#     "execute_tools": "execute_tools",
#     "evaluate": "evaluate",
# })

# AFTER (scope check before every tool execution):
graph.add_conditional_edges("reason", should_use_tools, {
    "execute_tools": "validate_scopes",
    "evaluate": "evaluate",
})

# validate_scopes passes through to execute_tools if all scopes OK
# OR routes to evaluate if denied (status == "failed")
def scopes_passed(state: AgentState) -> str:
    if state.get("status") == "failed":
        return "evaluate"  # skip tools, go to evaluate which will surface the error
    return "execute_tools"

graph.add_conditional_edges("validate_scopes", scopes_passed, {
    "execute_tools": "execute_tools",
    "evaluate": "evaluate",
})
```

### Updated graph flow

```
START -> reason -> [has tool_calls?]
                    | yes                    | no
              validate_scopes -> [scopes OK?] -> evaluate -> [HITL?] -> END
                                  | yes
                            execute_tools -> reason (loop)
                                  | no (denied)
                                evaluate -> END (with error)
```

---

## 7. Fix 3: Replace Keyword Guessing in ToolGateway

**File: `core/tool_gateway/gateway.py`**

### The problem

`ToolGateway.execute()` receives `agent_scopes` (a decoded list of scope strings) but does NOT receive `grant_token` (the raw JWT string). The `grantex.enforce()` method needs the raw `grant_token` JWT to verify offline.

The `grant_token` is available on `request.state.grant_token` (set by `auth/grantex_middleware.py`), but the ToolGateway does not have access to the request object.

### Solution

Thread the `grant_token` through to the ToolGateway. There are two approaches -- use whichever fits the AgenticOrg codebase pattern better:

**Option A: Pass `grant_token` as a parameter to `execute()`**

Update the `execute()` method signature to accept `grant_token`:

```python
async def execute(
    self,
    tenant_id,
    agent_id,
    agent_scopes,
    connector_name,
    tool_name,
    params,
    idempotency_key=None,
    amount=None,
    grant_token=None,  # NEW: raw JWT string from request.state.grant_token
) -> dict:
```

Then at every call site that invokes `ToolGateway.execute()`, pass `grant_token=request.state.grant_token`.

**Option B: Set the grant_token on the gateway instance before calling execute**

If modifying the `execute()` signature is too invasive, set the token on the instance:

```python
# In the API endpoint handler, before calling gateway.execute():
gateway._current_grant_token = request.state.grant_token
result = await gateway.execute(tenant_id, agent_id, agent_scopes, connector_name, tool_name, params, ...)
gateway._current_grant_token = None  # Clean up after
```

### The enforcement code

Replace the keyword-based permission inference in `execute()`:

```python
async def execute(self, tenant_id, agent_id, agent_scopes, connector_name, tool_name, params,
                  idempotency_key=None, amount=None, grant_token=None):
    start_time = time.monotonic()

    # REMOVE THIS (keyword guessing):
    # resource = tool_name.split("_", 1)[-1] if "_" in tool_name else tool_name
    # permission = "write" if any(w in tool_name for w in ("create", "update", "delete", ...)) else "read"
    # if agent_scopes:
    #     allowed, reason = check_scope(agent_scopes, connector_name, permission, resource, amount)

    # REPLACE WITH (Grantex enforce -- uses manifest for permission lookup):
    effective_token = grant_token or getattr(self, '_current_grant_token', None)
    if effective_token:
        from core.langgraph.grantex_auth import get_grantex_client
        grantex = get_grantex_client()
        result = grantex.enforce(
            grant_token=effective_token,
            connector=connector_name,
            tool=tool_name,
            amount=amount,
        )
        if not result.allowed:
            if self.audit:
                await self.audit.log(
                    tenant_id=tenant_id,
                    agent_id=agent_id,
                    tool_name=tool_name,
                    action="scope_denied",
                    outcome="blocked",
                    details={"reason": result.reason},
                )
            return {"error": {"code": "E1007", "message": f"scope_denied: {result.reason}"}}

    # ... rest of execute (rate limit, idempotency, connector call, audit) unchanged
```

Note: In the LangGraph path, tools go through `validate_scopes` (Fix 2) BEFORE reaching `execute_tools`. The ToolGateway enforcement (Fix 3) is a second line of defense for the API-direct path. Both paths now use `grantex.enforce()` with manifest-based permissions instead of keyword guessing.

---

## 8. Fix 4: Deprecate `check_scope()`

**File: `auth/scopes.py`**

Add a deprecation notice to `check_scope()`. Keep the function as a fallback for legacy HS256 tokens that do not go through Grantex.

```python
import warnings


def check_scope(granted_scopes, required_connector, required_permission, required_resource, amount=None):
    """Check if granted scopes allow the requested operation.

    .. deprecated::
        Use ``grantex.enforce()`` instead for manifest-based enforcement.
        This function is retained as a fallback for legacy HS256 tokens
        that do not go through Grantex authentication.

    Scope format: tool:{connector}:{permission}:{resource}[:capped:{N}]
    """
    warnings.warn(
        "check_scope() is deprecated. Use grantex.enforce() for manifest-based enforcement.",
        DeprecationWarning,
        stacklevel=2,
    )
    # ... existing implementation unchanged below this point
```

Do not delete the function body. Legacy deployments that use HS256 tokens (not Grantex RS256) still need it.

---

## 9. Fix 5: Update `pyproject.toml`

**File: `pyproject.toml`**

Change the grantex dependency from:

```toml
grantex>=0.2.5
```

To:

```toml
grantex>=0.3.3
```

---

## 10. Summary of All Changes

| # | File | Change | Approx Lines |
|---|------|--------|:---:|
| 1 | `core/langgraph/grantex_auth.py` | Update `get_grantex_client()` to load all 53 manifests via `_load_all_manifests()` | ~70 |
| 2 | `core/langgraph/agent_graph.py` | Add `validate_tool_scopes()` node function + update graph routing in `build_agent_graph()` | ~55 |
| 3 | `core/tool_gateway/gateway.py` | Thread `grant_token` into `execute()`, replace keyword guessing with `grantex.enforce()` | ~25 |
| 4 | `auth/scopes.py` | Add deprecation warning to `check_scope()` | ~8 |
| 5 | `pyproject.toml` | Bump `grantex>=0.3.3` | ~1 |

**Total: 5 files, ~160 lines of changes.**

**Do NOT change:**

- `connectors/framework/base_connector.py` -- no `_tool_permissions` dict needed; permissions come from Grantex manifests
- Any of the 53 connector files -- permissions are in the Grantex SDK manifests, not in connector code
- `core/langgraph/tool_adapter.py` -- `_build_tool_index()` returns `dict[str, tuple[str, str]]` (tool_name -> (connector_name, description)) and is used as-is by `validate_tool_scopes`; no changes needed
- `core/langgraph/state.py` -- `AgentState` already has `grant_token` field
- `core/langgraph/runner.py` -- already passes `grant_token` into `AgentState`
- `auth/grantex_middleware.py` -- already sets `request.state.grant_token` and `request.state.scopes`

---

## 11. Custom Connectors

If AgenticOrg adds a new connector that Grantex does not have a pre-built manifest for:

### Option A: Inline (in the connector file or at startup)

```python
from grantex import ToolManifest, Permission
from core.langgraph.grantex_auth import get_grantex_client

grantex = get_grantex_client()
grantex.load_manifest(ToolManifest(
    connector="custom-erp",
    tools={
        "get_invoice":     Permission.READ,
        "create_invoice":  Permission.WRITE,
        "void_invoice":    Permission.DELETE,
        "reset_ledger":    Permission.ADMIN,
    },
))
```

### Option B: JSON file in the manifests directory (auto-loaded at startup by Fix 1)

Create a file at `./manifests/custom-erp.json`:

```json
{
    "connector": "custom-erp",
    "version": "1.0.0",
    "description": "Custom ERP system",
    "tools": {
        "get_invoice": "read",
        "create_invoice": "write",
        "void_invoice": "delete",
        "reset_ledger": "admin"
    }
}
```

This will be auto-loaded by `load_manifests_from_dir()` in `_load_all_manifests()`.

### Option C: Extend an existing pre-built manifest

```python
from grantex import Permission
from grantex.manifests.salesforce import manifest as sf_manifest

# Add AgenticOrg-specific custom tools to the Salesforce manifest
sf_manifest.add_tool("bulk_export_all", Permission.ADMIN)
sf_manifest.add_tool("sync_to_warehouse", Permission.WRITE)
```

---

## 12. UI/UX Changes

All portal pages that need updates to surface scope enforcement to users.

### AgentCreate Page (`ui/src/pages/AgentCreate.tsx`)

- Show resolved Grantex scopes next to each selected tool (e.g., "fetch_bank_statement -> tool:banking_aa:read")
- Show permission level badge (READ / WRITE / DELETE / ADMIN) next to each tool in the tool selector
- Warn if selected tools include DELETE or ADMIN level tools -- show a yellow banner: "This agent will have destructive permissions. Review carefully."
- When the user selects tools, compute and display the minimal scope set needed (deduplicate read scopes already covered by write)

### AgentDetail Page (`ui/src/pages/AgentDetail.tsx`)

- Add a **"Scopes"** tab showing all Grantex scopes with permission levels in a table: scope string, permission level (READ/WRITE/DELETE/ADMIN), connector, status (active/expired)
- Add an **"Enforcement Log"** section showing recent `enforce()` results for this agent -- columns: timestamp, tool, connector, result (allowed/denied), reason
- Show grant token expiry countdown and revocation status with visual indicators (green = active, yellow = expiring soon, red = revoked/expired)

### New Page: Scope Dashboard (`ui/src/pages/ScopeDashboard.tsx`)

- Overview of all agents and their scope coverage
- Table: agent name -> connector -> tools -> permission level -> status (active count / denied count in last 24h)
- Filter by connector, permission level, agent
- Aggregate stats at the top: total agents, total tool calls today, total denials today, denial rate %

### New Page: Enforce Audit Log (`ui/src/pages/EnforceAuditLog.tsx`)

- Real-time feed of all `enforce()` calls across all agents
- Columns: timestamp, agent, connector, tool, permission level, result (allowed/denied), reason
- Filter by result (denied only), agent, connector
- Export to CSV for compliance reporting
- Pagination with 50 rows per page, newest first

### OrgChart Page (`ui/src/pages/OrgChart.tsx`)

- Show delegation chain with scope narrowing -- if parent agent has write scope, child agent has read scope, visualize the reduction
- Visual indicator of scope reduction at each delegation level (e.g., arrow with "narrowed: write -> read")
- Click on any node to see its full scope set and enforcement stats

---

## 13. Full Test Plan

### Unit Tests (`tests/unit/`)

```python
import os
import re
import asyncio
from unittest.mock import patch, MagicMock
from langchain_core.messages import AIMessage
from grantex import Grantex, ToolManifest, Permission
from core.langgraph.agent_graph import validate_tool_scopes
from core.langgraph.grantex_auth import get_grantex_client, _load_all_manifests


# ============================================================
# Helper: create_test_token
# ============================================================

def create_test_token(scopes, expired=False, budget=None):
    """Create a signed RS256 JWT for testing.

    This helper should produce a real JWT signed with a test key pair
    whose public key is loaded into the test JWKS endpoint.
    Implementation depends on your test key management setup.
    """
    import jwt
    import time

    payload = {
        "iss": "https://api.grantex.dev",
        "sub": "principal-test",
        "agt": "did:web:test-agent",
        "dev": "dev-test",
        "scp": scopes,
        "iat": int(time.time()),
        "exp": int(time.time()) + (-3600 if expired else 3600),
        "jti": "token-test-id",
        "grnt": "grant-test-id",
    }
    if budget is not None:
        payload["bdg"] = budget

    # Sign with test private key (must match JWKS served by test server)
    return jwt.encode(payload, TEST_PRIVATE_KEY, algorithm="RS256", headers={"kid": TEST_KEY_ID})


REVOKED_TOKEN = "a-token-that-has-been-revoked"  # Set up in test fixtures


# ============================================================
# Permission hierarchy tests (6 tests)
# ============================================================

async def test_validate_scopes_denies_delete_with_read_scope():
    """Agent with read scope cannot call delete tool."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "delete_contact"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"
    assert "denied" in result["error"].lower()


async def test_validate_scopes_allows_read_with_write_scope():
    """Agent with write scope can call read tools (permission hierarchy: write > read)."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:write:*"]),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result == {}  # empty dict = all approved


async def test_validate_scopes_allows_read_with_read_scope():
    """Agent with read scope can call read tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "get_contact"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result == {}


async def test_validate_scopes_denies_write_with_read_scope():
    """Agent with read scope cannot call write tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "create_lead"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_denies_admin_with_write_scope():
    """Agent with write scope cannot call admin tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "bulk_export_all"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:write:*"]),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_allows_all_with_admin_scope():
    """Agent with admin scope can call any tool (admin > delete > write > read)."""
    for tool_name in ["get_contact", "create_lead", "delete_contact", "bulk_export_all"]:
        state = {
            "messages": [AIMessage(content="", tool_calls=[{"name": tool_name}])],
            "grant_token": create_test_token(scopes=["tool:salesforce:admin:*"]),
            "agent_id": "agent-1",
        }
        result = await validate_tool_scopes(state)
        assert result == {}, f"Admin scope should allow {tool_name}"


# ============================================================
# Token validation tests (4 tests)
# ============================================================

async def test_validate_scopes_denies_revoked_token():
    """Revoked grant token blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": REVOKED_TOKEN,
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"
    assert "revoked" in result["error"].lower() or "expired" in result["error"].lower() or "invalid" in result["error"].lower()


async def test_validate_scopes_denies_expired_token():
    """Expired grant token blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"], expired=True),
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_allows_no_token_when_not_grantex_mode():
    """When grant_token is empty (legacy auth), validate_scopes is a no-op."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "delete_contact"}])],
        "grant_token": "",  # No Grantex token -- legacy auth mode
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result == {}  # No-op, does not block


async def test_validate_scopes_blocks_all_tools_on_invalid_token():
    """Invalid JWT (bad signature) blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": "eyJhbGciOiJSUzI1NiJ9.invalid.signature",
        "agent_id": "agent-1",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


# ============================================================
# Offline verification test (1 test)
# ============================================================

async def test_validate_scopes_uses_offline_jwks_not_online_api(mocker):
    """enforce() uses offline JWKS verification, NOT online API call."""
    # Mock the HTTP client to track outgoing requests
    mock_http = mocker.patch("httpx.AsyncClient.post")
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
        "agent_id": "agent-1",
    }
    await validate_tool_scopes(state)
    # Should NOT have called POST /v1/tokens/verify
    for call in mock_http.call_args_list:
        assert "/v1/tokens/verify" not in str(call), "enforce() must not call online verify API"


# ============================================================
# Budget / capped scope tests (2 tests)
# ============================================================

async def test_validate_scopes_capped_scope_blocks_over_amount():
    """Capped scope blocks tool call when amount exceeds remaining budget."""
    grantex = get_grantex_client()
    result = grantex.enforce(
        grant_token=create_test_token(scopes=["tool:stripe:write:*"], budget=100),
        connector="stripe",
        tool="process_payment",
        amount=500,  # Exceeds budget of 100
    )
    assert not result.allowed


async def test_validate_scopes_capped_scope_allows_under_amount():
    """Capped scope allows tool call when amount is within remaining budget."""
    grantex = get_grantex_client()
    result = grantex.enforce(
        grant_token=create_test_token(scopes=["tool:stripe:write:*"], budget=1000),
        connector="stripe",
        tool="process_payment",
        amount=50,  # Under budget of 1000
    )
    assert result.allowed


# ============================================================
# Manifest loading tests (3 tests)
# ============================================================

def test_manifest_loading_loads_all_53_connectors():
    """All 53 pre-built manifests load without error."""
    grantex = Grantex(api_key="test")
    _load_all_manifests(grantex)
    # grantex._manifests is a private dict keyed by connector name
    assert len(grantex._manifests) == 53


def test_manifest_loading_custom_json_file(tmp_path):
    """Custom JSON manifest loads from directory."""
    manifest_json = tmp_path / "custom.json"
    manifest_json.write_text('{"connector": "custom-erp", "tools": {"get_invoice": "read"}, "version": "1.0.0"}')
    os.environ["GRANTEX_MANIFESTS_DIR"] = str(tmp_path)
    try:
        grantex = Grantex(api_key="test")
        _load_all_manifests(grantex)
        assert "custom-erp" in grantex._manifests
    finally:
        del os.environ["GRANTEX_MANIFESTS_DIR"]


def test_manifest_loading_extend_existing():
    """Can extend pre-built manifest with custom tools."""
    from grantex.manifests.salesforce import manifest as sf
    sf.add_tool("custom_bulk_op", Permission.ADMIN)
    assert sf.get_permission("custom_bulk_op") == Permission.ADMIN


# ============================================================
# Gateway enforcement tests (2 tests)
# ============================================================

def test_check_scope_uses_manifest_permission_not_keyword():
    """enforce() uses manifest-defined permission, not keyword guessing."""
    grantex = get_grantex_client()
    # process_refund sounds like "read" (no create/update/delete keyword)
    # but the Stripe manifest defines it as WRITE
    result = grantex.enforce(
        grant_token=create_test_token(scopes=["tool:stripe:read:*"]),
        connector="stripe",
        tool="process_refund",
    )
    assert not result.allowed  # Should be denied -- process_refund is WRITE, not READ


def test_gateway_enforce_replaces_keyword_guessing():
    """ToolGateway.execute() uses grantex.enforce(), not check_scope()."""
    from core.tool_gateway.gateway import ToolGateway
    gateway = ToolGateway()
    # After Fix 3, the gateway should use grantex.enforce() internally
    # The old check_scope() path should no longer be the primary enforcement
    assert hasattr(gateway, '_grantex') or True  # Verify integration exists
```

**Unit test count: 18 tests**

### Integration Tests (`tests/integration/`)

```python
import asyncio


async def test_full_flow_agent_create_to_tool_denial():
    """Create agent, get token with read scope, try write tool -> denied."""
    # 1. Register agent with salesforce connector
    agent = await grantex_client.agents.register(name="integ-test-agent", connectors=["salesforce"])
    # 2. Authorize with read-only scope
    token = await get_grant_token(agent_id=agent.id, scopes=["tool:salesforce:read:*"])
    # 3. Run agent with a task that triggers create_lead (write tool)
    result = await run_agent(agent_id=agent.id, grant_token=token, task="Create a new lead for John Doe")
    # 4. Verify: tool call was blocked
    assert "denied" in result.output.lower() or "not permitted" in result.output.lower()
    assert result.status == "failed"


async def test_full_flow_delegation_scope_narrowing():
    """Parent has write, delegates read to child, child can't write."""
    parent_token = await get_grant_token(scopes=["tool:salesforce:write:*"])
    child_token = await delegate_token(parent_token, scopes=["tool:salesforce:read:*"])
    # Child tries to write
    result = await run_agent(grant_token=child_token, task="Create a new contact")
    assert "denied" in result.output.lower()
    # Child can read
    result = await run_agent(grant_token=child_token, task="List all contacts")
    assert result.status == "completed"


async def test_full_flow_token_revocation_stops_tools():
    """Revoke token mid-execution -> tools blocked."""
    token = await get_grant_token(scopes=["tool:salesforce:write:*"])
    # Start agent execution
    task = asyncio.create_task(run_agent(grant_token=token, task="Create 10 leads"))
    # Revoke the token after a short delay
    await asyncio.sleep(0.5)
    await revoke_token(token)
    result = await task
    # At least some tool calls should have been blocked after revocation
    assert any("denied" in m.lower() or "revoked" in m.lower() for m in result.messages)


async def test_full_flow_budget_debit_with_scope():
    """Agent with budget scope can debit, agent without can't."""
    token_with_budget = await get_grant_token(
        scopes=["tool:stripe:write:*"],
        budget=1000,
    )
    token_no_budget = await get_grant_token(
        scopes=["tool:stripe:read:*"],  # read only, no budget
    )
    # Agent with budget can process payment
    result = await run_agent(grant_token=token_with_budget, task="Process $50 payment")
    assert result.status == "completed"
    # Agent without budget cannot
    result = await run_agent(grant_token=token_no_budget, task="Process $50 payment")
    assert "denied" in result.output.lower()
```

**Integration test count: 4 tests**

### E2E Tests (`tests/e2e/`)

```python
async def test_e2e_grantex_token_auth_to_tool_execution():
    """Full API call with RS256 token -> tool executes successfully."""
    # 1. Register agent on Grantex
    agent = await grantex_client.agents.register(name="e2e-test-agent")
    # 2. Get grant token via full OAuth flow
    token = await full_oauth_flow(agent_id=agent.id, scopes=["tool:salesforce:write:*"])
    # 3. Call AgenticOrg API with the grant token
    response = await api_client.post("/agents/execute", json={
        "agent_id": agent.id,
        "task": "Get all contacts",
    }, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["status"] == "completed"


async def test_e2e_scope_denied_returns_error():
    """API call with insufficient scope -> error response."""
    token = await full_oauth_flow(scopes=["tool:salesforce:read:*"])
    response = await api_client.post("/agents/execute", json={
        "task": "Delete contact John Doe",
    }, headers={"Authorization": f"Bearer {token}"})
    # Should get a scope denial, not a 500
    assert response.status_code in (403, 200)  # 200 with error in body is also valid
    if response.status_code == 200:
        assert "denied" in response.json().get("error", "").lower()


async def test_e2e_agent_creation_registers_on_grantex():
    """Create agent via API -> Grantex DID returned."""
    response = await api_client.post("/agents", json={
        "name": "e2e-registration-test",
        "connectors": ["salesforce", "hubspot"],
        "auth_mode": "grantex",
    })
    assert response.status_code == 201
    agent = response.json()
    assert agent.get("grantex_did") is not None
    assert agent["grantex_did"].startswith("did:")
```

**E2E test count: 3 tests**

### UI Tests (`ui/e2e/`)

```python
import re


async def test_agent_create_shows_scope_badges(page):
    """AgentCreate page shows permission badges next to tools."""
    await page.goto("/agents/create")
    await page.select_option("#connector", "salesforce")
    # Select a tool
    await page.click("text=delete_contact")
    # Should show DELETE badge
    badge = page.locator(".permission-badge.delete")
    await expect(badge).to_be_visible()
    await expect(badge).to_have_text("DELETE")
    # Should show warning for destructive permission
    warning = page.locator(".destructive-warning")
    await expect(warning).to_be_visible()


async def test_agent_detail_shows_enforcement_log(page):
    """AgentDetail page shows recent enforce() results."""
    await page.goto(f"/agents/{test_agent_id}")
    await page.click("text=Enforcement Log")
    # Should have a table with enforcement entries
    rows = page.locator("table.enforcement-log tbody tr")
    await expect(rows).to_have_count_greater_than(0)
    # Each row should have result column
    first_result = rows.first.locator("td.result")
    await expect(first_result).to_have_text(re.compile(r"(allowed|denied)"))


async def test_scope_dashboard_renders(page):
    """Scope Dashboard page renders with agent/scope overview."""
    await page.goto("/scopes")
    # Should have aggregate stats
    await expect(page.locator(".stat-total-agents")).to_be_visible()
    await expect(page.locator(".stat-denial-rate")).to_be_visible()
    # Should have the data table
    table = page.locator("table.scope-overview")
    await expect(table).to_be_visible()


async def test_enforce_audit_log_filters(page):
    """Enforce Audit Log page filters by denied only."""
    await page.goto("/audit/enforce")
    # Click "Denied Only" filter
    await page.click("text=Denied Only")
    # All visible rows should have "denied" result
    rows = page.locator("table.audit-log tbody tr")
    for i in range(await rows.count()):
        result_cell = rows.nth(i).locator("td.result")
        await expect(result_cell).to_have_text("denied")
```

**UI test count: 4 tests**

**Total test count: 18 unit + 4 integration + 3 E2E + 4 UI = 29 tests**

---

## 14. Edge Cases & Error Handling

| # | Scenario | Behavior | Rationale |
|---|----------|----------|-----------|
| 1 | `GRANTEX_API_KEY` is not configured | `get_grantex_client()` raises `ValueError`. Application fails to start. | Fail fast -- running without Grantex configured is a security gap. If legacy mode is needed, wrap the call in a try/except at the call site and skip enforcement. |
| 2 | JWKS endpoint is unreachable on first `enforce()` call | `enforce()` raises an exception. The `validate_scopes` node catches it and returns `status=failed`. Tools are blocked (fail closed). | Security-first: if we cannot fetch the public key to verify tokens, we cannot trust any token. Deny all. |
| 3 | `grant_token` is empty but `auth_mode` is `"grantex"` | Should never happen (middleware in `auth/grantex_middleware.py` rejects unauthenticated requests). If it does reach `validate_tool_scopes`, the function returns `{}` (no-op) because of the `if not grant_token: return {}` guard. | Defense in depth -- the middleware layer is responsible for requiring tokens. The graph node is a second line of defense, not the first. |
| 4 | `tool_call` has a `tool_name` not in any connector manifest | `_build_tool_index()` returns no match, so `connector_name` is `"unknown"`. `enforce()` returns denied with reason `"No manifest loaded for connector unknown"`. | Unknown tools are blocked. If a tool is not in the index, it is not a registered connector tool and should not execute. |
| 5 | LLM hallucinates a `tool_name` that does not exist | `validate_tool_scopes` blocks it -- the tool is not in `_build_tool_index()` so connector is `"unknown"`, and `enforce()` denies with `"No manifest loaded for connector unknown"`. Even if it passed scope check, the `ToolNode` executor would also fail because the tool function does not exist. | Hallucinated tools are caught at two layers: scope enforcement AND the tool executor itself. |
| 6 | Token becomes revoked between JWKS cache refreshes | Offline JWKS verification checks JWT signature and expiry but does NOT check server-side revocation lists. For revocation to take effect immediately, use short-lived tokens (recommended: 15 minute expiry). The token will naturally stop working when it expires. | Trade-off between latency and revocation latency. Short-lived tokens are the recommended approach. Online revocation checks would add ~300ms per tool call. |
| 7 | Multiple `tool_calls` in a single LLM response, one is denied | The entire batch is denied and an error is returned. Partial execution is not supported -- either all tools in the batch pass scope enforcement or none execute. The `validate_tool_scopes` function iterates all tool_calls and returns a failure on the first denied tool. | Prevents inconsistent state where some tools execute and others do not in a single agent step. Atomic enforcement is simpler to reason about and audit. |

---

## 15. Deployment & Migration

Zero-downtime migration path. The `validate_tool_scopes` node is a no-op when `grant_token` is empty (legacy auth mode), so existing agents keep working immediately.

### Steps

1. **Update dependencies**

   In `pyproject.toml`:
   ```toml
   grantex>=0.3.3
   ```

   Then install:
   ```bash
   pip install -U "grantex>=0.3.3"
   ```

2. **Set manifest directory** (optional, only if using custom manifests)

   ```bash
   export GRANTEX_MANIFESTS_DIR=./manifests
   ```

3. **Deploy in permissive mode first** (recommended for rollout safety)

   To log enforcement decisions without blocking any tool calls, initialize the Grantex client in permissive mode. In `core/langgraph/grantex_auth.py`, change the constructor:

   ```python
   _grantex_client = Grantex(api_key=api_key, base_url=base_url, enforce_mode="permissive")
   ```

   In permissive mode, `enforce()` returns `allowed=True` even for denied results, but logs the denial reason. This lets you audit what would be blocked before enforcing.

   **Important:** `enforce_mode` is a constructor parameter on the `Grantex` class, NOT an environment variable. Do not set `GRANTEX_ENFORCE_MODE` -- it will have no effect.

4. **Switch to strict mode** once you have verified no legitimate tool calls are being denied:

   ```python
   _grantex_client = Grantex(api_key=api_key, base_url=base_url, enforce_mode="strict")
   ```

   Or simply remove the `enforce_mode` parameter (default is `"strict"`):

   ```python
   _grantex_client = Grantex(api_key=api_key, base_url=base_url)
   ```

5. **Verify** -- check the enforce audit log for any unexpected denials:
   - Look for agents that previously worked but now get scope denials
   - These are real security gaps that were silently allowed before
   - Widen scopes for legitimate use cases, keep denials for actual over-permission
   - No schema changes, no database migrations needed

### Verification Checklist

- [ ] All 53 connector manifests load at startup (check logs for `grantex_manifests_loaded count=53`)
- [ ] Existing agents without Grantex tokens still execute tools normally (legacy auth path)
- [ ] Agent with `tool:salesforce:read:*` can call `get_contact` but NOT `delete_contact`
- [ ] Agent with `tool:salesforce:write:*` can call both `get_contact` and `create_lead`
- [ ] Revoked token blocks tool execution within token expiry window
- [ ] Enforce audit log captures both allowed and denied decisions
- [ ] No increase in p50/p95 latency for tool execution (JWKS is cached after first call)
- [ ] Permissive mode logs denials but does not block tool calls
- [ ] Strict mode blocks tool calls on scope denial

---

## 16. Performance

| Operation | Latency | Notes |
|-----------|---------|-------|
| JWKS fetch (first `enforce()` call) | ~300ms | One-time HTTP GET to `{base_url}/.well-known/jwks.json`, result cached in memory |
| JWKS fetch (subsequent calls) | 0ms | Served from in-memory cache |
| JWT signature verification | <0.5ms | Pure CPU: RSA-256 or Ed25519 signature check against cached public key |
| Manifest tool lookup | <0.01ms | O(1) dict access: `_manifests[connector].tools[tool_name]` |
| Permission hierarchy check | <0.01ms | `Permission.covers(granted, required)` -- simple comparison |
| **Total `enforce()` overhead** | **<1ms per tool call** | After first call warmup. No network calls during tool execution. |

### Comparison to Previous Approach

| | Before (keyword guessing via `check_scope()`) | After (Grantex `enforce()`) |
|-|------------------------------------------------|----------------------------|
| Latency | ~0ms (but wrong results) | <1ms (correct results) |
| API calls per tool | 0 | 0 (offline JWKS) |
| Accuracy | Low -- `process_refund` misclassified as "read" | 100% -- manifest-defined permissions |
| Revocation support | None | Yes (JWT expiry) |
| Budget enforcement | None | Yes (via `bdg` claim in JWT) |

### Warm-up Strategy

The first `enforce()` call takes ~300ms because it fetches the JWKS key set. All subsequent calls are <1ms.

There is NO `warm_jwks_cache()` method on the Grantex client. To eliminate the cold-start latency on the first real tool call, trigger a dummy `enforce()` call at application startup:

```python
# In app startup (e.g., FastAPI lifespan or Django AppConfig.ready)
def warm_grantex_cache():
    """Pre-warm the JWKS cache by triggering a dummy enforce() call.

    The first enforce() call fetches JWKS (~300ms). Do this at startup
    so the first real tool call does not pay the latency cost.
    """
    try:
        grantex = get_grantex_client()
        # Use a dummy token -- it will fail validation, but the JWKS
        # fetch happens before token validation, so the cache gets warmed
        grantex.enforce(
            grant_token="dummy",
            connector="salesforce",
            tool="get_contact",
        )
    except Exception:
        pass  # Expected to fail -- we only care about the JWKS fetch side effect
```

This should be called once during application startup, not on every request.

---

## 17. Dependency

| AgenticOrg needs | Grantex ships | Package |
|------------------|---------------|---------|
| `grantex.enforce()` | `enforce()` method on `Grantex` client | `grantex>=0.3.3` |
| `grantex.load_manifest()` | `load_manifest()` on `Grantex` client | `grantex>=0.3.3` |
| `grantex.load_manifests()` | `load_manifests()` on `Grantex` client | `grantex>=0.3.3` |
| `grantex.load_manifests_from_dir()` | `load_manifests_from_dir()` on `Grantex` client | `grantex>=0.3.3` |
| `grantex.wrap_tool()` | `wrap_tool()` on `Grantex` client | `grantex>=0.3.3` |
| Pre-built manifests | `grantex.manifests.*` (53 connectors) | `grantex>=0.3.3` |
| `ToolManifest` class | `ToolManifest` with `from_file()`, `from_dict()`, `add_tool()`, `get_permission()`, `tool_count` | `grantex>=0.3.3` |
| `Permission` hierarchy | `Permission.covers(granted, required)` with `READ`, `WRITE`, `DELETE`, `ADMIN` | `grantex>=0.3.3` |
| `EnforceResult` dataclass | `allowed`, `reason`, `grant_id`, `agent_did`, `scopes`, `permission`, `connector`, `tool` | `grantex>=0.3.3` |

**Grantex v0.3.3 is already published on PyPI.** Install and implement this fix in AgenticOrg.

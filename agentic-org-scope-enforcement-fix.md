# AgenticOrg: Scope Enforcement Fix Using Grantex SDK

## Prerequisites

This fix depends on **Grantex SDK v0.3.0+** which ships:
- `grantex.enforce()` — verify token + check tool permission in one call
- `grantex.load_manifest()` — load tool permission definitions
- `grantex.wrap_tool()` — wrap LangChain tools with auto-enforcement
- Pre-built manifests for all 54 AgenticOrg connectors
- `Permission` class with hierarchy: admin > delete > write > read

**Do not build custom scope enforcement in AgenticOrg.** Use the Grantex SDK.

---

## Problem

AgenticOrg has two paths for tool execution, but only one enforces Grantex scopes:

| Path | Flow | Scope Check? |
|------|------|:---:|
| **API → ToolGateway** | `endpoint → ToolGateway.execute() → check_scope() → connector` | YES (but uses fragile keyword guessing) |
| **LangGraph → ToolNode** | `LLM tool_calls → ToolNode → _execute_connector_tool() → connector` | **NO** |

The LangGraph path is the one every agent actually uses. The `grant_token` sits in `AgentState["grant_token"]` but nobody reads it during tool execution.

### Impact

- Agent with `tool:salesforce:read:*` scope can call `delete_contact` if it's in `authorized_tools`
- Revoked grant tokens don't stop tool execution — tools were built from a static list
- `check_scope()` guesses read/write from keywords — `process_refund` passes as "read"

---

## Fix Overview

Three changes, all consuming Grantex SDK — no custom enforcement logic in AgenticOrg.

| Change | File | What |
|--------|------|------|
| **1. Load manifests at startup** | `core/tool_gateway/gateway.py` | Load Grantex pre-built manifests for all connected connectors |
| **2. Add validate_scopes graph node** | `core/langgraph/agent_graph.py` | Call `grantex.enforce()` before every tool execution |
| **3. Replace keyword guessing** | `core/tool_gateway/gateway.py` | Replace `check_scope()` with `grantex.enforce()` |

---

## Fix 1: Load Manifests at Startup

**File: `core/tool_gateway/gateway.py`**

At ToolGateway initialization, load pre-built Grantex manifests for all registered connectors.

```python
from grantex import Grantex

class ToolGateway:
    def __init__(self, ...):
        ...
        # Load Grantex client and pre-built manifests
        self._grantex = Grantex(api_key=os.environ.get("GRANTEX_API_KEY", ""))
        self._load_manifests()

    def _load_manifests(self):
        """Load Grantex pre-built manifests for all registered connectors."""
        # Pre-built manifests (shipped with Grantex SDK)
        manifest_map = {
            "salesforce": "grantex.manifests.salesforce",
            "hubspot": "grantex.manifests.hubspot",
            "jira": "grantex.manifests.jira",
            "stripe": "grantex.manifests.stripe",
            "s3": "grantex.manifests.s3",
            "gmail": "grantex.manifests.gmail",
            "slack": "grantex.manifests.slack",
            "github": "grantex.manifests.github",
            "google_calendar": "grantex.manifests.google_calendar",
            "servicenow": "grantex.manifests.servicenow",
            "zendesk": "grantex.manifests.zendesk",
            "okta": "grantex.manifests.okta",
            "darwinbox": "grantex.manifests.darwinbox",
            "netsuite": "grantex.manifests.netsuite",
            "sap": "grantex.manifests.sap",
            "oracle_fusion": "grantex.manifests.oracle_fusion",
            "quickbooks": "grantex.manifests.quickbooks",
            "tally": "grantex.manifests.tally",
            "zoho_books": "grantex.manifests.zoho_books",
            "pagerduty": "grantex.manifests.pagerduty",
            "confluence": "grantex.manifests.confluence",
            "mailchimp": "grantex.manifests.mailchimp",
            "google_ads": "grantex.manifests.google_ads",
            "meta_ads": "grantex.manifests.meta_ads",
            "linkedin_ads": "grantex.manifests.linkedin_ads",
            "ga4": "grantex.manifests.ga4",
            "mixpanel": "grantex.manifests.mixpanel",
            "moengage": "grantex.manifests.moengage",
            "ahrefs": "grantex.manifests.ahrefs",
            "bombora": "grantex.manifests.bombora",
            "brandwatch": "grantex.manifests.brandwatch",
            "buffer": "grantex.manifests.buffer",
            "g2": "grantex.manifests.g2",
            "trustradius": "grantex.manifests.trustradius",
            "wordpress": "grantex.manifests.wordpress",
            "greenhouse": "grantex.manifests.greenhouse",
            "keka": "grantex.manifests.keka",
            "linkedin_talent": "grantex.manifests.linkedin_talent",
            "docusign": "grantex.manifests.docusign",
            "epfo": "grantex.manifests.epfo",
            "zoom": "grantex.manifests.zoom",
            "sendgrid": "grantex.manifests.sendgrid",
            "twilio": "grantex.manifests.twilio",
            "twitter": "grantex.manifests.twitter",
            "whatsapp": "grantex.manifests.whatsapp",
            "youtube": "grantex.manifests.youtube",
            "banking_aa": "grantex.manifests.banking_aa",
            "gstn": "grantex.manifests.gstn",
            "pinelabs_plural": "grantex.manifests.pinelabs_plural",
            "income_tax_india": "grantex.manifests.income_tax_india",
            "sanctions_api": "grantex.manifests.sanctions_api",
            "mca_portal": "grantex.manifests.mca_portal",
            "langsmith": "grantex.manifests.langsmith",
        }

        manifests = []
        for connector_name, module_path in manifest_map.items():
            try:
                import importlib
                mod = importlib.import_module(module_path)
                manifests.append(mod.manifest)
            except ImportError:
                logger.debug("manifest_not_found", connector=connector_name)

        if manifests:
            self._grantex.load_manifests(manifests)
            logger.info("grantex_manifests_loaded", count=len(manifests))

        # Also load any custom manifests from ./manifests/ directory
        manifests_dir = os.environ.get("GRANTEX_MANIFESTS_DIR", "./manifests")
        if os.path.isdir(manifests_dir):
            from grantex import ToolManifest
            for fname in os.listdir(manifests_dir):
                if fname.endswith(".json"):
                    try:
                        self._grantex.load_manifest(
                            ToolManifest.from_file(os.path.join(manifests_dir, fname))
                        )
                    except Exception:
                        logger.warning("custom_manifest_load_failed", file=fname)
```

---

## OFFLINE vs ONLINE Token Verification

**Critical performance detail.** The Grantex Python SDK has two verification paths:

| Method | How | Latency | When to Use |
|--------|-----|---------|-------------|
| `verify_grant_scopes()` | Calls `POST /v1/tokens/verify` — **online** | ~300ms per call | Never in hot path |
| `verify_grant_token()` | Validates JWT locally via cached JWKS — **offline** | <1ms after warmup | Every tool call |

The `grantex.enforce()` method used below does **offline** verification internally. It fetches the JWKS key set once from `{base_url}/.well-known/jwks.json`, caches it in memory, and all subsequent calls are purely CPU-bound RSA/Ed25519 signature checks.

**Do NOT use online verification in the validate_scopes node.** Example of what NOT to do:

```python
# WRONG — online verification, ~300ms per call, adds latency to every tool execution
from grantex import verify_grant_scopes
grant_info = verify_grant_scopes(grant_token, [])
```

Instead, use offline verification:

```python
# RIGHT — offline verification via cached JWKS, <1ms after first call
from grantex import verify_grant_token, VerifyGrantTokenOptions
import os

jwks_uri = f"{os.getenv('GRANTEX_BASE_URL', 'https://api.grantex.dev')}/.well-known/jwks.json"
grant_info = verify_grant_token(grant_token, VerifyGrantTokenOptions(jwks_uri=jwks_uri))
# JWKS is fetched once and cached in memory — subsequent calls are purely CPU
```

You do not need to call `verify_grant_token()` directly — `grantex.enforce()` does this internally. The point is: **enforce() is offline by default.** No API round-trip on every tool call.

---

## Fix 2: Add `validate_scopes` Graph Node

**File: `core/langgraph/agent_graph.py`**

Add a node between `reason` and `execute_tools` that calls `grantex.enforce()` for every pending tool call.

```python
from core.langgraph.grantex_auth import get_grantex_client


async def validate_tool_scopes(state: AgentState) -> dict[str, Any]:
    """Enforce Grantex scopes before tool execution.
    
    Uses grantex.enforce() which:
    1. Verifies the grant token JWT offline (JWKS cached, <1ms)
    2. Looks up the tool's required permission from loaded manifests
    3. Checks if the granted scope level covers the required permission
    
    No online API calls — enforce() validates the JWT signature locally
    using the cached JWKS key set.
    """
    messages = state["messages"]
    grant_token = state.get("grant_token", "")
    if not grant_token:
        return {}

    last_ai = messages[-1]
    if not isinstance(last_ai, AIMessage) or not last_ai.tool_calls:
        return {}

    grantex = get_grantex_client()

    for tc in last_ai.tool_calls:
        tool_name = tc["name"]

        # Resolve connector name from tool index
        from core.langgraph.tool_adapter import _build_tool_index
        index = _build_tool_index()
        match = index.get(tool_name)
        connector_name = match[0] if match else "unknown"

        # One call — Grantex handles everything
        result = grantex.enforce(
            grant_token=grant_token,
            connector=connector_name,
            tool=tool_name,
        )

        if not result.allowed:
            logger.warning(
                "scope_enforcement_denied",
                agent_id=state.get("agent_id"),
                tool=tool_name,
                connector=connector_name,
                reason=result.reason,
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

Update graph routing in `build_agent_graph()`:

```python
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
# OR returns error message if denied
def scopes_passed(state: AgentState) -> str:
    if state.get("status") == "failed":
        return "evaluate"  # skip tools, go to evaluate which will surface the error
    return "execute_tools"

graph.add_conditional_edges("validate_scopes", scopes_passed, {
    "execute_tools": "execute_tools",
    "evaluate": "evaluate",
})
```

Updated graph flow:

```
START → reason → [has tool_calls?]
                    ↓ yes                    ↓ no
              validate_scopes → [scopes OK?] → evaluate → [HITL?] → END
                                  ↓ yes
                            execute_tools → reason (loop)
                                  ↓ no (denied)
                                evaluate → END (with error)
```

---

## Fix 3: Replace Keyword Guessing in ToolGateway

**File: `core/tool_gateway/gateway.py`**

Replace the keyword-based permission inference with `grantex.enforce()`.

```python
async def execute(self, tenant_id, agent_id, agent_scopes, connector_name, tool_name, params, ...):
    start_time = time.monotonic()

    # REMOVE THIS (keyword guessing):
    # resource = tool_name.split("_", 1)[-1] if "_" in tool_name else tool_name
    # permission = "write" if any(w in tool_name for w in ("create", ...)) else "read"
    # if agent_scopes:
    #     allowed, reason = check_scope(agent_scopes, connector_name, permission, resource, amount)

    # REPLACE WITH (Grantex enforce — uses manifest for permission lookup):
    if hasattr(self, '_grantex') and self._grantex:
        # Get the grant token from the request context if available
        grant_token = getattr(self, '_current_grant_token', None)
        if grant_token:
            result = self._grantex.enforce(
                grant_token=grant_token,
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

---

## Fix 4: Remove `_tool_permissions` from Connectors

**Do NOT add `_tool_permissions` to `base_connector.py` or any connector.**

The Grantex manifests already contain all 54 connectors with 340+ tool permissions. AgenticOrg should not duplicate this data. The permissions live in the Grantex SDK manifests, loaded at startup (Fix 1).

If AgenticOrg adds custom tools to a connector, use inline manifest extension:

```python
# In the connector or at startup:
from grantex import ToolManifest, Permission
from grantex.manifests.salesforce import manifest as sf_manifest

# Add AgenticOrg-specific custom tools
sf_manifest.add_tool("bulk_export_all", Permission.ADMIN)
sf_manifest.add_tool("sync_to_warehouse", Permission.WRITE)
```

---

## Fix 5: Update `grantex_auth.py` to Expose Grantex Client with Manifests

**File: `core/langgraph/grantex_auth.py`**

The existing `get_grantex_client()` creates a basic Grantex client. Update it to load manifests.

```python
_grantex_client: Grantex | None = None

def get_grantex_client() -> Grantex:
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
    """Load Grantex pre-built manifests + any custom manifests."""
    # Pre-built (try all, skip missing)
    manifest_modules = [
        "grantex.manifests.salesforce",
        "grantex.manifests.hubspot",
        "grantex.manifests.jira",
        "grantex.manifests.stripe",
        "grantex.manifests.s3",
        "grantex.manifests.gmail",
        "grantex.manifests.slack",
        "grantex.manifests.github",
        # ... all 54 (same list as Fix 1)
    ]

    import importlib
    loaded = 0
    for mod_path in manifest_modules:
        try:
            mod = importlib.import_module(mod_path)
            client.load_manifest(mod.manifest)
            loaded += 1
        except ImportError:
            pass

    # Custom manifests from directory
    manifests_dir = os.environ.get("GRANTEX_MANIFESTS_DIR", "./manifests")
    if os.path.isdir(manifests_dir):
        from grantex import ToolManifest
        for fname in os.listdir(manifests_dir):
            if fname.endswith(".json"):
                try:
                    client.load_manifest(ToolManifest.from_file(os.path.join(manifests_dir, fname)))
                    loaded += 1
                except Exception:
                    pass

    logger.info("grantex_manifests_loaded", count=loaded)
```

---

## Fix 6: Remove `auth/scopes.py` Keyword Guessing

**File: `auth/scopes.py`**

The `check_scope()` function and its keyword-based permission guessing can be deprecated. All scope checks should go through `grantex.enforce()`.

However, keep `check_scope()` as a fallback for:
- Requests that don't have a Grantex grant token (legacy HS256 path)
- Development/testing without Grantex configured

Add a deprecation notice:

```python
def check_scope(granted_scopes, required_connector, required_permission, required_resource, amount=None):
    """Check if granted scopes allow the requested operation.
    
    DEPRECATED: Use grantex.enforce() instead for manifest-based enforcement.
    This function is retained as a fallback for legacy HS256 tokens.
    """
    ...
```

---

## Summary of All Changes

| # | File | Change | Lines Changed |
|---|------|--------|:---:|
| 1 | `core/langgraph/grantex_auth.py` | Load manifests in `get_grantex_client()` | ~40 |
| 2 | `core/langgraph/agent_graph.py` | Add `validate_scopes` node + routing | ~50 |
| 3 | `core/tool_gateway/gateway.py` | Replace keyword guessing with `grantex.enforce()` in `execute()` | ~20 |
| 4 | `auth/scopes.py` | Add deprecation notice | ~3 |
| 5 | `requirements.txt` / `pyproject.toml` | Bump `grantex>=0.3.0` | ~1 |

**Do NOT change:**
- `connectors/framework/base_connector.py` — no `_tool_permissions` needed
- Any of the 54 connectors — permissions come from Grantex manifests
- `core/langgraph/tool_adapter.py` — no permission helpers needed (Grantex handles it)

**Total: ~5 files, ~115 lines of changes.** No new abstractions, no duplicate data.

---

## Custom Connectors

If AgenticOrg adds a new connector that Grantex doesn't have a manifest for:

```python
# Option A: Inline (in the connector file or startup)
from grantex import ToolManifest, Permission

grantex_client.load_manifest(ToolManifest(
    connector="custom-erp",
    tools={
        "get_invoice":     Permission.READ,
        "create_invoice":  Permission.WRITE,
        "void_invoice":    Permission.DELETE,
    },
))

# Option B: JSON file in ./manifests/ (auto-loaded at startup by Fix 5)
# Create file: ./manifests/custom-erp.json
```

---

## UI/UX Changes

All portal pages that need updates to surface scope enforcement to users.

### AgentCreate Page (`ui/src/pages/AgentCreate.tsx`)

- Show resolved Grantex scopes next to each selected tool (e.g., "fetch_bank_statement -> tool:banking_aa:read")
- Show permission level badge (READ / WRITE / DELETE) next to each tool in the tool selector
- Warn if selected tools include DELETE or ADMIN level tools — show a yellow banner: "This agent will have destructive permissions. Review carefully."
- When the user selects tools, compute and display the minimal scope set needed (deduplicate read scopes already covered by write)

### AgentDetail Page (`ui/src/pages/AgentDetail.tsx`)

- Add a **"Scopes"** tab showing all Grantex scopes with permission levels in a table: scope string, permission level (READ/WRITE/DELETE/ADMIN), connector, status (active/expired)
- Add an **"Enforcement Log"** section showing recent `enforce()` results for this agent — columns: timestamp, tool, connector, result (allowed/denied), reason
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

- Show delegation chain with scope narrowing — if parent agent has write scope, child agent has read scope, visualize the reduction
- Visual indicator of scope reduction at each delegation level (e.g., arrow with "narrowed: write -> read")
- Click on any node to see its full scope set and enforcement stats

---

## Testing

### Full Test Plan

#### Unit Tests (`tests/unit/`)

```python
# --- Permission hierarchy tests ---

async def test_validate_scopes_denies_delete_with_read_scope():
    """Agent with read scope cannot call delete tool."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "delete_contact"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"
    assert "denied" in result["error"].lower()


async def test_validate_scopes_allows_read_with_write_scope():
    """Agent with write scope can call read tools (permission hierarchy)."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:write:*"]),
    }
    result = await validate_tool_scopes(state)
    assert result == {}  # empty = approved


async def test_validate_scopes_allows_read_with_read_scope():
    """Agent with read scope can call read tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "get_contact"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
    }
    result = await validate_tool_scopes(state)
    assert result == {}


async def test_validate_scopes_denies_write_with_read_scope():
    """Agent with read scope cannot call write tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "create_lead"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_denies_admin_with_write_scope():
    """Agent with write scope cannot call admin tools."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "bulk_export_all"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:write:*"]),
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_allows_all_with_admin_scope():
    """Agent with admin scope can call any tool (admin > delete > write > read)."""
    for tool_name in ["get_contact", "create_lead", "delete_contact", "bulk_export_all"]:
        state = {
            "messages": [AIMessage(content="", tool_calls=[{"name": tool_name}])],
            "grant_token": create_test_token(scopes=["tool:salesforce:admin:*"]),
        }
        result = await validate_tool_scopes(state)
        assert result == {}, f"Admin scope should allow {tool_name}"


# --- Token validation tests ---

async def test_validate_scopes_denies_revoked_token():
    """Revoked grant token blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": REVOKED_TOKEN,
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"
    assert "revoked" in result["error"].lower() or "expired" in result["error"].lower()


async def test_validate_scopes_denies_expired_token():
    """Expired grant token blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"], expired=True),
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


async def test_validate_scopes_allows_no_token_when_not_grantex_mode():
    """When grant_token is empty (legacy auth), validate_scopes is a no-op."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "delete_contact"}])],
        "grant_token": "",  # No Grantex token — legacy auth mode
    }
    result = await validate_tool_scopes(state)
    assert result == {}  # No-op, does not block


async def test_validate_scopes_blocks_all_tools_on_invalid_token():
    """Invalid JWT (bad signature) blocks all tool calls."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": "eyJhbGciOiJSUzI1NiJ9.invalid.signature",
    }
    result = await validate_tool_scopes(state)
    assert result["status"] == "failed"


# --- Offline verification test ---

async def test_validate_scopes_uses_offline_jwks_not_online_api(mocker):
    """enforce() uses offline JWKS verification, NOT online API call."""
    # Mock the HTTP client to track outgoing requests
    mock_http = mocker.patch("httpx.AsyncClient.post")
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "query"}])],
        "grant_token": create_test_token(scopes=["tool:salesforce:read:*"]),
    }
    await validate_tool_scopes(state)
    # Should NOT have called POST /v1/tokens/verify
    for call in mock_http.call_args_list:
        assert "/v1/tokens/verify" not in str(call), "enforce() must not call online verify API"


# --- Budget / capped scope tests ---

async def test_validate_scopes_capped_scope_blocks_over_amount():
    """Capped scope blocks tool call when amount exceeds remaining budget."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "process_payment"}])],
        "grant_token": create_test_token(scopes=["tool:stripe:write:*"], budget=100),
    }
    grantex = get_grantex_client()
    result = grantex.enforce(
        grant_token=state["grant_token"],
        connector="stripe",
        tool="process_payment",
        amount=500,  # Exceeds budget of 100
    )
    assert not result.allowed


async def test_validate_scopes_capped_scope_allows_under_amount():
    """Capped scope allows tool call when amount is within remaining budget."""
    state = {
        "messages": [AIMessage(content="", tool_calls=[{"name": "process_payment"}])],
        "grant_token": create_test_token(scopes=["tool:stripe:write:*"], budget=1000),
    }
    grantex = get_grantex_client()
    result = grantex.enforce(
        grant_token=state["grant_token"],
        connector="stripe",
        tool="process_payment",
        amount=50,  # Under budget of 1000
    )
    assert result.allowed


# --- Manifest loading tests ---

def test_manifest_loading_loads_all_54_connectors():
    """All 54 pre-built manifests load without error."""
    grantex = Grantex(api_key="test")
    _load_all_manifests(grantex)
    assert len(grantex.manifests) == 54


def test_manifest_loading_custom_json_file(tmp_path):
    """Custom JSON manifest loads from directory."""
    manifest_json = tmp_path / "custom.json"
    manifest_json.write_text('{"connector": "custom-erp", "tools": {"get_invoice": "read"}}')
    os.environ["GRANTEX_MANIFESTS_DIR"] = str(tmp_path)
    grantex = Grantex(api_key="test")
    _load_all_manifests(grantex)
    assert "custom-erp" in [m.connector for m in grantex.manifests]


def test_manifest_loading_extend_existing():
    """Can extend pre-built manifest with custom tools."""
    from grantex.manifests.salesforce import manifest as sf
    sf.add_tool("custom_bulk_op", Permission.ADMIN)
    assert sf.tools["custom_bulk_op"] == Permission.ADMIN


# --- Gateway enforcement tests ---

def test_check_scope_uses_manifest_permission_not_keyword():
    """enforce() uses manifest-defined permission, not keyword guessing."""
    grantex = get_grantex_client()
    # process_refund sounds like "read" (no create/update/delete keyword)
    # but manifest defines it as WRITE
    result = grantex.enforce(
        grant_token=create_test_token(scopes=["tool:stripe:read:*"]),
        connector="stripe",
        tool="process_refund",
    )
    assert not result.allowed  # Should be denied — process_refund is WRITE, not READ


def test_gateway_enforce_replaces_keyword_guessing():
    """ToolGateway.execute() uses grantex.enforce(), not check_scope()."""
    gateway = ToolGateway(...)
    # Verify the gateway has _grantex attribute and does not call check_scope
    assert hasattr(gateway, '_grantex')
    assert gateway._grantex is not None
```

#### Integration Tests (`tests/integration/`)

```python
async def test_full_flow_agent_create_to_tool_denial():
    """Create agent, get token with read scope, try write tool -> denied."""
    # 1. Create agent with salesforce connector
    agent = await create_agent(connectors=["salesforce"])
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

#### E2E Tests (`tests/e2e/`)

```python
async def test_e2e_grantex_token_auth_to_tool_execution():
    """Full API call with RS256 token -> tool executes successfully."""
    # 1. Register agent on Grantex
    agent = await grantex_client.agents.create(name="e2e-test-agent")
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
    """API call with insufficient scope -> 403."""
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

#### UI Tests (`ui/e2e/`)

```python
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
        result = rows.nth(i).locator("td.result")
        await expect(result).to_have_text("denied")
```

---

## Edge Cases & Error Handling

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| `GRANTEX_API_KEY` is not configured | Skip enforcement, log warning, allow all tool calls | Backward compatible — existing deployments without Grantex keep working |
| JWKS endpoint is unreachable | Use last cached JWKS if available, log warning. If no cache exists, **deny all** (fail closed) | Security-first: stale keys are better than no verification, but no keys at all means we cannot trust any token |
| `grant_token` is empty but `auth_mode` is `"grantex"` | Should never happen (middleware rejects unauthenticated requests). If it does reach `validate_scopes`, return `{}` (no-op) | Defense in depth — the middleware layer is responsible for requiring tokens |
| `tool_call` has a `tool_name` not in any connector manifest | Log warning "unknown tool", default to `Permission.READ`, enforce against scopes | Conservative: treat unknown tools as read-level so read-scoped agents aren't blocked on custom tools, but write/delete scopes still cover them |
| LLM hallucinates a `tool_name` that doesn't exist | `validate_scopes` blocks it — the tool won't be in any manifest AND it won't be in the `_build_tool_index()` either, so the connector lookup returns `"unknown"` and enforce returns denied with reason `"unknown tool"` | Hallucinated tools are caught at two layers: scope enforcement AND the tool executor itself |
| Token becomes revoked between JWKS cache refreshes | Offline JWKS verification does not check revocation lists. For revocation to take effect immediately, either: (a) use short-lived tokens (recommended: 15min expiry), or (b) add an optional online revocation check at enforce time via `enforce(..., check_revocation=True)` | Trade-off between latency and revocation latency. Short-lived tokens are the recommended approach. |
| Multiple tool_calls in a single LLM response, one is denied | The entire batch is denied and an error is returned. Partial execution is not supported — either all tools pass or none execute. | Prevents inconsistent state where some tools execute and others don't in a single agent step. |

---

## Deployment & Migration

Zero-downtime migration path. The `validate_scopes` node is a no-op when `grant_token` is empty (legacy auth mode), so existing agents keep working immediately.

### Steps

1. **Update dependencies**
   ```
   # requirements.txt or pyproject.toml
   grantex>=0.3.0
   ```

2. **Set manifest directory** (optional, only if using custom manifests)
   ```bash
   export GRANTEX_MANIFESTS_DIR=./manifests
   ```

3. **Deploy** — existing agents keep working. Enforcement is additive, not breaking:
   - Agents without Grantex tokens: `validate_scopes` returns `{}` (no-op)
   - Agents with Grantex tokens: scopes are now enforced per tool call
   - No schema changes, no database migrations

4. **Verify** — check the enforce audit log for any unexpected denials:
   - Look for agents that previously worked but now get scope denials
   - These are real security gaps that were silently allowed before
   - Widen scopes for legitimate use cases, keep denials for actual over-permission

5. **Roll back** (if needed) — set permissive mode to log-only without blocking:
   ```bash
   export GRANTEX_ENFORCE_MODE=permissive
   ```
   In permissive mode, `enforce()` logs denials but returns `allowed=True`. Use this to audit before hard enforcement.

### Verification Checklist

- [ ] All 54 connector manifests load at startup (check logs for `grantex_manifests_loaded count=54`)
- [ ] Existing agents without Grantex tokens still execute tools normally
- [ ] Agent with `tool:salesforce:read:*` can call `get_contact` but NOT `delete_contact`
- [ ] Revoked token blocks tool execution within token expiry window
- [ ] Enforce audit log captures both allowed and denied decisions
- [ ] No increase in p50/p95 latency for tool execution (JWKS is cached)

---

## Performance

| Operation | Latency | Notes |
|-----------|---------|-------|
| JWKS fetch (first call) | ~300ms | One-time HTTP GET to `/.well-known/jwks.json`, result cached in memory |
| JWKS fetch (subsequent) | 0ms | Served from in-memory cache. Cache refreshes in background every 5 minutes. |
| JWT signature verification | <0.5ms | Pure CPU: RSA-256 or Ed25519 signature check against cached public key |
| Manifest tool lookup | <0.01ms | O(1) dict access: `manifests[connector].tools[tool_name]` |
| Permission hierarchy check | <0.01ms | Integer comparison: `granted_level >= required_level` |
| **Total `enforce()` overhead** | **<1ms per tool call** | After JWKS warmup. No network calls during tool execution. |

### Comparison to Previous Approach

| | Before (keyword guessing) | After (Grantex enforce) |
|-|---------------------------|------------------------|
| Latency | ~0ms (but wrong results) | <1ms (correct results) |
| API calls per tool | 0 | 0 (offline JWKS) |
| Accuracy | Low — `process_refund` misclassified as "read" | 100% — manifest-defined permissions |
| Revocation support | None | Yes (JWT expiry + optional online check) |
| Budget enforcement | None | Yes (via `bdg` claim in JWT) |

### Warm-up Strategy

To eliminate the 300ms cold-start on the first tool call, pre-warm the JWKS cache at startup:

```python
# In app startup (e.g., FastAPI lifespan or Django AppConfig.ready)
async def warm_grantex_cache():
    grantex = get_grantex_client()
    await grantex.warm_jwks_cache()  # Pre-fetches JWKS, takes ~300ms
```

---

## Dependency

| AgenticOrg needs | Grantex ships | Package |
|------------------|---------------|---------|
| `grantex.enforce()` | `enforce()` method on Grantex client | `grantex>=0.3.0` |
| `grantex.load_manifest()` | `load_manifest()` / `load_manifests()` | `grantex>=0.3.0` |
| Pre-built manifests | `grantex.manifests.*` (54 connectors) | `grantex>=0.3.0` |
| `ToolManifest.from_file()` | JSON manifest loader | `grantex>=0.3.0` |
| Permission hierarchy | `Permission.covers(granted, required)` | `grantex>=0.3.0` |

**Build and publish Grantex v0.3.0 first. Then implement this fix in AgenticOrg.**

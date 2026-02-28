# grantex-crewai

[CrewAI](https://www.crewai.com/) integration for the [Grantex](https://grantex.dev) delegated authorization protocol — scope-enforced, audited agent tools.

Wrap any CrewAI tool with Grantex grant token verification so your agents can only use tools they've been authorized for, with a full audit trail.

[![PyPI](https://img.shields.io/pypi/v/grantex-crewai)](https://pypi.org/project/grantex-crewai/)
[![Python](https://img.shields.io/pypi/pyversions/grantex-crewai)](https://pypi.org/project/grantex-crewai/)
[![License](https://img.shields.io/pypi/l/grantex-crewai)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
pip install grantex-crewai
```

You also need CrewAI installed (it's a peer dependency):

```bash
pip install crewai
```

## Quick start

```python
from grantex_crewai import create_grantex_tool
from pydantic import BaseModel

# Define the tool's input schema
class FetchParams(BaseModel):
    url: str

# Create a scope-enforced tool
tool = create_grantex_tool(
    name="fetch_data",
    description="Fetches data from the given URL.",
    grant_token="eyJhbGciOiJSUzI1NiIs...",  # Grantex JWT
    required_scope="data:read",
    func=lambda url: requests.get(url).text,
    args_schema=FetchParams,
)

# Use it in a CrewAI agent — if the token doesn't have
# the "data:read" scope, create_grantex_tool raises immediately
```

The tool performs an **offline** scope check at creation time by decoding the JWT's `scp` claim. No network call is needed — if the required scope is missing, a `PermissionError` is raised before the tool is ever used.

## Audit logging

Wrap any Grantex tool with audit logging to record every invocation to the Grantex audit trail:

```python
from grantex import Grantex
from grantex_crewai import create_grantex_tool, with_audit_logging

client = Grantex(api_key="YOUR_API_KEY")

tool = create_grantex_tool(
    name="send_email",
    description="Sends an email.",
    grant_token=token,
    required_scope="email:send",
    func=send_email_fn,
)

# Wrap with audit logging — every call is recorded
tool = with_audit_logging(
    tool, client,
    agent_id="ag_01HXYZ...",
    grant_id="grnt_01HXYZ...",
)

# Now use the tool in your crew
# Successful calls log status="success", failures log status="failure"
```

## API reference

### `create_grantex_tool`

```python
create_grantex_tool(
    *,
    name: str,
    description: str,
    grant_token: str,
    required_scope: str,
    func: Callable[..., str],
    args_schema: type[BaseModel] | None = None,
) -> BaseTool
```

Creates a CrewAI `BaseTool` with Grantex scope enforcement.

| Parameter | Description |
|---|---|
| `name` | Tool name (used in audit log entries) |
| `description` | Human-readable description shown to the LLM |
| `grant_token` | Grantex grant token (RS256 JWT) |
| `required_scope` | Scope that must be present in the token's `scp` claim |
| `func` | The function to execute when the tool is called |
| `args_schema` | Optional Pydantic `BaseModel` describing tool inputs |

**Raises:**
- `PermissionError` — if the grant token doesn't contain `required_scope`
- `ValueError` — if the grant token can't be decoded
- `ImportError` — if `crewai` is not installed

### `with_audit_logging`

```python
with_audit_logging(
    tool: BaseTool,
    client: Grantex,
    *,
    agent_id: str,
    grant_id: str,
) -> BaseTool
```

Patches the tool's `_run` method to log audit entries via the Grantex client.

| Parameter | Description |
|---|---|
| `tool` | A CrewAI `BaseTool` (from `create_grantex_tool`) |
| `client` | A `grantex.Grantex` client instance |
| `agent_id` | Grantex agent ID to attribute the action to |
| `grant_id` | Grant ID authorizing this tool invocation |

### `get_tool_scopes`

```python
get_tool_scopes(grant_token: str) -> list[str]
```

Returns the scopes embedded in a grant token. Purely offline — no network call, no signature check.

## Requirements

- Python 3.9+
- [grantex](https://pypi.org/project/grantex/) >= 0.1.0
- [crewai](https://pypi.org/project/crewai/) >= 0.28.0 (peer dependency)

## Links

- [Grantex documentation](https://github.com/mishrasanjeev/grantex)
- [Grantex Python SDK](https://pypi.org/project/grantex/)
- [Protocol specification](https://github.com/mishrasanjeev/grantex/blob/main/SPEC.md)
- [CrewAI documentation](https://docs.crewai.com/)

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`grantex`](https://pypi.org/project/grantex/) — Core Python SDK
- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — TypeScript SDK
- [`grantex-openai-agents`](https://pypi.org/project/grantex-openai-agents/) — OpenAI Agents SDK integration
- [`grantex-adk`](https://pypi.org/project/grantex-adk/) — Google ADK integration
- [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) — MCP server for Claude Desktop / Cursor / Windsurf

## License

Apache 2.0

# grantex-adk

[Google Agent Development Kit (ADK)](https://google.github.io/adk-docs/) integration for the [Grantex](https://grantex.dev) delegated authorization protocol — scope-enforced agent tools.

Wrap any function with Grantex grant token verification so your agents can only use tools they've been authorized for.

[![PyPI](https://img.shields.io/pypi/v/grantex-adk)](https://pypi.org/project/grantex-adk/)
[![Python](https://img.shields.io/pypi/pyversions/grantex-adk)](https://pypi.org/project/grantex-adk/)
[![License](https://img.shields.io/pypi/l/grantex-adk)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
pip install grantex-adk
```

You also need the Google ADK installed (it's a peer dependency):

```bash
pip install google-adk
```

## Quick start

```python
from grantex_adk import create_grantex_tool
from google.adk import Agent

# Create a scope-enforced tool from any function
read_calendar = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,       # JWT from Grantex authorization flow
    required_scope="calendar:read",
    func=get_calendar_events,      # your function
)

# Google ADK uses plain functions as tools — just pass them directly
agent = Agent(
    model="gemini-2.0-flash",
    name="assistant",
    tools=[read_calendar],
)
```

If the grant token doesn't include the required scope, `create_grantex_tool` raises a `PermissionError` immediately — the tool is never created.

## API reference

### `create_grantex_tool()`

Creates a plain function with the correct `__name__` and `__doc__` for ADK tool discovery, with offline scope enforcement.

| Parameter | Type | Description |
|---|---|---|
| `name` | `str` | Tool name (becomes `__name__`) |
| `description` | `str` | Tool description (becomes `__doc__`) |
| `grant_token` | `str` | JWT grant token from Grantex |
| `required_scope` | `str` | Scope that must be present in the token |
| `func` | `Callable[..., str]` | The function to wrap |

### `get_tool_scopes()`

Returns the scopes embedded in a grant token (offline, no network call).

### `decode_jwt_payload()`

Decodes the payload of a JWT without verifying the signature. Useful for inspecting token claims.

## Requirements

- Python 3.9+
- `grantex >= 0.1.0`
- `google-adk >= 0.2.0` (peer dependency)

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`grantex`](https://pypi.org/project/grantex/) — Core Python SDK
- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — TypeScript SDK
- [`grantex-crewai`](https://pypi.org/project/grantex-crewai/) — CrewAI integration
- [`grantex-openai-agents`](https://pypi.org/project/grantex-openai-agents/) — OpenAI Agents SDK integration
- [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) — MCP server for Claude Desktop / Cursor / Windsurf

## License

Apache-2.0

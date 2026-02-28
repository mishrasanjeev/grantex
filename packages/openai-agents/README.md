# grantex-openai-agents

[OpenAI Agents SDK](https://github.com/openai/openai-agents-python) integration for the [Grantex](https://grantex.dev) delegated authorization protocol — scope-enforced agent tools.

Wrap any function with Grantex grant token verification so your agents can only use tools they've been authorized for.

[![PyPI](https://img.shields.io/pypi/v/grantex-openai-agents)](https://pypi.org/project/grantex-openai-agents/)
[![Python](https://img.shields.io/pypi/pyversions/grantex-openai-agents)](https://pypi.org/project/grantex-openai-agents/)
[![License](https://img.shields.io/pypi/l/grantex-openai-agents)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
pip install grantex-openai-agents
```

You also need the OpenAI Agents SDK installed (it's a peer dependency):

```bash
pip install openai-agents
```

## Quick start

```python
from grantex_openai_agents import create_grantex_tool

# Create a scope-enforced tool from any function
tool = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,       # JWT from Grantex authorization flow
    required_scope="calendar:read",
    func=get_calendar_events,      # your function
)

# Use with any OpenAI Agents SDK agent
from agents import Agent
agent = Agent(name="assistant", tools=[tool])
```

If the grant token doesn't include the required scope, `create_grantex_tool` raises a `PermissionError` immediately — the tool is never created.

## API reference

### `create_grantex_tool()`

Creates an OpenAI Agents SDK `FunctionTool` with offline scope enforcement.

| Parameter | Type | Description |
|---|---|---|
| `name` | `str` | Tool name |
| `description` | `str` | Tool description |
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
- `openai-agents >= 0.0.3` (peer dependency)

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`grantex`](https://pypi.org/project/grantex/) — Core Python SDK
- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — TypeScript SDK
- [`grantex-crewai`](https://pypi.org/project/grantex-crewai/) — CrewAI integration
- [`grantex-adk`](https://pypi.org/project/grantex-adk/) — Google ADK integration
- [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) — MCP server for Claude Desktop / Cursor / Windsurf

## License

Apache-2.0

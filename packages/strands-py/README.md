# grantex-strands

[Strands Agents SDK](https://strandsagents.com/) integration for the [Grantex](https://grantex.dev) delegated authorization protocol - scope-enforced agent tools.

Wrap Strands tool functions with Grantex grant token scope checks so agents only receive tools they have been authorized to use.

[![PyPI](https://img.shields.io/pypi/v/grantex-strands)](https://pypi.org/project/grantex-strands/)
[![Python](https://img.shields.io/pypi/pyversions/grantex-strands)](https://pypi.org/project/grantex-strands/)
[![License](https://img.shields.io/pypi/l/grantex-strands)](https://github.com/mishrasanjeev/grantex/blob/main/LICENSE)

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

Version 0.2.0 is a breaking release requiring Python 3.11+ and
`grantex` 0.7+. Online tools forward `audience` to `client.enforce()`.
The default verified mode checks signatures and scopes, not current
revocation. This helper has no amount extractor; for capped tools call
`Grantex.enforce(..., amount=...)` directly before execution. Do not use
`caps_mode="warn"` or `"off"` as production spend enforcement. See the
[migration guide](https://docs.grantex.dev/migration-enforcement).

```bash
pip install grantex-strands==0.2.0 grantex==0.7.0
```

You also need the Strands Agents SDK installed:

```bash
pip install strands-agents
```

## Quick Start

```python
from grantex_strands import create_grantex_tool

def get_calendar_events(date: str = "") -> str:
    return f"events for {date}"

read_calendar = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)

# Pass read_calendar into your Strands agent tools list.
```

If the verified grant token does not include the required scope, `create_grantex_tool` raises `PermissionError` immediately and the tool is not created.

## Enforcement Modes

Verified mode is the default. It verifies the grant token against JWKS and checks the verified `scp` claim:

```python
tool = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
)
```

Online mode delegates enforcement to a Grantex client:

```python
tool = create_grantex_tool(
    name="read_calendar",
    description="Read upcoming calendar events",
    grant_token=grant_token,
    required_scope="calendar:read",
    func=get_calendar_events,
    client=grantex_client,
    connector="calendar",
    online=True,
)
```

## API Reference

### `create_grantex_tool()`

Creates a Strands-compatible tool with Grantex scope enforcement.

| Parameter | Type | Description |
|---|---|---|
| `name` | `str` | Tool name |
| `description` | `str` | Tool description |
| `grant_token` | `str` | JWT grant token from Grantex |
| `required_scope` | `str` | Scope that must be present in the token |
| `func` | `Callable[..., str]` | Function to wrap |
| `jwks_uri` | `str` | JWKS URL used to verify the grant token |
| `issuer`, `issuer_did`, `audience` | `str \| None` | Optional JWT claim validation settings |
| `clock_tolerance` | `int` | Clock tolerance in seconds for token verification |
| `client` | `Any` | Grantex client instance for online mode |
| `connector` | `str \| None` | Connector name for online mode |
| `online` | `bool` | Use `client.enforce()` instead of offline JWT scope checking |

### `get_tool_scopes()`

Returns the scopes embedded in a grant token. Invalid tokens return an empty list.

## Requirements

- Python 3.11+
- `grantex >= 0.3.12`
- `strands-agents >= 0.1`

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`grantex`](https://pypi.org/project/grantex/) - Core Python SDK
- [`grantex-crewai`](https://pypi.org/project/grantex-crewai/) - CrewAI integration
- [`grantex-openai-agents`](https://pypi.org/project/grantex-openai-agents/) - OpenAI Agents SDK integration
- [`grantex-adk`](https://pypi.org/project/grantex-adk/) - Google ADK integration

## License

MIT

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
> Unreleased authority hardening requires Python SDK 0.7.1 (`current_authority`),
> not just a valid JWT signature. Bind the audience and trusted human/agent
> identities, and check the issuer before every execution. This does not
> create human consent or automatically consume action decisions/spend caps.
> Existing offline defaults remain offline. The candidate is not yet published.
> See the [SDK execution authority guide](https://docs.grantex.dev/guides/sdk-execution-authority).

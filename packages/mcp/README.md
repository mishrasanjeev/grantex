# @grantex/mcp

MCP server for AI agent authorization. 17 tools for managing agents, scoped tokens, grants, audit trails, and principal sessions — works with Claude Desktop, Cursor, and Windsurf.

> **What is Grantex?** An open authorization protocol for AI agents (OAuth 2.0 for agents). Scoped delegation tokens, real-time revocation, and immutable audit trails. [Learn more](https://grantex.dev)

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev/integrations/mcp)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)** | **[Discord](https://discord.gg/QuSk7AeBdg)**

## Quick Start

```bash
npm install -g @grantex/mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "grantex": {
      "command": "grantex-mcp",
      "env": {
        "GRANTEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "grantex": {
      "command": "grantex-mcp",
      "env": {
        "GRANTEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "grantex": {
      "command": "grantex-mcp",
      "env": {
        "GRANTEX_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GRANTEX_API_KEY` | Yes | Your Grantex API key ([get one free](https://grantex.dev/dashboard/signup)) |
| `GRANTEX_BASE_URL` | No | Override API base URL (default: `https://api.grantex.dev`) |

## Tools (17)

### Agent Management (5)
| Tool | Description |
|---|---|
| `grantex_agent_register` | Register a new AI agent with name, description, and declared scopes |
| `grantex_agent_get` | Get agent details by ID |
| `grantex_agent_list` | List all registered agents |
| `grantex_agent_update` | Update agent name, description, or scopes |
| `grantex_agent_delete` | Delete an agent |

### Authorization Flow (1)
| Tool | Description |
|---|---|
| `grantex_authorize` | Create an authorization request — returns consent URL for user approval |

### Token Operations (4)
| Tool | Description |
|---|---|
| `grantex_token_exchange` | Exchange authorization code for a signed grant token (RS256 JWT) |
| `grantex_token_verify` | Verify a grant token — check scopes, expiry, and revocation status |
| `grantex_token_refresh` | Refresh a grant token using a refresh token |
| `grantex_token_revoke` | Revoke a grant token by JTI |

### Grant Management (4)
| Tool | Description |
|---|---|
| `grantex_grant_get` | Get grant details by ID |
| `grantex_grant_list` | List grants with optional filters (agent, principal, status) |
| `grantex_grant_revoke` | Revoke a grant — cascades to all sub-agent grants |
| `grantex_grant_delegate` | Delegate a grant to a sub-agent with scope narrowing |

### Audit Trail (2)
| Tool | Description |
|---|---|
| `grantex_audit_list` | List audit entries with filters |
| `grantex_audit_get` | Get a specific audit entry by ID |

### Principal Sessions (1)
| Tool | Description |
|---|---|
| `grantex_principal_session_create` | Create a session token for end-user grant management |

## Use Cases

- **Register agents** from Claude Desktop and manage their permissions conversationally
- **Authorize agents** with specific scopes through the consent UI flow
- **Inspect grants** to see what permissions an agent has and when they expire
- **Revoke access** instantly when an agent misbehaves — cascades to all sub-agents
- **Audit** what agents did — every action recorded with hash-chained integrity
- **Delegate** from one agent to another with automatic scope narrowing

## What Makes This Different

Unlike API key or password-based MCP servers, Grantex provides:
- **Scoped permissions** — agents get exactly the access they need, no more
- **Human consent** — users approve what agents can do via a consent UI
- **Real-time revocation** — revoke any agent's access in milliseconds
- **Delegation chains** — agent A can delegate to agent B with narrower scopes
- **Audit trail** — every action logged with cryptographic integrity
- **Offline verification** — any service can verify tokens via JWKS, no network call

## Grantex Ecosystem

| Package | Description |
|---|---|
| [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) | TypeScript SDK |
| [`grantex`](https://pypi.org/project/grantex/) | Python SDK |
| [`grantex-go`](https://pkg.go.dev/github.com/mishrasanjeev/grantex-go) | Go SDK |
| [`@grantex/mcp-auth`](https://www.npmjs.com/package/@grantex/mcp-auth) | OAuth 2.1 + PKCE for any MCP server |
| [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) | LangChain scope-enforced tools |
| [`@grantex/anthropic`](https://www.npmjs.com/package/@grantex/anthropic) | Anthropic SDK integration |
| [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) | Command-line tool |

## License

Apache-2.0

# @grantex/mcp

MCP (Model Context Protocol) server for the [Grantex](https://grantex.dev) delegated agent authorization protocol. Exposes 13 tools for managing agents, grants, tokens, authorization flows, and audit logs.

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Quick Start

```bash
npm install -g @grantex/mcp
```

### Claude Desktop / Cursor / Windsurf

Add to your MCP config:

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
| `GRANTEX_API_KEY` | Yes | Your Grantex API key |
| `GRANTEX_BASE_URL` | No | Override API base URL (default: `https://api.grantex.dev`) |

## Tools

| Tool | Description |
|---|---|
| `grantex_agent_register` | Register a new AI agent |
| `grantex_agent_list` | List all registered agents |
| `grantex_agent_get` | Get details for a specific agent |
| `grantex_authorize` | Start an authorization flow |
| `grantex_token_exchange` | Exchange authorization code for grant token |
| `grantex_token_verify` | Verify a grant token |
| `grantex_token_revoke` | Revoke a grant token |
| `grantex_grant_list` | List grants with filters |
| `grantex_grant_get` | Get grant details |
| `grantex_grant_revoke` | Revoke a grant |
| `grantex_grant_delegate` | Delegate a grant to a sub-agent |
| `grantex_audit_log` | Log an audit entry |
| `grantex_audit_list` | List audit entries |

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — Core TypeScript SDK
- [`grantex`](https://pypi.org/project/grantex/) — Python SDK
- [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) — LangChain integration
- [`@grantex/vercel-ai`](https://www.npmjs.com/package/@grantex/vercel-ai) — Vercel AI SDK integration
- [`@grantex/cli`](https://www.npmjs.com/package/@grantex/cli) — Command-line tool

## License

Apache-2.0

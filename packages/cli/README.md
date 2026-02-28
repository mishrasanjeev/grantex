# @grantex/cli

Command-line tool for the [Grantex](https://grantex.dev) delegated authorization protocol.

Manage agents, grants, audit logs, webhooks, policies, anomalies, and compliance exports from your terminal.

> **[Homepage](https://grantex.dev)** | **[Docs](https://grantex.dev/docs)** | **[Sign Up Free](https://grantex.dev/dashboard/signup)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
npm install -g @grantex/cli
```

## Configure

Point the CLI at your Grantex server and set your API key:

```bash
# Interactive setup
grantex config set --url https://grantex-auth-dd4mtrt2gq-uc.a.run.app --key YOUR_API_KEY

# Or use environment variables
export GRANTEX_URL=https://grantex-auth-dd4mtrt2gq-uc.a.run.app
export GRANTEX_KEY=YOUR_API_KEY
```

Config is saved to `~/.grantex/config.json`. Environment variables override the config file.

```bash
# Verify your setup
grantex config show
```

## Commands

### Agents

```bash
grantex agents list
grantex agents register --name travel-booker --scopes calendar:read,payments:initiate
grantex agents get ag_01ABC...
grantex agents update ag_01ABC... --name new-name --scopes calendar:read,email:send
grantex agents delete ag_01ABC...
```

### Grants

```bash
grantex grants list
grantex grants list --agent ag_01ABC... --status active
grantex grants revoke grnt_01XYZ...
```

### Tokens

```bash
grantex tokens verify <jwt-token>
grantex tokens revoke <jti>
```

### Audit Log

```bash
grantex audit list
grantex audit list --agent ag_01ABC... --action payment.initiated --since 2026-01-01
```

### Webhooks

```bash
grantex webhooks list
grantex webhooks create --url https://example.com/hook --events grant.created,grant.revoked
grantex webhooks delete wh_01XYZ...
```

Supported events: `grant.created`, `grant.revoked`, `token.issued`

### Compliance

```bash
# Summary stats
grantex compliance summary
grantex compliance summary --since 2026-01-01 --until 2026-02-01

# Export grants
grantex compliance export grants --format json --output grants.json

# Export audit log
grantex compliance export audit --format json --output audit.json

# Evidence pack (SOC 2, GDPR, etc.)
grantex compliance evidence-pack --framework soc2 --output evidence.json
```

### Anomaly Detection

```bash
grantex anomalies detect
grantex anomalies list
grantex anomalies list --unacknowledged
grantex anomalies acknowledge anom_01XYZ...
```

## Local Development

For local development with `docker compose`:

```bash
grantex config set --url http://localhost:3001 --key dev-api-key-local
```

## Requirements

- Node.js 18+

## Links

- [Grantex Protocol](https://github.com/mishrasanjeev/grantex)
- [TypeScript SDK](https://www.npmjs.com/package/@grantex/sdk)
- [Self-Hosting Guide](https://github.com/mishrasanjeev/grantex/blob/main/docs/self-hosting.md)
- [Developer Portal](https://grantex.dev/dashboard)

## Grantex Ecosystem

This package is part of the [Grantex](https://grantex.dev) ecosystem. See also:

- [`@grantex/sdk`](https://www.npmjs.com/package/@grantex/sdk) — Core TypeScript SDK
- [`grantex`](https://pypi.org/project/grantex/) — Python SDK
- [`@grantex/langchain`](https://www.npmjs.com/package/@grantex/langchain) — LangChain integration
- [`@grantex/mcp`](https://www.npmjs.com/package/@grantex/mcp) — MCP server for Claude Desktop / Cursor / Windsurf
- [`@grantex/vercel-ai`](https://www.npmjs.com/package/@grantex/vercel-ai) — Vercel AI SDK integration

## License

Apache 2.0

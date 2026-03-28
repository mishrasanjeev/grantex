# @grantex/cli

Command-line tool for the [Grantex](https://grantex.dev) delegated authorization protocol.

83 commands covering the full Grantex API — agents, grants, tokens, policies, budgets, audit, compliance, credentials, and more. All commands support `--json` for machine-readable output.

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev)** | **[CLI Docs](https://docs.grantex.dev/integrations/cli)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

```bash
npm install -g @grantex/cli
```

## Configure

```bash
grantex config set --url https://grantex-auth-dd4mtrt2gq-uc.a.run.app --key YOUR_API_KEY

# Or use environment variables
export GRANTEX_URL=https://grantex-auth-dd4mtrt2gq-uc.a.run.app
export GRANTEX_KEY=YOUR_API_KEY

# Verify your setup
grantex me
```

Config is saved to `~/.grantex/config.json`. Environment variables override the config file.

## JSON Output

All commands support `--json` for machine-readable output — ideal for scripting, `jq`, and AI coding assistants (Claude Code, Cursor, Codex).

```bash
grantex --json agents list | jq '.[0].agentId'
grantex --json tokens verify <jwt> | jq '.valid'
```

Set `NO_COLOR=1` to disable colored output.

## Commands

### Core Flow

```bash
# 1. Register an agent
grantex agents register --name "My Bot" --description "Reads email" --scopes email:read

# 2. Start authorization
grantex authorize --agent ag_... --principal user@example.com --scopes email:read

# 3. Exchange code for token
grantex tokens exchange --code <code> --agent-id ag_...

# 4. Verify the token
grantex tokens verify <jwt>

# 5. Refresh when needed
grantex tokens refresh --refresh-token <token> --agent-id ag_...

# 6. Revoke when done
grantex grants revoke grnt_...
```

### Agents

```bash
grantex agents list
grantex agents register --name bot --description "..." --scopes email:read,calendar:write
grantex agents get ag_...
grantex agents update ag_... --name new-name --scopes email:read
grantex agents delete ag_...
```

### Grants

```bash
grantex grants list [--agent ag_... --status active]
grantex grants get grnt_...
grantex grants revoke grnt_...
grantex grants delegate --grant-token <jwt> --agent-id ag_child... --scopes email:read
```

### Tokens

```bash
grantex tokens exchange --code <code> --agent-id ag_...
grantex tokens verify <jwt>
grantex tokens refresh --refresh-token <token> --agent-id ag_...
grantex tokens revoke <jti>
```

### Authorize

```bash
grantex authorize --agent ag_... --principal user@example.com --scopes email:read
grantex authorize --agent ag_... --principal user@example.com --scopes email:read \
  --code-challenge <S256-challenge> --redirect-uri https://app.com/callback
```

### Audit

```bash
grantex audit list [--agent ag_... --grant grnt_... --action email.read --since 2026-01-01]
grantex audit get alog_...
grantex audit log --agent-id ag_... --agent-did did:grantex:ag_... --grant-id grnt_... \
  --principal-id user@example.com --action email.read --status success
```

### Policies

```bash
grantex policies list
grantex policies get pol_...
grantex policies create --name "Allow Bot" --effect allow --agent-id ag_... --scopes email:read
grantex policies update pol_... --priority 50
grantex policies delete pol_...
```

### Budgets

```bash
grantex budgets allocate --grant-id grnt_... --amount 100 [--currency USD]
grantex budgets debit --grant-id grnt_... --amount 25.50 --description "API call"
grantex budgets balance grnt_...
grantex budgets transactions grnt_...
```

### Usage

```bash
grantex usage current
grantex usage history [--days 7]
```

### Webhooks

```bash
grantex webhooks list
grantex webhooks create --url https://example.com/hook --events grant.created,token.issued
grantex webhooks delete wh_...
```

### Events

```bash
grantex events stream [--types grant.created,token.issued]
grantex --json events stream  # One JSON object per line
```

### Domains

```bash
grantex domains list
grantex domains add --domain auth.mycompany.com
grantex domains verify dom_...
grantex domains delete dom_...
```

### Vault (Credential Storage)

```bash
grantex vault list [--principal user@example.com --service google]
grantex vault get cred_...
grantex vault store --principal-id user@example.com --service google --access-token ya29...
grantex vault delete cred_...
grantex vault exchange --grant-token <jwt> --service google
```

### WebAuthn / FIDO2

```bash
grantex webauthn register-options --principal-id user@example.com
grantex webauthn register-verify --challenge-id ch_... --response '{"id":"..."}' --device-name "MacBook"
grantex webauthn list user@example.com
grantex webauthn delete cred_...
```

### Verifiable Credentials

```bash
grantex credentials list [--grant-id grnt_... --status active]
grantex credentials get vc_...
grantex credentials verify --vc-jwt eyJ...
grantex credentials present --sd-jwt eyJ... --nonce abc123
```

### Agent Passports (MPP)

```bash
grantex passports issue --agent-id ag_... --grant-id grnt_... --categories "compute,storage" --max-amount 100
grantex passports list [--agent-id ag_...]
grantex passports get pp_...
grantex passports revoke pp_...
```

### Principal Sessions

```bash
grantex principal-sessions create --principal-id user@example.com [--expires-in 1h]
```

### Account

```bash
grantex me
```

### Compliance

```bash
grantex compliance summary [--since 2026-01-01 --until 2026-02-01]
grantex compliance export grants --format json --output grants.json
grantex compliance export audit --format json --output audit.json
grantex compliance evidence-pack --framework soc2 --output evidence.json
```

### Anomalies

```bash
grantex anomalies detect
grantex anomalies list [--unacknowledged]
grantex anomalies acknowledge anom_...
```

### Billing

```bash
grantex billing status
grantex billing checkout pro --success-url https://app.com/ok --cancel-url https://app.com/cancel
grantex billing portal --return-url https://app.com/settings
```

### SCIM

```bash
grantex scim tokens list | create --label "Okta" | revoke tok_...
grantex scim users list | get usr_... | create --user-name john@co.com | update usr_... | delete usr_...
```

### SSO

```bash
grantex sso get | configure --issuer-url ... --client-id ... | delete
grantex sso login-url my-org
grantex sso callback --code CODE --state STATE
```

## Local Development

```bash
grantex config set --url http://localhost:3001 --key dev-api-key-local
```

## Requirements

- Node.js 18+

## License

Apache 2.0

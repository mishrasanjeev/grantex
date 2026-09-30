# @grantex/cli

Command-line tool for the [Grantex](https://grantex.dev) delegated authorization protocol.

80+ commands covering the full Grantex API — agents, grants, tokens, policies, budgets, audit, compliance, credentials, and more. All commands support `--json` for machine-readable output. Portable Agent Skills let Hermes, OpenClaw, and other shell-capable agents use the same interface.

> **[Homepage](https://grantex.dev)** | **[Docs](https://docs.grantex.dev)** | **[CLI Docs](https://docs.grantex.dev/integrations/cli)** | **[GitHub](https://github.com/mishrasanjeev/grantex)**

## Install

Version 0.4.1 requires registry-verified TypeScript SDK 0.8.1+.
Operator API keys and submitted principal IDs are administrative
inputs, not proof of a signed-in human. See
[execution authority boundaries](https://docs.grantex.dev/guides/sdk-execution-authority).

Version 0.4.0 is a breaking release requiring Node.js 22.12+ and
`@grantex/sdk` 0.8+. The `enforce` command checks the requested audience and
current revocation by default. Run `grantex enforce test --help` for audience
and amount options; the client uses the SDK's online revocation default. Follow the
[migration guide](https://docs.grantex.dev/migration-enforcement).

```bash
npm install -g @grantex/cli@0.4.1
```

## Configure

```bash
grantex config set --url https://api.grantex.dev --key YOUR_API_KEY

# Or use environment variables
export GRANTEX_URL=https://api.grantex.dev
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

## Agent CLI Integration

Install the bundled `use-grantex-cli` and `integrate-grantex` skills with one command:

```bash
# OpenClaw workspace: ./skills
grantex agent install --target openclaw

# Hermes: ~/.hermes/skills/grantex
grantex agent install --target hermes

# Portable project location: ./.agents/skills
grantex agent install --target portable

# Any other agent skill root
grantex agent install --dir /path/to/skills
```

Use `--force` to refresh existing bundled files. A Hermes- or OpenClaw-specific SDK is not required; application code should continue to use the TypeScript, Python, or Go SDK at the protected service boundary.

### Secret-safe token input

Avoid placing grant tokens in shell history or process arguments:

```bash
grantex verify --env GRANTEX_GRANT_TOKEN --json
grantex --json tokens verify --env GRANTEX_GRANT_TOKEN
grantex --json enforce test --token-env GRANTEX_GRANT_TOKEN \
  --connector salesforce --tool create_lead
```

The verification commands also accept `--file` and `--stdin`; `enforce test` accepts `--token-file` and `--token-stdin`. Invalid or denied checks return a non-zero process status in JSON mode.

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

### Evidence packages

```bash
# Verify against a root obtained independently (for example from the audit log).
# Exits 1 and prints the failing entry, field, expected and actual hash on any break.
grantex evidence verify package.json --root sha256:<64 hex> [--anchor <audit hash>] [--jwks jwks.json]

# Export a case from the auth service; the package is verified before it is saved.
grantex evidence export case_... --out package.json [--disclose approver] [--sign]
```

See spec/evidence-package.md.

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

### Rich Token Inspection

```bash
grantex verify <jwt> [--verbose --check-revocation]
grantex verify --file token.txt [--jwks https://api.grantex.dev/.well-known/jwks.json]
grantex decode <jwt>
grantex decode --file token.txt --json
```

`decode` does not verify the signature. Use `verify` before trusting claims.

### Offline Audit Logs

```bash
grantex audit-log inspect audit.jsonl
grantex audit-log verify audit.jsonl
```

### Trust Registry

```bash
grantex registry lookup did:web:agent.example.com
grantex registry verify-dns did:web:agent.example.com
```

### DPDP Act (India)

```bash
# Consent notices (s.5). The version option is --notice-version: --version
# anywhere on the command line prints the CLI version.
grantex dpdp notices create --notice-id privacy-notice --notice-version 2.0 \
  --title "Data Processing Consent Notice" --content "We process your data for..." \
  --purposes '[{"code":"analytics","description":"Usage analytics"}]' \
  --grievance-officer '{"name":"Grievance Officer","email":"grievance@example.com"}'
grantex dpdp notices list [--limit 50] [--cursor <nextCursor>]
grantex dpdp notices get privacy-notice

# Consent records
grantex dpdp consent create --grant-id grnt_... --principal-id user_123 \
  --notice-id privacy-notice [--notice-version 2.0] \
  --processing-expires-at 2027-09-30T00:00:00Z \
  --purposes '[{"code":"analytics","description":"Usage analytics"}]'
grantex dpdp consent list [--principal user_123] [--limit 50] [--cursor <nextCursor>]
grantex dpdp consent get crec_...
grantex dpdp consent withdraw crec_... --reason "Consent withdrawn" \
  [--revoke-grant | --no-revoke-grant] [--delete-processed-data]

# Right to access (s.11) and erasure (s.12)
grantex dpdp principal-records user_123 [--limit 50] [--cursor <nextCursor>]
grantex dpdp erasure user_123                 # or: grantex dpdp erasure request user_123
grantex dpdp erasure status ER-...

# Grievances (s.13)
grantex dpdp grievances file --principal-id user_123 --type unauthorized-processing \
  --description "..." [--record-id crec_...] [--evidence '{"note":"..."}'] [--response-period-days 7]
grantex dpdp grievances list [--status submitted|in_review|resolved|rejected] [--principal user_123]
grantex dpdp grievances get grv_...
grantex dpdp grievances update grv_... --status resolved --resolution "Processing stopped"

# Exports (JSON only; a bare YYYY-MM-DD means 00:00Z of that day)
grantex dpdp exports create --type dpdp-audit --date-from 2026-09-01 \
  --date-to 2026-09-30T23:59:59.999Z [--no-include-action-log] [--no-include-consent-records]
grantex dpdp exports get exp_...
```

List commands print `Next cursor:` when there is another page (with `--json`, the page
information is written to stderr and the records array to stdout). Without `--limit` or `--cursor`,
`consent list` returns the newest 100 records (every match with `--principal`) and
`principal-records` every record of the principal, unpaginated. Errors print the
server's message with its `code` and `requestId`. Erasure prints what was erased and what
was retained, with the reason for each retained category. An erasure principal ID of
literally `status` or `request` needs the explicit `grantex dpdp erasure request <id>` form.

### Tool Manifests and Scope Enforcement

```bash
grantex manifest list [--category finance]
grantex manifest show salesforce
grantex manifest validate --agent-tools list_contacts,create_contact --connector hubspot
grantex manifest load ./manifest.json
grantex manifest generate ./src
grantex enforce test --token <jwt> --connector salesforce --tool delete_contact
```

### Project Scaffolding

```bash
grantex init gemma [--dir ./grantex-gemma-starter]
```

### Agent Skills

```bash
grantex agent install [--target openclaw|hermes|portable] [--dir <skill-root>] [--force]
```

## Local Development

```bash
grantex config set --url http://localhost:3001 --key dev-api-key-local
```

## Requirements

- Node.js 18+

## License

Apache 2.0

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).

## Source Development

Use Node.js 24 LTS and `npm ci` to build or test this checkout with Vitest 5.
Repository validation steps are in [the dependency upgrade guide](https://docs.grantex.dev/guides/dependency-updates).
Source-tooling requirements are separate from published package runtime support.

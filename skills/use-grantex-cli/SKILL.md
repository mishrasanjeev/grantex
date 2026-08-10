---
name: use-grantex-cli
description: Operate Grantex delegated authorization through its machine-readable CLI. Use when Hermes, OpenClaw, an Agent Skills-compatible assistant, or another shell-capable agent needs to configure Grantex, register an agent, request scoped human consent, exchange or verify grant tokens, inspect grants and audit records, delegate narrower authority, or revoke access without writing framework-specific code.
---

# Use Grantex CLI

Use `grantex` as a control-plane tool. Prefer JSON output, keep credentials out of command arguments, and leave authorization enforcement at the protected service boundary.

## Bootstrap

1. Check whether `grantex` is available on `PATH`.
2. If it is missing and the user approves installation, run `npm install -g @grantex/cli`.
3. Configure with environment variables when running unattended. Use the syntax for the current shell:

   ```bash
   # Bash, zsh, or sh
   export GRANTEX_URL=https://api.grantex.dev
   export GRANTEX_KEY=YOUR_API_KEY
   ```

   ```powershell
   # PowerShell
   $env:GRANTEX_URL = "https://api.grantex.dev"
   $env:GRANTEX_KEY = "YOUR_API_KEY"
   ```

   Alternatively, use `grantex config set --url <url> --key <key>` for a user-managed local profile.

4. Confirm the identity with `grantex --json me`. Stop if configuration or authentication fails.

## Machine contract

- Put the global flag before the command: `grantex --json agents list`.
- Parse stdout as JSON and treat stderr as diagnostics.
- Check the process exit status before trusting output.
- Use `NO_COLOR=1` if text output must be captured.
- Prefer `--env`, `--file`, or `--stdin` for grant tokens. Do not expose grant tokens, refresh tokens, or API keys in logs, prompts, shell history, or process arguments.

## Authorization workflow

1. Register only the scopes the agent can justify:

   ```text
   grantex --json agents register --name "calendar-assistant" --description "Reads approved calendar events" --scopes calendar:read
   ```

2. Request the smallest useful grant:

   ```text
   grantex --json authorize --agent ag_... --principal user@example.com --scopes calendar:read
   ```

3. Present the returned consent URL to the human. Never approve consent on the principal's behalf. In live mode, wait for the registered callback to receive the authorization code.
4. Exchange an approved code:

   ```bash
   grantex --json tokens exchange --code <code> --agent-id ag_...
   ```

5. Store returned tokens only in the caller's approved secret store. Do not print them back to the user unless explicitly requested.
6. Verify without placing the token in argv:

   ```bash
   grantex verify --env GRANTEX_GRANT_TOKEN --json
   grantex --json tokens verify --env GRANTEX_GRANT_TOKEN
   ```

   The first command performs signature and claim verification. The second performs the configured online check. Local verification alone does not prove current revocation.

## Tool preflight

Use the CLI to inspect a manifest decision while developing or diagnosing:

```text
grantex --json enforce test --token-env GRANTEX_GRANT_TOKEN --connector salesforce --tool create_lead
```

Treat this as a preflight only. An agent can bypass its own client-side command. Enforce the token again inside the service that owns the side effect.

## Delegation and revocation

- Delegate only a strict subset of the parent scopes and never extend the parent expiry.
- Prefer a file or environment input whenever the installed command offers one. Avoid placing secrets in argv.
- Revoke a grant when the task ends or authority is withdrawn: `grantex --json grants revoke grnt_...`.
- Confirm important changes with a read command such as `grantex --json grants get grnt_...` and inspect the audit trail.

## Safety rules

- Fail closed when required identity, scope, audience, expiry, signature, or current-state checks are unavailable.
- Never broaden scopes to make a denied action pass. Ask for a new human-approved grant.
- Never treat `decode` as verification.
- Never describe a CLI preflight or local JWT decode as service-side enforcement.
- Record security-relevant success and denial events without logging secrets.

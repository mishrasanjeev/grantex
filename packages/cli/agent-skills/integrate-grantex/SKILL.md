---
name: integrate-grantex
description: Add Grantex delegated authorization to an agent, CLI tool, API, MCP server, or framework integration. Use when implementing or reviewing agent identity, scoped grants, consent, JWT verification, tool manifests, service-boundary enforcement, audit logging, delegation, or revocation, and when choosing among the Grantex CLI, TypeScript SDK, Python SDK, Go SDK, middleware, gateway, or framework adapters.
---

# Integrate Grantex

Implement authorization at the component that owns the side effect. Use the CLI for setup and diagnostics; use an SDK, middleware, direct verifier, or gateway at the protected runtime.

## Select the integration surface

Inspect the project before adding dependencies. Reuse an installed Grantex package when it already fits.

| Boundary | Preferred surface |
|---|---|
| Shell automation or agent control plane | `@grantex/cli` with `--json` |
| TypeScript service | `@grantex/sdk` or framework middleware |
| Python service | `grantex` or FastAPI integration |
| Go service | `github.com/mishrasanjeev/grantex-go` |
| Reverse proxy without application changes | `@grantex/gateway` |
| Framework tool wrapper | The matching Grantex adapter plus its primary SDK |
| MCP tool execution | MCP transport authorization plus primary-SDK or direct JWKS-backed Grantex enforcement inside each protected tool |

Do not add a Hermes- or OpenClaw-specific SDK. Shell-capable agents use the shared CLI and portable `SKILL.md`; application code uses the existing language SDKs.

## Implement the boundary

1. Inventory every protected action and map it to an explicit scope. Keep read, write, delete, admin, and capped-value operations distinct.
2. Register a stable agent identity and request only the required scopes, audience, and duration.
3. Preserve human control. Send the principal to the consent URL and exchange only a code returned through the approved flow.
4. At the service boundary, validate:
   - signature against the trusted issuer JWKS;
   - issuer and expected audience;
   - expiry and not-before claims;
   - agent and principal identity;
   - every required scope and constraint;
   - delegation invariants; and
   - current revocation state when the risk model requires it.
5. Reject before executing the side effect. Unknown tools and missing manifests must fail closed.
6. Audit both allowed and denied decisions with the agent, grant, principal, action, outcome, and non-secret metadata.
7. Add revocation and, where needed, narrowly scoped sub-agent delegation.

## Verify the implementation

- Test a valid grant with exactly the required scope.
- Test a valid token missing the required scope.
- Test malformed, expired, wrong-issuer, wrong-audience, and invalid-signature tokens.
- Test an unknown tool or connector.
- Test revocation through the chosen online or synchronized-state path.
- Test that denial occurs before the protected function is invoked.
- Confirm logs never contain API keys, authorization codes, grant tokens, refresh tokens, or upstream credentials.

## CLI handoff

For an agent-operated setup, install the companion skill bundle first:

```bash
grantex agent install --target portable
```

Then use `grantex --json ...` for registration, authorization, grants, verification, audit, and revocation. Prefer token input from an environment variable, file, or stdin.

## Security boundaries

- Treat client-side CLI checks as diagnostics, not a security boundary.
- Treat local JWT verification as signature-and-claims validation, not proof of current revocation.
- Keep upstream credentials behind the protected service; do not give them directly to the agent.
- Never silently request broader authority after a denial.
- Treat `@grantex/mcp-auth@2.0.2` as evaluation-only unless its documented release limitations have been resolved in the selected version. For production MCP enforcement, prefer a primary SDK or direct verification at the tool boundary.

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in), [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).

# @grantex/mcp-auth

OAuth authorization and human-confirmed delegation for MCP resources.

**Version 4.0.0 is a breaking security upgrade.** Node.js 22.12+ and
`@grantex/sdk` 0.8+ are required. Check
[release status](https://docs.grantex.dev/release-status) for registry publication.

```bash
npm install @grantex/mcp-auth@4.0.0 @grantex/sdk@0.8.0 pg
```

## What a human confirms

The authorization page shows the requesting client, redirect destination,
resource, purpose, tools, declared limits and duration, with Allow and Deny.
It does not call Grantex before approval. Approval is single-use and bound to
the browser, CSRF token and authenticated host principal. The same principal
must still be authenticated at approval and the upstream callback.

Live Grantex consent additionally requires the principal's passkey. The MCP
page is not a substitute for that assertion and never auto-enrolls a passkey.
See [passkey enrollment](https://docs.grantex.dev/features/fido-webauthn).

Delegation consent permits actions within the grant; it is not blanket
approval for every sensitive business decision. Mark sensitive tools
`requires_decision` and configure `grantexDecisionVerifier` to consume the
human's action-bound decision before execution. Four-eyes rules require the
configured independent approvers. Without a verifier, decision-required
tools fail closed.

## Authenticated human handoff

Your host application owns login and session verification. Supply
`resolvePrincipal(request)` from that verified session, returning a stable,
tenant-scoped external principal ID. Never trust `principalId` in request
parameters, unsigned cookies, client metadata or the OAuth client ID.

```typescript
import { Grantex } from '@grantex/sdk';
import { createMcpAuthServer } from '@grantex/mcp-auth';
import type { PrincipalResolver, McpAuthStorage } from '@grantex/mcp-auth';

export async function startAuthorizationServer(options: {
  storage: McpAuthStorage;
  resolvePrincipal: PrincipalResolver; // Your verified host-session resolver.
}) {
  return createMcpAuthServer({
    grantex: new Grantex({ apiKey: process.env['GRANTEX_API_KEY']! }),
    agentId: process.env['GRANTEX_AGENT_ID']!,
    issuer: 'https://auth.example.com',
    resource: 'https://mcp.example.com/mcp',
    storage: options.storage,
    resolvePrincipal: options.resolvePrincipal,
    scopes: ['tool:payments:read', 'tool:payments:write'],
    grant: { purpose: 'x-acme.payment-review', duration: '30m' },
  });
}
```

Without a host session, `/authorize` returns `401 login_required`. Authenticate
the human first and resume the validated authorization request. The package
does not invent a login provider or redirect to untrusted return URLs.
Configure secure, HTTP-only session cookies with same-site settings appropriate
for the cross-origin Grantex callback. Resolver failures return 503; logout or
a changed principal returns 403 at approval/callback and requires a new request.

Grantex's returned internal principal ID is recorded separately from the
host's external ID. Token exchange and refresh preserve the internal subject,
so swapping an upstream code cannot change the human.

## Durable state

Use `PostgresStorage` with `runMigrations` from `@grantex/mcp-auth/postgres`,
or `RedisStorage` from `@grantex/mcp-auth/redis`. Install the driver separately.
All replicas share clients, consent, pending requests, codes, refresh bindings
and local revocation. Atomic single-use consumption and principal bindings
survive restarts. `InMemoryStorage` from `@grantex/mcp-auth/testing` is
evaluation-only.

## Enforce before executing tools

Use `createMcpResourceGuard` or Express/Hono middleware on the actual execution
route, not just `tools/list`:

```typescript
import { createMcpResourceGuard, grantexCurrentGrantVerifier,
  toolPolicyFromManifests } from '@grantex/mcp-auth';
import type { Grantex } from '@grantex/sdk';
import type { DecisionVerifier, LoadedManifest, RevocationChecker }
  from '@grantex/mcp-auth';

export function guardTools(options: {
  grantex: Grantex;
  revocations: RevocationChecker;
  decisions: DecisionVerifier;
  manifest: LoadedManifest;
}) {
  return createMcpResourceGuard({
    issuer: 'https://grantex.dev',
    audience: 'https://mcp.example.com/mcp',
    revocations: options.revocations,
    currentGrant: grantexCurrentGrantVerifier(options.grantex),
    tools: toolPolicyFromManifests([options.manifest]),
    decisions: options.decisions,
  });
}
```

Signature, issuer, audience, expiry and scopes are checked locally. Local
revocation and online Grantex authority are both checked before execution.
Issuer-side verification runs on every protected request without a positive
cache: inactive authority returns 401; an issuer outage returns 503. This
does not undo completed actions or cancel a handler already in flight.

Declared caps are not automatic accounting. Apply SDK `enforce` and relevant
service-side atomic spend/call reservations before side effects. Enforce
purpose, wallet policy and trusted action constraints at that boundary.
MCP consent cannot promise data residency: this authorization endpoint does not
bind a data region, and `grant.dataRegion` is rejected.

## Migrate from 3.x or 2.x

- Supply `resolvePrincipal`. Version 3 used the OAuth client ID as the principal;
  version 2.0.2 also lacked a rendered local consent page.
- Supply `currentGrant` as well as `revocations` to resource middleware.
- Drain pending requests, deploy all replicas together and reauthorize old
  identity-unbound grants. Do not mix v3/v4 processes in one state namespace.
  Secure v4 refuses pre-existing refresh bindings without a principal subject.
- Existing v3 SQL migrations remain valid: bindings live in JSON records.
  Retain registered clients; do not erase shared state.
- Evaluation-only opt-outs are `allowLegacyClientPrincipal: true`,
  `currentGrant: 'none'` and `revocations: 'none'`. They warn and weaken
  enforcement. Sandbox auto-approval separately requires
  `sandboxAutoApprove: true`; live passkey consent is not bypassed.

Read the [deployment guide](https://docs.grantex.dev/mcp-auth),
[enforcement migration](https://docs.grantex.dev/migration-enforcement) and
[historical v2 guide](https://docs.grantex.dev/legacy/mcp-auth-server-2).

## Validation and operational boundaries

The permanent suite covers approval/denial, identity changes, CSRF, replay,
concurrency, PKCE, callback/token subject binding, refresh rotation, issuer
revocation/outages, Postgres/Redis restarts and Chromium accessibility.
Run `npm run typecheck`, `npm test`, `npm run test:integration` and
`npm run test:e2e`. Integration needs database/Redis URLs; browser tests need
Playwright Chromium.

`hooks.onTokenIssued` runs after successful exchange/refresh. Treat its token
as secret; do not log it. Observability hook errors warn without changing
delivery. It is not an authorization policy hook. Rate limits remain per-process;
configure gateway-wide protection, TLS, secure sessions and monitoring.
Independent certification of all MCP clients or physical authenticators is not
claimed; validate your actual hosts and clients before production traffic.

Apache-2.0. Copyright 2026 Orchestrum Technologies LLP.

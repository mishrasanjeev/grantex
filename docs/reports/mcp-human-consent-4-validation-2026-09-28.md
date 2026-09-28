# MCP Auth 4.0.0 Human Consent Validation

## Scope and findings

Version 2.0.2 lacked a rendered local consent page. Version 3.0.0 added one,
but its upstream authorization used the OAuth client ID as the human principal.
That conflated different humans using one client. Its local revocation checker
also did not automatically consult current issuer-side grant authority.

Version 4.0.0 deliberately changes those defaults. The host must supply an
authenticated, tenant-scoped principal resolver; approval and callback recheck
the same human. Exchange/refresh preserve Grantex's returned internal principal
subject. Resource guards require an explicit current-authority verifier as well
as local revocation. The package provides an online Grantex verifier.

The package README now describes the current contract rather than embedding
the historical v2 walkthrough. The historical guide remains clearly archived.

## Validation results

| Environment / check | Result |
|---|---|
| Windows typecheck and build | Pass |
| Windows unit/conformance suite | 391 passed; 2 memory-only persistence cases skipped |
| Local Docker Linux typecheck and build | Pass |
| Local Docker unit/conformance suite | 391 passed; same 2 memory-only skips |
| Local Docker Postgres/Redis integration, including process restart | 63 passed |
| Local Docker Chromium consent, layout and accessibility | 9 passed |
| Clean packed artifact with published TypeScript SDK 0.8.0 | Pass |
| Real SDK HTTP handoff, consent, callback, exchange, refresh, active/inactive authority and outage | Pass |
| npm production-dependency audit | Zero reported vulnerabilities |
| Release workflow actionlint | Pass |
| Documentation integrity | Pass |
| SEO release-profile regression suite | 4 passed |

The Docker recipe is `packages/mcp-auth/Dockerfile.validation`; it uses a
digest-pinned Playwright image. Real database/Redis services are required through
`MCP_AUTH_INTEGRATION_DATABASE_URL` and `MCP_AUTH_INTEGRATION_REDIS_URL`.
`CI=true` refuses missing service configuration rather than skipping integration.

One Windows run crashed a native test worker. Rerunning with the threads pool
and four workers passed; the independent Linux Docker run also passed. The
initial Docker recipe omitted the issued-token fixture; that packaging mistake
was corrected before the successful complete run. Neither failure was ignored.

## Permanent security coverage

- Startup without a principal resolver; explicit evaluation opt-out warnings.
- Malformed or absent host identity; untrusted query identities; resolver outage.
- Approval after logout, account or tenant change; same client with two humans.
- Callback browser binding and principal recheck; token substitution or missing subject.
- Refresh subject continuity and legacy identity-unbound refresh/code refusal.
- Consent replay, concurrency, CSRF, expiry and storage restart/replica handling.
- Purpose/duration changes after rendering and hidden lifetime overrides.
- Signed-token current authority: active, revoked, issuer outage and signature-before-online-check.
- Missing action-bound human decisions, wrong action, consumed/expired decisions and independent approver rules.
- Token-issued observability hooks on exchange/refresh and safe hook-failure warnings.

## Rollout boundaries

This is a breaking upgrade, not a retroactive change to immutable v2/v3 packages.
Drain pending flows, upgrade all replicas together and reauthorize legacy
identity-unbound records. Do not mix v3/v4 against one shared namespace. Existing
client registrations and SQL migrations can remain; added binding fields are JSON.

Host login/session verification, live passkey enrollment, atomic spend/call
accounting, business policy and TLS remain explicit deployment responsibilities.
Declared caps are not automatically enforced by rendering them. Revocation stops
subsequent execution, not an already-running side effect. The online issuer
verifier has no positive cache and fails closed during issuer outages.

`allowLegacyClientPrincipal: true`, `currentGrant: 'none'` and
`revocations: 'none'` are warned evaluation opt-outs. They are not production
recommendations. No independent cross-vendor or physical-passkey certification
is claimed. Registry publication and public deployment are recorded separately
after the release succeeds; local validation alone does not prove those steps.

# Cross-Language Authority Release Receipt

Date: 2026-09-29. Main release pull request: [#1492](https://github.com/mishrasanjeev/grantex/pull/1492).

## Registry Publications

| Ecosystem | Artifact | Version |
| --- | --- | --- |
| npm | @grantex/anthropic | 0.1.2 |
| npm | @grantex/autogen | 0.1.7 |
| npm | @grantex/vercel-ai | 0.1.7 |
| npm | @grantex/langchain | 0.1.8 |
| npm | @grantex/strands | 0.2.1 |
| npm | @grantex/express | 0.1.6 |
| npm | @grantex/a2a | 0.1.4 |
| npm | @grantex/adapters | 0.2.1 |
| npm | @grantex/gateway | 0.2.1 |
| npm | @grantex/cli | 0.4.1 |
| PyPI | grantex | 0.7.1 |
| PyPI | grantex-crewai | 0.1.8 |
| PyPI | grantex-openai-agents | 0.1.7 |
| PyPI | grantex-adk | 0.1.7 |
| PyPI | grantex-strands | 0.2.1 |
| PyPI | grantex-fastapi | 0.1.6 |
| PyPI | grantex-a2a | 0.1.5 |
| Go | github.com/mishrasanjeev/grantex-go | v0.4.2 |

The earlier TypeScript SDK 0.8.1 and MCP Auth 4.0.0 publications are recorded
in [their separate receipt](npm-release-verification-2026-09-29.md).
They were not republished. x402 had no source release in this batch.

All ten npm archives have matching registry SHA-1 and SHA-512 values and
the expected latest dist-tag. All seven Python wheels and seven source
distributions have matching registry SHA-256 values. See the exact hashes
in [machine-readable evidence](cross-language-authority-release-2026-09-29.json).

Go v0.4.2 resolves through the public proxy and checksum database to release
commit `47faaff7ca40e9c6a1597cb8bcca8ca0105b14df`. Its module sum is
`h1:MK8lxLxv1lWy6dHfhDnfZibVEHcW859JjXJIqJ6y3xk=`.
The standalone Go release push succeeded, but GitHub reported that the
authenticated push bypassed its pull-request-required rule. No rule was
changed and no force push was used. The main Grantex deployment remains
gated on the release PR checks.

## Workstation Docker Verification

| Validation | Result |
| --- | --- |
| Ten npm integration/CLI package suites | 1,029 passed; no failures/skips; typechecks and builds passed |
| Clean public npm installation | 101 signed-token/JWKS/HTTP execution-boundary checks passed; CLI reported 0.4.1 |
| Clean public PyPI installation, Python 3.12 | 1,708 passed; no failures/skips; real Postgres/Redis |
| Installed Python authority boundaries | 54 checks passed |
| Python 3.9 compatibility | 1,671 passed; 20 skips; strict typing passed; Strands requires 3.11 and was excluded |
| Earlier local-wheel run | 1,690 passed; 18 backend-dependent skips; superseded by zero-skip public-index validation |
| Public-proxy Go module | Race-enabled tests and vet passed |
| Go SDK and Terraform source suites | 229 SDK and 9 provider tests passed; vet passed |
| Auth-service suite | 3,426 passed; no failures/skips; typecheck passed |
| Real Chromium with auth service/Postgres | 19 passed: hosted passkeys, live/sandbox consent, decisions, replay, four eyes, Python consumption and playground |
| Mock issuer timestamp regression | 9 server tests passed; typecheck passed |
| Supply-chain audit | 40 lockfiles, 4,525 package entries; npm audits and Dependabot coverage passed |

Initial PyPI index propagation delayed pinned installs. Verification waited
for the normal public index; it did not substitute local wheels or alternate
artifact URLs for the final clean-index run.

Authority checks cover active/revoked grants, issuer outage, malformed state,
and principal/agent/tenant substitutions. Node checks also cover token,
issuer and audience substitution and the configured YAML gateway path.
Human approval and authority are separate: framework test doubles do not
constitute third-party agent-vendor certification.

## Scope and Limits

These patches add optional per-invocation current-authority verification and
trusted identity binding. They do not turn signature-only defaults into
current-state guarantees or provision authenticated human sessions. Configure
callbacks at every execution boundary; deny on unavailable issuer state.
MCP Auth 4 requires the host's authenticated human-principal resolver and
durable storage. Manifest, decision and caps enforcement remain distinct
from a scope-only wrapper.

Go's tagged README contains a stale "Unreleased source" footer despite the
v0.4.2 release paragraph. Current monorepo documentation corrects the footer;
the immutable tag was not rewritten. This does not change the tested module.

Publication and production deployment are separate events. At the time this
receipt was written, PR #1492 had not merged; this receipt alone is not
evidence of production deployment or post-deployment E2E success.

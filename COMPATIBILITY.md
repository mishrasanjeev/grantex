# Grantex Compatibility Matrix

Last updated: 2026-08-31
Public release snapshot verified: 2026-08-31

This repository uses package-specific versions; there is no monorepo-wide SDK or package release number. The protocol specification remains v1.0 Final, while repository metadata and package registries can move independently during a release.

## Canonical Release Signals

| Surface | Current value | Notes |
| --- | --- | --- |
| Repository changelog | v0.3.12 | Latest top-level release entry in `CHANGELOG.md`. |
| TypeScript SDK | @grantex/sdk 0.5.0 release candidate | Layered wallet policy, exact approvals, reload governance, and principal/developer control clients; current published release is 0.4.1. |
| Python SDK | grantex 0.4.0 release candidate | Developer, principal, and ES256 DPoP agent wallet clients; current published release is 0.3.14. |
| Go SDK | github.com/mishrasanjeev/grantex-go v0.2.0 release candidate | Corrected Agent/Audit contracts plus complete wallet-governance clients; current published release is v0.1.10 and Go 1.26.1 is required. |
| x402 | @grantex/x402 0.3.0 release candidate | Official x402 v2, semantic policy context, structured exact-approval challenge, and approved retry; current published release is 0.2.0. |
| OpenAPI | 0.5.0 | Repository API contract including layered prepaid-wallet governance; independent of the deployed/public snapshot. |
| MCP Auth | @grantex/mcp-auth 2.0.2 | Independently versioned and published to npm; single-process evaluation limitations apply. |
| Published snapshot | [release-status.json](release-status.json) | Machine-readable source for advertised versions and live registry checks. |

## Package Versions

The repository contains 29 packages under `packages/`. Each row maps a directory to its artifact name and repository version. A `published` status means the exact version has been verified on its public registry; other rows describe the package's role without claiming registry publication.

| # | Directory | Published name | Version | Status |
| ---: | --- | --- | ---: | --- |
| 1 | `packages/sdk-ts` | @grantex/sdk | 0.5.0 | Primary SDK (TypeScript); wallet-governance release candidate |
| 2 | `packages/sdk-py` | grantex | 0.4.0 | Primary SDK (Python); wallet-governance release candidate |
| 3 | `packages/go-sdk` | github.com/mishrasanjeev/grantex-go | v0.2.0 (Go 1.26.1) | Primary SDK (Go); wallet-governance release candidate |
| 4 | `packages/cli` | @grantex/cli | 0.3.0 | Tooling; published with bundled Agent Skills |
| 5 | `packages/mcp-auth` | @grantex/mcp-auth | 2.0.2 | Independently versioned |
| 6 | `packages/mcp` | @grantex/mcp | 0.1.10 | Adapter |
| 7 | `packages/langchain` | @grantex/langchain | 0.1.7 | Adapter |
| 8 | `packages/autogen` | @grantex/autogen | 0.1.6 | Adapter |
| 9 | `packages/vercel-ai` | @grantex/vercel-ai | 0.1.6 | Adapter |
| 10 | `packages/anthropic` | @grantex/anthropic | 0.1.1 | Adapter |
| 11 | `packages/crewai` | grantex-crewai | 0.1.7 | Adapter |
| 12 | `packages/openai-agents` | grantex-openai-agents | 0.1.6 | Adapter |
| 13 | `packages/google-adk` | grantex-adk | 0.1.6 | Adapter |
| 14 | `packages/strands-py` | grantex-strands | 0.1.1 | Adapter |
| 15 | `packages/strands` | @grantex/strands | 0.1.1 | Adapter |
| 16 | `packages/express` | @grantex/express | 0.1.5 | Middleware |
| 17 | `packages/fastapi` | grantex-fastapi | 0.1.5 | Middleware |
| 18 | `packages/gateway` | @grantex/gateway | 0.1.5 | Gateway |
| 19 | `packages/conformance` | @grantex/conformance | 0.1.8 | Test suite |
| 20 | `packages/adapters` | @grantex/adapters | 0.1.5 | Service adapters |
| 21 | `packages/destinations` | @grantex/destinations | 0.1.2 | Event destinations |
| 22 | `packages/dpdp` | @grantex/dpdp | 0.1.1 | Compliance controls |
| 23 | `packages/gemma` | @grantex/gemma | 0.1.1 | Offline authorization (TS) |
| 24 | `packages/gemma-py` | grantex-gemma | 0.1.1 | Offline authorization (Python) |
| 25 | `packages/a2a` | @grantex/a2a | 0.1.3 | A2A bridge (TS) |
| 26 | `packages/a2a-py` | grantex-a2a | 0.1.4 | A2A bridge (Python) |
| 27 | `packages/mpp` | @grantex/mpp | 0.1.2 | MPP support |
| 28 | `packages/x402` | @grantex/x402 | 0.3.0 | Official x402 v2 layered-wallet integration |
| 29 | `packages/terraform-provider-grantex` | terraform-provider-grantex | Go module (Go 1.25.0) | Terraform provider |

## Known Published-Package Limitations

- **MCP Auth `2.0.2`:** client registrations default to process memory and
  authorization codes always use a non-configurable process-local store.
  `consentUi` is metadata only, `onTokenIssued` is not invoked, local
  introspection/middleware do not check revocation, and the Grantex authorization
  code is not persisted for token exchange. Treat this release as single-process
  evaluation software until a corrected package is published.

## Release boundaries

| Surface | Repository `main` status | Publication or deployment status |
| --- | --- | --- |
| Wallet governance | Layered policy, exact approvals, reload limits, safe assignment defaults, and durable decisions are implemented across the auth service and primary SDKs. | External custody, issuer controls, and merchant result recovery remain separately operated dependencies. |
| Standard-auth throughput | Auth service source enforces Redis-backed Free/Pro/Enterprise budgets of 100/500/2,000 requests per minute per developer on API-key routes handled by the standard auth plugin, after the active Fastify per-IP policy (the 5,000/min default or a route override). Commerce, SCIM Bearer data-plane, admin, and other custom-auth routes remain outside these plan buckets. | Source completion does not confirm managed-service deployment. |

## Installation Guidance

Install the verified public releases needed by your application:

```bash
npm install @grantex/sdk@0.5.0
npm install @grantex/x402@0.3.0 @grantex/sdk@0.5.0
pip install grantex==0.4.0
go get github.com/mishrasanjeev/grantex-go@v0.2.0
npm install @grantex/mcp-auth@2.0.2 @grantex/sdk@0.5.0
```

Unpinned install commands resolve to the registry's current release. For reproducible builds, keep the explicit versions above and review this matrix before upgrading.

## Release Maintenance

- Treat package versions as independent and publish package-specific release notes for every release.
- Add release automation that verifies changed package source never reuses an already-published version and updates this matrix at publication time.
- Define and automate a supported Go toolchain policy for the SDK (Go 1.26.1) and Terraform provider (Go 1.25.0).

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).

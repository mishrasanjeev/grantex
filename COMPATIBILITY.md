# Grantex Compatibility Matrix

Last updated: 2026-07-14
Public release snapshot verified: 2026-07-12

This repository uses package-specific versions; there is no monorepo-wide SDK or package release number. The protocol specification remains v1.0 Final, while repository metadata and package registries can move independently during a release.

## Canonical Release Signals

| Surface | Current value | Notes |
| --- | --- | --- |
| Repository changelog | v0.3.12 | Latest top-level release entry in `CHANGELOG.md`. |
| TypeScript SDK | @grantex/sdk 0.3.13 | Published to npm on 2026-07-11. |
| Python SDK | grantex 0.3.14 | Published to PyPI on 2026-07-11. |
| Go SDK | github.com/mishrasanjeev/grantex-go v0.1.10 | Published through the Go module proxy on 2026-07-11 (requires Go 1.26.1); see known limitations below. |
| OpenAPI | 0.3.12 | API-contract version; independent of package-only SDK patches. |
| MCP Auth | @grantex/mcp-auth 2.0.2 | Independently versioned and published to npm; single-process evaluation limitations apply. |
| Published snapshot | [release-status.json](release-status.json) | Machine-readable source for advertised versions and live registry checks. |

## Package Versions

The repository contains 29 packages under `packages/`. Each row maps a directory to its artifact name and repository version. A `published` status means the exact version has been verified on its public registry; other rows describe the package's role without claiming registry publication.

| # | Directory | Published name | Version | Status |
| ---: | --- | --- | ---: | --- |
| 1 | `packages/sdk-ts` | @grantex/sdk | 0.3.13 | Primary SDK (TypeScript); published |
| 2 | `packages/sdk-py` | grantex | 0.3.14 | Primary SDK (Python); published |
| 3 | `packages/go-sdk` | github.com/mishrasanjeev/grantex-go | v0.1.10 (Go 1.26.1) | Primary SDK (Go); published |
| 4 | `packages/cli` | @grantex/cli | 0.2.5 | Tooling |
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
| 28 | `packages/x402` | @grantex/x402 | 0.1.2 | x402 support |
| 29 | `packages/terraform-provider-grantex` | terraform-provider-grantex | Go module (Go 1.25.0) | Terraform provider |

## Known Published-Package Limitations

- **Go SDK `v0.1.10`:** the API returns `agentId`, while `Agent.ID` expects `id`,
  so derive the ID from `did:grantex:<agentId>`. Registration sends optional
  zero values; updates cannot set `status` or clear all scopes, so use REST for
  those writes.
  `LogAuditParams` omits required `agentDid` and `principalId`; use REST or CLI
  for audit writes. `AuditEntry` omits `DeveloperID`, while `Since`, `Until`,
  `Page`, and `PageSize` audit filters are ignored by the API.
  Agent and audit list structs expose metadata the API does not return; use slice
  lengths. List helpers also fail to URL-encode reserved characters in filter
  values; avoid them or issue a `net/url`-encoded REST request.
  See the Go SDK overview for the complete published-release workarounds. All are
  corrected in repository source but require a new public module tag.

- **MCP Auth `2.0.2`:** client registrations default to process memory and
  authorization codes always use a non-configurable process-local store.
  `consentUi` is metadata only, `onTokenIssued` is not invoked, local
  introspection/middleware do not check revocation, and the Grantex authorization
  code is not persisted for token exchange. Treat this release as single-process
  evaluation software until a corrected package is published.

## Repository Source Ahead of Public Releases (updated 2026-07-14)

| Surface | Repository `main` status | Publication or deployment status |
| --- | --- | --- |
| Go SDK parity | All documented Agent/Audit read/write gaps are corrected; unsupported audit filters and phantom list metadata are removed; query values are URL-encoded; API-shaped regression tests cover the contracts. | No corrected tag is published; every `v0.1.10` limitation above still applies. |
| Standard-auth throughput | Auth service source enforces Redis-backed Free/Pro/Enterprise budgets of 100/500/2,000 requests per minute per developer on API-key routes handled by the standard auth plugin, after the active Fastify per-IP policy (the 5,000/min default or a route override). Commerce, SCIM Bearer data-plane, admin, and other custom-auth routes remain outside these plan buckets. | Source completion does not confirm managed-service deployment. |

## Installation Guidance

Install the verified public releases needed by your application:

```bash
npm install @grantex/sdk@0.3.13
pip install grantex==0.3.14
go get github.com/mishrasanjeev/grantex-go@v0.1.10
npm install @grantex/mcp-auth@2.0.2 @grantex/sdk@0.3.13
```

Unpinned install commands resolve to the registry's current release. For reproducible builds, keep the explicit versions above and review this matrix before upgrading.

## Release Maintenance

- Treat package versions as independent and publish package-specific release notes for every release.
- Add release automation that verifies changed package source never reuses an already-published version and updates this matrix at publication time.
- Define and automate a supported Go toolchain policy for the SDK (Go 1.26.1) and Terraform provider (Go 1.25.0).

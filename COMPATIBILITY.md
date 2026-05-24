# Grantex Compatibility Matrix

Last updated: 2026-05-24

This repository currently uses package-specific versions. The public README should not be read as a monorepo-wide `v2.5` release. Until a release tool such as Changesets or Nx enforces this automatically, use this matrix to choose compatible packages.

## Canonical Release Signals

| Surface | Current value | Notes |
| --- | --- | --- |
| Repository changelog | v0.3.8 | Latest top-level release entry in `CHANGELOG.md`. |
| TypeScript SDK | @grantex/sdk 0.3.8 | Primary TypeScript client package. |
| Python SDK | grantex 0.3.9 | Primary Python client package. |
| OpenAPI | 0.1.3 | Needs reconciliation with SDK versions. |
| MCP Auth | @grantex/mcp-auth 2.0.1 | Independently versioned package. |

## Package Versions

The repository contains 28 packages under `packages/` (matching the README "28 packages" claim). Each row maps a directory to the published artifact name and the version recorded in its manifest at the time of writing.

| # | Directory | Published name | Version | Status |
| ---: | --- | --- | ---: | --- |
| 1 | `packages/sdk-ts` | @grantex/sdk | 0.3.8 | Primary SDK (TypeScript) |
| 2 | `packages/sdk-py` | grantex | 0.3.9 | Primary SDK (Python) |
| 3 | `packages/go-sdk` | github.com/mishrasanjeev/grantex-go | Go module (1.26.1) | Primary SDK (Go) |
| 4 | `packages/cli` | @grantex/cli | 0.2.4 | Tooling |
| 5 | `packages/mcp-auth` | @grantex/mcp-auth | 2.0.1 | Independently versioned |
| 6 | `packages/mcp` | @grantex/mcp | 0.1.9 | Adapter |
| 7 | `packages/langchain` | @grantex/langchain | 0.1.6 | Adapter |
| 8 | `packages/autogen` | @grantex/autogen | 0.1.5 | Adapter |
| 9 | `packages/vercel-ai` | @grantex/vercel-ai | 0.1.5 | Adapter |
| 10 | `packages/anthropic` | @grantex/anthropic | 0.1.0 | Adapter |
| 11 | `packages/crewai` | grantex-crewai | 0.1.4 | Adapter |
| 12 | `packages/openai-agents` | grantex-openai-agents | 0.1.3 | Adapter |
| 13 | `packages/google-adk` | grantex-adk | 0.1.3 | Adapter |
| 14 | `packages/strands-py` | grantex-strands | 0.1.0 | Adapter |
| 15 | `packages/express` | @grantex/express | 0.1.4 | Middleware |
| 16 | `packages/fastapi` | grantex-fastapi | 0.1.4 | Middleware |
| 17 | `packages/gateway` | @grantex/gateway | 0.1.4 | Gateway |
| 18 | `packages/conformance` | @grantex/conformance | 0.1.7 | Test suite |
| 19 | `packages/adapters` | @grantex/adapters | 0.1.4 | Service adapters |
| 20 | `packages/destinations` | @grantex/destinations | 0.1.2 | Event destinations |
| 21 | `packages/dpdp` | @grantex/dpdp | 0.1.0 | Compliance controls |
| 22 | `packages/gemma` | @grantex/gemma | 0.1.0 | Offline authorization (TS) |
| 23 | `packages/gemma-py` | grantex-gemma | 0.1.0 | Offline authorization (Python) |
| 24 | `packages/a2a` | @grantex/a2a | 0.1.2 | A2A bridge (TS) |
| 25 | `packages/a2a-py` | grantex-a2a | 0.1.2 | A2A bridge (Python) |
| 26 | `packages/mpp` | @grantex/mpp | 0.1.1 | MPP support |
| 27 | `packages/x402` | @grantex/x402 | 0.1.1 | x402 support |
| 28 | `packages/terraform-provider-grantex` | terraform-provider-grantex | Go module (1.21) | Terraform provider |

## Installation Guidance

Use the latest published primary SDK for your language, then choose adapter versions from the same date range in this matrix. Do not mix this repository's package versions with marketing release labels until a single release process is in place.

## Required Follow-Up

- Pick independent versioning or lockstep versioning and document it permanently.
- Add CI that fails when README, OpenAPI, changelog, and package versions drift without an update to this matrix.
- Reconcile OpenAPI `info.version` with the supported SDK release line.
- Align `packages/go-sdk` (Go 1.26.1) and `packages/terraform-provider-grantex` (Go 1.21) on the same Go toolchain.

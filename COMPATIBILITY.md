# Grantex Compatibility Matrix

Last updated: 2026-07-11

This repository currently uses package-specific versions. The public README should not be read as a monorepo-wide `v2.5` release. Repository versions can be ahead of package registries while an unreleased patch is under review, so the rows below distinguish those states.

## Canonical Release Signals

| Surface | Current value | Notes |
| --- | --- | --- |
| Repository changelog | v0.3.12 | Latest top-level release entry in `CHANGELOG.md`. |
| TypeScript SDK | @grantex/sdk 0.3.13 (unreleased) | Next repository patch; latest published version is 0.3.12. |
| Python SDK | grantex 0.3.14 | Published to PyPI on 2026-07-11. |
| Go SDK | github.com/mishrasanjeev/grantex-go v0.1.10 | Published through the Go module proxy on 2026-07-11 (requires Go 1.26.1). |
| OpenAPI | 0.3.12 | Aligned with the repository changelog and TypeScript SDK release line. |
| MCP Auth | @grantex/mcp-auth 2.0.2 | Independently versioned package. |

## Package Versions

The repository contains 29 packages under `packages/`. Each row maps a directory to its artifact name and repository version. An `unreleased` status means consumer installation examples intentionally remain on the latest registry version until publication.

| # | Directory | Published name | Version | Status |
| ---: | --- | --- | ---: | --- |
| 1 | `packages/sdk-ts` | @grantex/sdk | 0.3.13 | Primary SDK (TypeScript); unreleased, latest published 0.3.12 |
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

## Installation Guidance

Use the latest published primary SDK for your language, then choose adapter versions from the same date range in this matrix. Unreleased repository versions are release-candidate metadata, not proof that a registry artifact exists.

## Required Follow-Up

- Pick independent versioning or lockstep versioning and document it permanently.
- Add release automation that verifies changed package source never reuses an already-published version and updates this matrix at publication time.
- Define and automate a supported Go toolchain policy for the SDK (Go 1.26.1) and Terraform provider (Go 1.25.0).

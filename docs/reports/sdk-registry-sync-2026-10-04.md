# SDK and integration registry audit, 2026-10-04

This receipt distinguishes repository source, validated archives, and public
registry artifacts. Package publication does not deploy the hosted auth service.
Versions are independent; the full inventory is in [COMPATIBILITY.md](../../COMPATIBILITY.md).

## Published

| Registry | Package | Version |
| --- | --- | --- |
| npm | `@grantex/sdk` | 0.8.2 |
| npm | `@grantex/dpdp` | 0.2.0 |
| npm | `@grantex/mcp-auth` | 4.1.0 |
| npm | `@grantex/gateway` | 0.3.0 |
| npm | `@grantex/mcp` | 0.1.11 |
| npm | `@grantex/mpp` | 0.1.3 |
| npm | `@grantex/gemma` | 0.1.2 |
| npm | `@grantex/conformance` | 0.1.9 |
| PyPI | `grantex` | 0.7.2 |
| PyPI | `grantex-a2a` | 0.1.6 |
| PyPI | `grantex-adk` | 0.1.8 |
| PyPI | `grantex-crewai` | 0.1.9 |
| PyPI | `grantex-fastapi` | 0.1.7 |
| PyPI | `grantex-gemma` | 0.1.2 |
| PyPI | `grantex-openai-agents` | 0.1.8 |
| PyPI | `grantex-strands` | 0.2.2 |
| Go proxy | `github.com/mishrasanjeev/grantex-go` | v0.4.3 |

The reviewed [Go mirror PR](https://github.com/mishrasanjeev/grantex-go/pull/1)
merged as `f55097af912b4fa2290b9a6724221d71ca27913d`. The public
`v0.4.3` module metadata resolves to that commit.

## Validation

- The primary and auxiliary release verification jobs passed against the
  merged monorepo commit `31adcd2b82291613259181715f1f7d2270865d3f`,
  with PostgreSQL and Redis services. See
  [primary run 37199496834](https://github.com/mishrasanjeev/grantex/actions/runs/37199496834)
  and [auxiliary run 37200358108](https://github.com/mishrasanjeev/grantex/actions/runs/37200358108).
  These workflow runs are overall **failed** because their registry publish
  jobs lack matching trusted-publisher configuration; the verification jobs
  themselves are green.
- The source tests passed locally: TypeScript SDK 1,437 (17 skipped), Python
  SDK 1,733 (21 skipped), DPDP 191, gateway 159, MCP Auth 398 (2 skipped),
  MCP 45, MPP 76, Gemma TypeScript 142, conformance 39, and Python A2A 29,
  ADK 6, CrewAI 11, FastAPI 20, Gemma 54, OpenAI Agents 7, Strands 17.
  Typechecks/builds, Python distribution checks, Go tests, vet, and race
  tests passed for the affected packages.
- All eight newly published npm integrity values match the exact CI-built
  tarballs. Every new PyPI wheel and sdist SHA-256 matches its CI-built file.
  The public Go proxy resolves v0.4.3; its downloaded module passed
  `go test ./...` and `go vet ./...`.
- A clean public npm install of the eight changed packages succeeded.
  Seven root imports succeeded. Conformance intentionally has no root export;
  its runner/reporter subpaths and CLI `--help` succeeded. A clean Python
  3.12 public-index install and import of `grantex==0.7.2` succeeded.
- Repository documentation and SEO/AEO integrity checks passed before the
  documentation PR. Neither check substitutes for browser or production E2E.

## Boundaries and follow-up

The workstation Docker daemon was unavailable during this release, so this
receipt makes **no new local Docker E2E claim**. Earlier Docker reports apply
to their dated tested versions. The new integration wheels were hash-verified
on PyPI after source tests; this receipt does not claim an installed-package
test for every Python integration or a funded third-party x402 payment.

Registry-side npm trusted publishing and per-project PyPI trusted-publisher
records must be configured for the workflow's OIDC publish jobs to work. The
Go workflow also requires its configured mirror credential. This release used
the maintainer's authenticated local npm/Twine sessions and an explicitly
reviewed Go mirror PR/tag. Never infer registry publication from a source
version bump or a green verification job alone.

The unchanged registry artifacts for adapters, CLI, Strands TypeScript,
AutoGen, Vercel AI, A2A TypeScript, LangChain, Anthropic, Express, and x402
were audited; no new release was needed. The repository's explicitly private
agent HTTPSig, agent passport, and verifier Python packages were not uploaded.

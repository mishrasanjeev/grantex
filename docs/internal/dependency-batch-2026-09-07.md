# Dependency Batch Validation - 2026-09-07

## Scope and Provenance

- Integration PR: https://github.com/mishrasanjeev/grantex/pull/1156
- Baseline main: `32b85f0cb8b5bc55578f138fb93f8aa0206c5fe3`.
- Reviewed integration code/test commit: `d1823c42f9b126e5e3351c95535347b8df7fa6bd`.
- Scope: all 49 open dependency PRs captured before the integration PR was opened.
  Nine had failing checks. All 49 captured heads are ancestors of the integration
  candidate; all 40 explicitly requested manifest changes were verified present.
- No force pushes, admin merges, production security relaxation, registry publishes
  or funded mainnet payments are part of this batch.
- Local work used an isolated checkout outside OneDrive. The original checkout's
  pre-existing untracked `output/` was not modified.

## Fixes

1. Combined Vitest 5 and coverage 5 updates instead of installing incompatible
   major versions. Regenerated overlapping lockfiles and the root's local SDK
   dependency snapshot. Clean installs used normal peer validation.
2. Changed repository CI tooling to Node 24. Vitest 5 requires a supported Node
   runtime starting at 22.12; the auth Dockerfile retains its pinned Node 26 image.
3. Replaced SimpleWebAuthn 14's removed `AuthenticatorTransportFuture` export
   with `AuthenticatorTransport`. Four new real-library tests cover fresh
   challenges, transport hints and malformed registration/authentication rejection.
4. Added explicit public Vitest `Mock` types to exported auth test fixtures,
   fixing TypeScript declaration portability without changing production logic.
5. Grouped future Vitest/coverage Dependabot updates in all four affected packages.
6. Added a repeatable Node validation runner with clean installs, typechecks,
   tests, builds, structured summaries and private randomly named report directories.
   CodeQL caught predictable temporary paths in the first revision; these were
   fixed with `mkdtempSync`, private modes and shell-free subprocess arguments.
7. One five-mutation operator UI test exceeded the default five-second timeout
   in a two-CPU Docker container. It now has a per-test 15-second bound. No
   assertion, production latency limit or security control was removed.
8. Updated README, contributor instructions, deployment commands, release status,
   self-hosting guidance, docs navigation and the dependency-validation guide.
   Removed a stale `npm run migrate` instruction: startup already runs migrations.

## Local Validation

All local API requests targeted the owned Docker fixture, not production.
Node package/app testing used a disposable Linux container capped at two CPUs
and 6 GiB. No other workstation Docker project was stopped or modified.

| Gate | Result |
| --- | --- |
| 19 Node package suites | 2,022 tests passed; clean installs, typechecks and builds passed |
| 13 TypeScript examples | Clean installs and typechecks or Next.js production build passed in Docker |
| Auth-service full Docker rerun | 2,157/2,157 tests, 197.98 seconds, including real disposable PostgreSQL; typecheck/build passed |
| Portal full Docker rerun | 938/938 tests, 222.05 seconds; typecheck and production build passed |
| MPP demo service | Clean install and build passed |
| Full local API E2E | 255/255 tests, 23 files, 92.49 seconds |
| Isolated Base USDC Docker | 12 Node test results / 11 scenarios, no skips, 62.57 seconds |
| Refresh crash/recovery | Encrypted replay survived a real auth-service container restart |
| Python SDK in Docker | 613/613 tests, 13.74 seconds; strict mypy on 89 source files and Ruff passed |
| Go SDK in Docker | Full race suite passed, 133.64 seconds |
| Go quickstart and Terraform provider | Build/package checks passed; these packages have no test files |
| API documentation contracts | 2/2 tests passed |
| Docs integrity | Passed, including live registry checks |
| npm dependency/license policy | 37 lockfiles, 4,202 package entries; npm audits clean |
| Open Dependabot alerts | 0 at pre-merge check |

Final local Node total: 5,117 tests across 19 packages, auth service and portal,
with zero failed or skipped tests in the successful runs. All 13 examples also
passed a separate Windows clean-install/typecheck or build run (27 commands).

The initial Docker app pass correctly failed because its real-Postgres audit
URL was missing; it did not silently skip that suite. The runner now fails early
with an actionable configuration message. The successful full app rerun used a dedicated
`grantex_batch_audit_test` database. The other initial failure was the operator
UI test timeout described above. Initial failures are not counted as green runs.

Package test counts: SDK 457; CLI 520; adapters 128; gateway 67; Express 21;
LangChain 20; Anthropic 44; AutoGen 25; Vercel AI 23; A2A 35; Strands 9;
MCP 45; MCP Auth 60; DPDP 106; MPP 72; destinations 15; conformance 27;
Gemma 142; x402 206.

The local E2E suite covers core auth, DAAP hardening, OAuth Agent Grants,
prepaid wallets, layered spend controls, consent/live mode, portal APIs,
scope enforcement, budgets, DPDP, policies, webhooks, usage, domains, vault,
compliance, credentials, events, principal sessions, SCIM, SSO, MPP and
cross-feature workflows. Base tests additionally cover official-facilitator
execution, exact finalized funding, pre-signing denials, malformed challenges,
tampering, replay, concurrent retry, restart recovery, block/exposure accounting,
settlement and RPC-outage/expiry behavior.

## CI Evidence

All 36 active checks passed at `d1823c42`; the two expected skips were
Mintlify's PR deployment and the scheduled/manual OWASP full scan.
The exact final PR head must be green again after any report-only commit.

- CI: https://github.com/mishrasanjeev/grantex/actions/runs/34081914817
- Base Docker compatibility: https://github.com/mishrasanjeev/grantex/actions/runs/34081914859
- Security scan: https://github.com/mishrasanjeev/grantex/actions/runs/34081914968
- CodeQL: https://github.com/mishrasanjeev/grantex/actions/runs/34081914959
- Dependency review: https://github.com/mishrasanjeev/grantex/actions/runs/34081914840

## Deployment Gate

At report preparation, main merge and production validation have not occurred.
Local validation is complete; merge remains gated on the final PR-head checks. Record the
merge SHA, Cloud Run revision, Firebase deployment and production E2E results
after completion; do not infer deployment from a successful local test.

## Limits

- These are automated tests, not a proof that every possible flow is flawless.
- The Base fixture uses an owned local Anvil chain and fixture USDC. No funded
  external Base-mainnet compatibility call was performed.
- WebAuthn real-library tests are not a hardware authenticator/device matrix.
- Third-party issuer/custody, payment-provider and merchant systems still need
  operator provisioning and their own live acceptance tests.
- Published versions remain TypeScript 0.6.0, x402 0.4.0, Python 0.5.0 and Go
  v0.3.0. This batch does not publish replacement artifacts or new SDK versions.

## Included Pull Requests

| PR | Captured head | Requested change |
| --- | --- | --- |
| #1103 | `ab4318b25ba0` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/sdk-ts |
| #1104 | `471b31108bb5` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/sdk-ts |
| #1105 | `956266cdf9f8` | chore(deps-dev): bump @vitest/coverage-v8 from 4.1.11 to 5.0.0 in /packages/sdk-ts |
| #1106 | `1048aef650c3` | chore(deps-dev): bump the minor-and-patch group in /apps/portal with 3 updates |
| #1107 | `5f7a2f3826b5` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /apps/portal |
| #1108 | `1a3a51c558bc` | chore(deps): bump the minor-and-patch group in /apps/auth-service with 2 updates |
| #1109 | `084f05b6a4e7` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/x402 |
| #1110 | `c18fbd8ce6b5` | chore(deps): bump @simplewebauthn/server from 13.3.3 to 14.0.0 in /apps/auth-service |
| #1111 | `afe2f9f8d6d0` | chore(deps-dev): bump @vitest/coverage-v8 from 4.1.11 to 5.0.0 in /apps/portal |
| #1112 | `48dc897aded4` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/x402 |
| #1113 | `94ea9978bfb5` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /apps/auth-service |
| #1114 | `3e0511159070` | chore(deps-dev): bump @vitest/coverage-v8 from 4.1.11 to 5.0.0 in /apps/auth-service |
| #1115 | `eb95bd423f74` | chore(deps-dev): bump @anthropic-ai/sdk from 0.122.0 to 0.123.0 in /packages/anthropic |
| #1116 | `0b3b07a68d99` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/cli |
| #1117 | `c6fa90906e28` | chore(deps-dev): bump @vitest/coverage-v8 from 4.1.11 to 5.0.0 in /packages/cli |
| #1118 | `a4f9330b3fe9` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/cli |
| #1119 | `8b9211899149` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/mcp |
| #1120 | `56938746986e` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/mcp |
| #1121 | `d604c0496a68` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/mcp-auth |
| #1122 | `0e7c6af12818` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/mcp-auth |
| #1123 | `340568fa0ba4` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/gateway |
| #1124 | `1193e68c3143` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/adapters |
| #1125 | `c68d14f684f5` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/gemma |
| #1126 | `9947c3a02449` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/gateway |
| #1127 | `8af12c975092` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/adapters |
| #1128 | `31faa0415800` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/gemma |
| #1129 | `3415e48d4194` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/destinations |
| #1130 | `6196425287e3` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/quickstart-ts |
| #1131 | `2d933147747b` | chore(deps-dev): bump ai from 7.0.87 to 7.0.92 in /packages/vercel-ai |
| #1132 | `c78f904862a7` | chore(deps-dev): bump @aws-sdk/client-s3 from 3.1123.0 to 3.1125.0 in /packages/destinations |
| #1133 | `b78a33f334d4` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/destinations |
| #1134 | `1316228679bf` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/adapter-google-calendar |
| #1135 | `be18a840e0a7` | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 in /packages/conformance |
| #1136 | `452c4069e2a4` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /packages/conformance |
| #1137 | `dea4c5476909` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/gateway-proxy |
| #1138 | `1c13a396d5c0` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/anthropic-tool-use |
| #1139 | `5314133d913f` | chore(deps): bump @anthropic-ai/sdk from 0.122.0 to 0.123.0 in /examples/anthropic-tool-use |
| #1141 | `6e4dfbcb5e58` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/multi-agent-delegation |
| #1142 | `05de6911f3cd` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/token-expiry-refresh |
| #1143 | `a007e9b6675a` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/audit-dashboard |
| #1144 | `e7ded9e12674` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/langchain-agent |
| #1145 | `d94649324d32` | chore(deps-dev): bump @types/react-dom from 19.2.5 to 19.2.7 in /examples/nextjs-starter |
| #1146 | `b2360fc6e01b` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/nextjs-starter |
| #1147 | `92fe603a0334` | chore(deps): bump @ai-sdk/openai from 4.0.53 to 4.0.58 in /examples/vercel-ai-chatbot |
| #1148 | `f9ea38870c40` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/vercel-ai-chatbot |
| #1149 | `7fae92994bb8` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/multi-agent-email-flow |
| #1150 | `2135ea18f964` | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 in /examples/x402-agent-demo |
| #1151 | `c7025309ec3c` | chore(deps): bump ai from 7.0.87 to 7.0.92 in /examples/vercel-ai-chatbot |
| #1152 | `da43bb8bae90` | chore(deps-dev): bump solc from 0.8.35 to 0.8.36 in /tests/base-usdc |

## Upstream References

- Vitest migration: https://main.vitest.dev/guide/migration/
- SimpleWebAuthn: https://simplewebauthn.dev/docs/

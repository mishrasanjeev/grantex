# Commerce V1 C5J Local Synthetic Smoke Evidence

Date: 2026-05-26

Scope: local/dev/temp-smoke evidence for the merged C5I synthetic merchant dataset. This report records scrubbed command outcomes only. It does not include raw logs, secrets, private merchant details, provider credentials, production config, or production allowlist values.

## Worktree

- Repo: Grantex
- Worktree used: `C:\tmp\grantex-c5j-smoke-prep`
- Evidence input directory: `C:\tmp\grantex-c5j-smoke-prep\.tmp\c5j`
- Main SHA tested: `2f3a09db200a0309e0ae3fb62c1c2f9c4789180a`
- C5I merge baseline: `2f3a09db200a0309e0ae3fb62c1c2f9c4789180a`

## Synthetic Dataset IDs

These IDs are internal/local/smoke-only synthetic values. They are not production allowlist values and are not merchant approval evidence.

- Dataset version: `c5i-synth-v1`
- Tenant ID: `cten_synth_internal_smoke_0001`
- Merchant ID: `mch_synth_internal_smoke_0001`
- Agent ID: `cag_synth_internal_smoke_sales_0001`
- Product IDs: `cprd_synth_internal_smoke_widget_0001`, `cprd_synth_internal_smoke_fixture_0002`
- Variant IDs: `cvar_synth_internal_smoke_widget_0001_a`, `cvar_synth_internal_smoke_fixture_0002_a`
- Provider marker: `mock`
- Currency and country placeholders: `ZZZ`, `ZZ`

## Commands Run

- `git rev-parse HEAD`
- `node scripts\commerce-c5i-synthetic-dataset-validate.mjs`
- `npm ci` in `apps\auth-service` to install local test dependencies for the clean worktree
- `npm test -- tests\commerce-publishing-catalog.test.ts`
- `git diff --check`
- Focused secret scan on evidence and C5I docs/dataset/validator files
- Focused private-detail scan on evidence and C5I docs/dataset files
- Focused overclaim scan on evidence and C5I docs/dataset files
- Focused synthetic safety scan on evidence and C5I docs/dataset files

## Result Summary

| Check | Result | Scrubbed Evidence |
| --- | --- | --- |
| Main SHA capture | Pass | `grantex-main-head.log` |
| C5I synthetic dataset validator | Pass | `grantex-c5i-validator.log` |
| Read-only discovery gate tests | Pass, 21 tests passed | `grantex-read-only-discovery-gate.log` |
| `git diff --check` | Pass | `grantex-diff-check.log` |
| Secret scan | Pass, no matches | `grantex-secret-scan.log` |
| Private-detail scan | Pass, no matches | `grantex-private-detail-scan.log` |
| Overclaim scan | Pass, no matches | `grantex-overclaim-scan.log` |
| Synthetic safety scan | Pass, no matches | `grantex-synthetic-safety-scan.log` |

The Grantex read-only discovery gate tests passed and confirmed the gate remains limited to metadata/read-only discovery behavior. The tests also confirmed that the discovery gate does not open Commerce runtime routes or checkout/payment production creation paths.

## Safety Assertions

- No deploy was run.
- No cloud command was run.
- No production config was changed.
- No production discovery flag was changed.
- No production allowlist value was set.
- `COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains production-disabled.
- `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST` remains production-unset.
- `COMMERCE_V1_ENABLED` was not enabled in production.
- `COMMERCE_LIVE_MODE_ENABLED` and `PLURAL_LIVE_ENABLED` remain off.
- No live payment flow was run.
- No live Plural flow was run.
- No checkout/payment production creation request was run.
- No direct Stripe, Plural, Pine, or provider credential path was introduced.
- No secrets or real merchant data were required.
- Synthetic data is not production approval.
- The synthetic merchant ID must not be used in any production allowlist.

## Remaining Blockers

- No real named merchant approval exists.
- Grantex production read-only discovery remains fail-closed.
- AgenticOrg public commerce discovery remains gated.
- Real C5I artifact intake remains blocked until human approvals are provided.

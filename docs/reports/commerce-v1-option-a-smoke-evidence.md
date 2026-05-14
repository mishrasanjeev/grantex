# Commerce V1 Option A Smoke Evidence

Generated at: 2026-05-14T15:31:25.500Z

## Scope

- Target host: grantex-auth-smoke-dd4mtrt2gq-uc.a.run.app
- Cloud Run service: grantex-auth-smoke
- Cloud Run revision: grantex-auth-smoke-00006-bld
- Cloud SQL smoke instance: grantex-commerce-smoke-pg
- Redis smoke instance: grantex-commerce-smoke-redis
- Provider: mock only
- Commerce live mode: false
- Plural sandbox: false
- Plural live: false
- Production URLs used: no
- Production DB/Redis used: no
- Secret/token/passport/idempotency/webhook material recorded: no
- Temporary smoke resources cleaned up: yes

## Seed

- Tenant: cten_staging_commerce
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Products: 12
- Products with manifest variants: 4
- Synthetic data only: yes
- Generated auth material persisted to tracked files: no

## Result Summary

| Metric | Value |
| --- | --- |
| Passed checks | 22 |
| Failed checks | 0 |
| Skipped checks | 9 |
| HTTP requests | 38 |
| Approximate p95 latency ms | 462 |

## HTTP Status Counts

| HTTP status | Count |
| --- | --- |
| 200 | 27 |
| 201 | 8 |
| 401 | 1 |
| 409 | 2 |

## Checks

| Check | Result | HTTP status | Latency ms | Detail |
| --- | --- | --- | --- | --- |
| seed synthetic smoke DB data | pass | - | 15203 | 12 products, 4 variant products |
| authenticated /health | pass | 200 | 471 | healthy |
| JWKS | pass | 200 | 438 | keys=7 |
| commerce well-known profile | pass | 200 | 301 | mch_staging_electronics_pilot |
| MCP initialize | pass | - | 354 | grantex-commerce |
| MCP tools/list | pass | - | 295 | tools=8 |
| consent request + passport exchange for catalog tools | pass | - | 2144 | checkout passport minted for smoke read checks |
| MCP catalog.search | pass | - | 328 | items=5 |
| MCP catalog.get_item | pass | - | 382 | cprd_stg_induction_cooktop |
| MCP inventory.check | pass | - | 302 | items=1 |
| cart.create + consent + passport + payment.create_intent | pass | - | 2420 | payment_status=authorized |
| checkout.create | pass | - | 340 | payment_status=payment_pending |
| mock webhook paid | pass | 200 | 410 | processed |
| duplicate webhook no double transition | pass | 200 | 301 | duplicate |
| mock webhook failed | pass | 200 | 389 | processed |
| mock webhook expired | pass | 200 | 410 | processed |
| manual reconciliation | pass | 200 | 303 | reconcile_ok |
| audit timeline | pass | 200 | 440 | items=20 |
| invalid webhook signature refusal | pass | 401 | 304 | - |
| missing consent refusal | pass | 200 | 763 | expected refusal: passport_malformed |
| provider webhook replay dry-run | pass | 200 | 1197 | eligible |
| emergency re-enable safe negative check | pass | 409 | 299 | - |
| denied consent | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| revoked passport | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| expired passport | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| amount cap breach | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| disabled merchant | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| untrusted agent | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| stale inventory cautious response | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| unsupported EMI/discount/warranty refusal | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |
| replay unavailable for invalid/non-replayable provider webhook | skipped | - | 0 | not executed in this smoke run after core checkout blocker; requires additional isolated synthetic state |

## AgenticOrg Local-To-Smoke

Not run. AgenticOrg hosted-staging mode is documented for a later pass, but the current local demo/eval path is mocked and cannot be presented as real local-to-smoke evidence.

## Blockers

- None recorded.

## Cleanup Completed

Cleanup completed after evidence capture. The approved temporary smoke resources were deleted before this report was packaged:

- Cloud Run service: `grantex-auth-smoke`
- Cloud SQL smoke instance: `grantex-commerce-smoke-pg`
- Redis smoke instance: `grantex-commerce-smoke-redis`
- Smoke Secret Manager entries: `grantex-smoke-*`
- Smoke image tags: `auth-service-smoke:221d469ac213-m141replayfix` and `auth-service-smoke:e9e78e1182ff-m8fix`

Verification after cleanup confirmed:

- `grantex-auth-smoke` was absent.
- `grantex-commerce-smoke-pg` was absent.
- `grantex-commerce-smoke-redis` was absent.
- Listed `grantex-smoke-*` secrets were absent.
- Production `grantex-auth`, `grantex-pg16`, and `grantex-redis` still existed.
- No production config, production DB/Redis, live payment, or live Plural setting was touched.

> **Internal artifact — not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Commerce V1 Staging/Internal-Sandbox Readiness Run

Run date: 2026-05-13

Scope: Option A readiness execution for Grantex Commerce V1 and AgenticOrg Commerce Sales Agent.
Production Commerce V1 remains disabled. No production config was changed. No production deploy was
performed. Live payments and live Plural remained disabled.

## Environment Availability

| System | Environment | Status | Notes |
| --- | --- | --- | --- |
| Grantex hosted staging | GCP/GitHub | Not available | GCP inventory showed only `grantex-prod` with Cloud Run service `grantex-auth`. GitHub has `staging - docs`, which is docs-only and not a Commerce API staging runtime. |
| Grantex local internal sandbox | Docker Compose | Available | `auth-service`, `postgres`, and `redis` were running locally. `http://localhost:3001/health` returned healthy. |
| AgenticOrg hosted staging | GCP/GitHub | Not available for this run | GitHub has a `staging` environment, but the visible Cloud Run services were production-named app services in `perfect-period-305406`. No separate staging API URL was identified. |
| AgenticOrg local API | Docker/localhost | Not running | No local AgenticOrg API responded on port 8000. AgenticOrg validation used the mocked Commerce Sales Agent eval/demo harness. |

## Config Values Used

Secrets, bearer tokens, Commerce Passports, provider credentials, and idempotency keys are excluded
from this report.

Grantex local internal sandbox:

- API base URL: `http://localhost:3001`
- Database: local Docker Postgres
- Redis: local Docker Redis
- `COMMERCE_V1_ENABLED=true`
- `COMMERCE_ALLOW_AUTO_TENANT=true`
- `COMMERCE_LOCAL_LOAD_TEST=true`
- `COMMERCE_LIVE_MODE_ENABLED=false`
- `PLURAL_SANDBOX_ENABLED=true`
- `PLURAL_LIVE_ENABLED=false`
- Provider: `mock`
- Tenant: `cten_internal_sandbox`
- Merchant: `mch_internal_sandbox_pilot`
- Agent: `cag_internal_sandbox_pilot`

AgenticOrg internal sandbox:

- Runtime: mocked eval/demo harness
- Commerce tool prefix: `grantex_commerce:*`
- No direct Stripe, Plural, Pine, or provider credential path allowed for commerce
- No live Grantex, Docker, API keys, or provider runtime required for the AgenticOrg mocked checks

## Smoke Results

| Check | Result | Evidence |
| --- | --- | --- |
| Grantex health | Pass | `GET http://localhost:3001/health` returned `200` with database and Redis `ok`. |
| Grantex JWKS | Pass | `GET http://localhost:3001/.well-known/jwks.json` returned `200`. |
| Grantex commerce profile | Pass | `GET http://localhost:3001/.well-known/grantex-commerce?merchant_id=mch_internal_sandbox_pilot` returned `200`, `version=grantex-commerce-v1`, `environment=sandbox`. |
| Commerce profile overclaim/secret scan | Pass | No external certification marker or secret marker was detected in the local commerce profile response. |
| Static playground | Pass | `node web/commerce-playground.validate.mjs` passed. |
| Commerce hardening docs | Pass | `node docs/commerce-v1-hardening.validate.mjs` passed. |
| Commerce pilot readiness docs | Pass | `node docs/commerce-v1-pilot-readiness.validate.mjs` passed. |
| Local load harness dry-run | Pass | `node scripts/commerce-pilot-load-harness.mjs --dry-run` passed. |
| AgenticOrg health | Blocked | No non-production AgenticOrg API endpoint was available. Production endpoint was not used for this staging run. |
| AgenticOrg MCP/A2A discovery | Covered by static tests | Focused tests confirmed `commerce_sales_agent` default tools are `grantex_commerce:*` only. |

## E2E Results

Grantex local synthetic seed:

- Command: `node scripts/commerce-pilot-seed-local.mjs --run --migrate --database-url=postgres://grantex:grantex@localhost:5432/grantex --env-output=.tmp/commerce-pilot-load.env`
- Result: pass
- Seeded 100 synthetic carts and 51 pending mock provider payment references.
- Live Plural remained disabled.
- Provider key: `mock`

Grantex local measured harness:

- Command: `node scripts/commerce-pilot-load-harness.mjs --run --env-file=.tmp/commerce-pilot-load.env --report=.tmp/commerce-v1-staging-readiness-load.md`
- Result: pass

| Target | Requests | Success | Errors | p95 | Target | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Payment intent create | 100 | 100 | 0 | 14.36 ms | 500 ms | Pass |
| Catalog search | 500 | 500 | 0 | 5.36 ms | 300 ms | Pass |
| Mock provider webhook | 52 | 52 | 0 | 13.40 ms | 500 ms | Pass |

Mock webhook duplicate transition evidence:

- Duplicate payment transition count: 0
- Processed payment intent count: 51
- Duplicate probe first status: `processed`
- Duplicate probe second status: `duplicate`

AgenticOrg mocked demo:

- Command: `python demos/commerce_sales_agent_demo.py`
- Result: pass
- Covered product discovery, product Q&A, inventory check, cart draft, consent request, passport
  exchange, payment intent, checkout handoff, and payment status polling through
  `grantex_commerce:*` tool aliases.
- Demo safety summary reported no direct provider calls, no provider credential handling, internal
  sandbox only, and user-controlled final payment confirmation.

## Negative Test Results

| Negative check | Result | Evidence |
| --- | --- | --- |
| Denied consent | Pass | Covered by Grantex commerce tests and AgenticOrg eval/guardrail tests. |
| Missing consent | Pass | AgenticOrg eval/demo refused checkout/payment without granted consent/passport. |
| Amount cap breach | Pass | AgenticOrg eval/guardrail tests refused over-cap payment requests. |
| Stale inventory | Pass | AgenticOrg eval/demo produced cautious response without availability guarantee. |
| Unknown inventory | Pass | AgenticOrg eval/demo produced cautious response without availability guarantee. |
| Disabled merchant / policy denial | Pass | Grantex commerce tests and AgenticOrg eval/guardrail tests cover refusal behavior. |
| Revoked/expired passport | Pass | Grantex focused commerce tests cover passport revocation/expiry behavior. |
| Unsupported EMI/discount/offer claim | Pass | AgenticOrg eval/demo refused unsupported commerce claims. |
| Direct provider path unavailable | Pass | AgenticOrg no-provider-call regression confirmed commerce code/default tools avoid Stripe, Plural, Pine, and provider credential paths. |

Focused command results:

- `npm test -- commerce` from `apps/auth-service`: 27 files, 377 tests passed.
- `npm run typecheck` from `apps/auth-service`: passed.
- `npm run typecheck` from `apps/portal`: passed.
- `npm test -- commerce` from `apps/portal`: 2 files, 19 tests passed.
- `npm run build` from `apps/portal`: passed with the existing Vite chunk-size warning.
- `python -m pytest tests/unit/test_grantex_commerce_connector.py tests/unit/test_commerce_sales_agent_guardrails.py tests/regression/test_commerce_sales_agent_no_provider_calls.py tests/evals/test_commerce_sales_agent_evals.py tests/evals/test_commerce_sales_agent_demo.py tests/unit/test_commerce_agent_production_readiness_doc.py -q --no-cov`: 47 tests passed.
- `python -m ruff check connectors/commerce core/commerce core/langgraph/agents/commerce_sales_agent.py tests/unit/test_grantex_commerce_connector.py tests/unit/test_commerce_sales_agent_guardrails.py tests/regression/test_commerce_sales_agent_no_provider_calls.py tests/evals/test_commerce_sales_agent_evals.py tests/evals/test_commerce_sales_agent_demo.py demos/commerce_sales_agent_demo.py tests/unit/test_commerce_agent_production_readiness_doc.py`: passed.

## Blockers

- No hosted Grantex Commerce staging API is available.
- No hosted AgenticOrg staging Commerce Sales Agent API was identified.
- No local AgenticOrg API was running for HTTP `/health`, MCP, or A2A discovery checks.
- This run cannot qualify as an external sandbox pilot gate because it used local Grantex and mocked
  AgenticOrg execution, not an isolated hosted staging pair.
- Human review gates remain open: security, payments, legal/compliance, operations, product, and
  partner/customer success.
- Live payment mode and live Plural remain blocked.

## Hosted Staging Setup Plan

1. Create or identify a non-production Grantex project/service, for example `grantex-staging`.
2. Deploy Grantex auth-service to a staging Cloud Run service with:
   - `COMMERCE_V1_ENABLED=true`
   - `COMMERCE_LIVE_MODE_ENABLED=false`
   - `PLURAL_LIVE_ENABLED=false`
   - mock or approved sandbox provider only
3. Provision staging Postgres, Redis, and secrets separate from production.
4. Seed synthetic Commerce V1 tenant, merchant, agent, catalog, policies, passports, carts, and mock
   provider payment references.
5. Publish a staging-only `/.well-known/grantex-commerce` profile.
6. Create or identify a non-production AgenticOrg API service.
7. Point staging AgenticOrg commerce config to the Grantex staging base URL.
8. Verify AgenticOrg MCP/A2A staging discovery exposes only `grantex_commerce:*` tools for
   `commerce_sales_agent`.
9. Re-run this checklist against hosted staging URLs.
10. Keep production Commerce V1 disabled until production discovery gates are approved.

## Recommendation

Needs fixes/setup before external sandbox pilot.

The local/internal-sandbox implementation evidence is strong and all focused local/mocked checks
passed. However, there is no hosted staging pair available for Grantex plus AgenticOrg, so external
sandbox pilot readiness remains blocked until hosted staging is provisioned and this checklist is
rerun against those non-production services.

> **Internal artifact — not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Commerce V1 Local Workstation Prod-Candidate E2E

Run date: 2026-05-13

Scope: local workstation validation for Grantex Commerce V1 and AgenticOrg Commerce Sales Agent.
No hosted staging was used. No production configuration was changed. No deployment was performed.
Live payments and live Plural remained disabled.

## Position

This report replaces the hosted-staging execution path only for the current cost posture. It does
not provide the isolation or production-like coverage of hosted staging. Treat it as the strongest
available local workstation gate before a controlled production rollout.

Production rollout remains blocked for live payments and live Plural. Any production rollout should
keep Commerce V1 disabled or tightly gated until production config, rollback, and human approval
checks are completed.

## Local Environment

Grantex local stack:

- API: `http://localhost:3001`
- Postgres: local Docker Compose
- Redis: local Docker Compose
- `COMMERCE_V1_ENABLED=true`
- `COMMERCE_LOCAL_LOAD_TEST=true`
- `COMMERCE_LIVE_MODE_ENABLED=false`
- `PLURAL_LIVE_ENABLED=false`
- Provider: `mock`
- Tenant: `cten_internal_sandbox`
- Merchant: `mch_internal_sandbox_pilot`
- Agent: `cag_internal_sandbox_pilot`

AgenticOrg local validation:

- Deterministic eval/demo harness
- Live-local connector smoke against Grantex localhost
- Tool path: `grantex_commerce` connector to Grantex MCP/REST only
- No direct Stripe, Plural, Pine, or provider credential path

## Issue Found And Fixed

The live-local AgenticOrg connector path exposed a real checkout handoff gap:

- `payment.create_intent` succeeded through Grantex.
- `checkout.create` rejected the fresh payment intent with
  `invalid_payment_status_transition`.
- Root cause: the mock provider returned payment intent status `created`, while checkout creation
  correctly requires an `authorized` intent before moving to `checkout_created` and
  `payment_pending`.

Focused fix:

- `MockPaymentProvider.createPaymentIntent` now returns `authorized` with raw status
  `mock_authorized`.
- Tests were updated to expect the mock provider to produce checkout-ready internal-sandbox intents.
- Live provider code, production config, live Plural, and provider credentials were not changed.

## Grantex Smoke

| Check | Result |
| --- | --- |
| Docker Compose local stack | Pass |
| `GET http://localhost:3001/health` | Pass: database and Redis `ok` |
| `GET http://localhost:3001/.well-known/jwks.json` | Pass |
| `GET http://localhost:3001/.well-known/grantex-commerce?merchant_id=mch_internal_sandbox_pilot` | Pass |
| Commerce profile environment | Pass: `sandbox` |
| Commerce profile live payment exposure | Pass: no live payment enablement |

## Grantex E2E Load Harness

Command:

```powershell
node scripts/commerce-pilot-load-harness.mjs --run --env-file=.tmp/commerce-pilot-load.env --report=.tmp/commerce-v1-local-workstation-e2e-load.md
```

Result:

| Target | Requests | Success | Errors | p95 | Target | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Payment intent create | 100 | 100 | 0 | 14.58 ms | 500 ms | Pass |
| Catalog search | 500 | 500 | 0 | 5.41 ms | 300 ms | Pass |
| Mock provider webhook | 52 | 52 | 0 | 13.26 ms | 500 ms | Pass |

Webhook duplicate evidence:

- Duplicate payment transition count: 0
- Processed payment intent count: 51
- Duplicate probe first status: `processed`
- Duplicate probe second status: `duplicate`

## AgenticOrg Live-Local Connector E2E

The AgenticOrg connector was run against live local Grantex using synthetic `.tmp` seed inputs.
Secrets, passports, bearer tokens, idempotency keys, and raw payment data were not printed.

| Step | Result |
| --- | --- |
| Connector health | Pass: `healthy` |
| Merchant profile | Pass |
| Catalog search | Pass: 1 local sandbox item |
| Cart draft creation | Pass |
| Payment intent creation | Pass |
| Checkout handoff | Pass |
| Payment status polling | Pass: `payment_pending` |
| Provider | `mock` only |
| Tool path | AgenticOrg `grantex_commerce` connector to local Grantex MCP/REST only |

## Command Results

Grantex:

- `npm run typecheck` from `apps/auth-service`: passed.
- `npm test -- commerce` from `apps/auth-service`: 27 files, 377 tests passed.
- `npm test` from `apps/auth-service`: 103 files, 1404 tests passed.
- `npm run typecheck` from `apps/portal`: passed.
- `npm test` from `apps/portal`: 96 files, 906 tests passed; expected test error-boundary console output appeared.
- `npm run build` from `apps/portal`: passed with existing Vite chunk-size warning.
- `node docs/commerce-v1-hardening.validate.mjs`: passed.
- `node web/commerce-playground.validate.mjs`: passed.
- `node docs/commerce-v1-pilot-readiness.validate.mjs`: passed.
- `node scripts/commerce-pilot-load-harness.mjs --dry-run`: passed.
- `git diff --check`: passed with line-ending warnings only.

AgenticOrg:

- `python -m ruff check ...`: passed.
- `python -m pytest ... -q --no-cov`: 47 tests passed; one pytest cache warning.
- `python -m mypy --follow-imports=skip ...`: passed.
- `python -m compileall ...`: passed.
- `python demos/commerce_sales_agent_demo.py`: passed.

## Negative Coverage

| Scenario | Coverage |
| --- | --- |
| Missing consent | AgenticOrg eval/demo refusal |
| Denied consent | AgenticOrg eval/guardrail refusal |
| Amount cap breach | AgenticOrg eval/guardrail refusal |
| Stale or unknown inventory | AgenticOrg cautious response |
| Disabled merchant / policy denial | Grantex tests and AgenticOrg guardrails |
| Revoked or expired passport | Grantex commerce tests |
| Unsupported EMI/discount/offer/warranty | AgenticOrg refusal |
| Direct provider path | AgenticOrg static regression confirms no Stripe/Plural/Pine commerce path |
| Duplicate webhook transition | Local Grantex harness confirms no duplicate payment transition |

## Limitations

- No hosted staging pair exists.
- AgenticOrg API was not running on `localhost:8000`, so HTTP discovery endpoints were not tested
  locally through a live AgenticOrg API server.
- AgenticOrg behavior was covered through deterministic eval/demo tests plus a live-local connector
  smoke into Grantex.
- Local workstation testing does not validate cloud IAM, Secret Manager bindings, Cloud Run runtime
  settings, production DNS, production CORS, production logging sinks, production rollback, or
  real external customer traffic.

## Direct-To-Prod Not-Ready-If

Do not proceed to production rollout if any of the following is true:

- The mock-provider `authorized` checkout fix is not committed and deployed.
- Production Commerce V1 would be enabled without explicit human approval.
- `COMMERCE_LIVE_MODE_ENABLED` would be set to `true`.
- `PLURAL_LIVE_ENABLED` would be set to `true`.
- Live Plural/provider credentials would be mounted for commerce.
- Production rollback revision and commands are not confirmed.
- Production smoke plan does not exclude real payment creation.
- Legal/compliance/payment/ops review gates are not explicitly accepted or deferred.

## Recommendation

Local workstation E2E is green after the mock checkout-state fix.

Recommended next step is a controlled production deployment only if Commerce V1 remains disabled or
internally gated in production, live payment mode remains disabled, and live Plural remains disabled.
External sandbox pilot and live payments are still not ready without the human review gates and
provider/legal/ops approvals.

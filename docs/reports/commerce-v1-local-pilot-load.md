# Commerce V1 Local Pilot Load Report

Generated at: 2026-05-13T03:45:16.810Z

Mode: run
API base: http://localhost:3001
Local only: true
Overall status: pass

Required Local Setup:

- Start the local stack with `docker compose up --build -d`.
- Seed local sandbox data with `commerce-pilot-seed-local.mjs`.
- Keep this run local-only with mock provider inputs and live Plural disabled.

Measured targets:

- Payment intent create: `POST /v1/commerce/payments/intents`.
- Catalog search: `POST /v1/commerce/catalog/search`.
- Mock provider webhooks: `POST /v1/webhooks/providers/mock`.

| Target | Requests | Success | Errors | p50 ms | p95 ms | max ms | p95 target ms | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| payment_intent_create | 100 | 100 | 0 | 11 | 16.53 | 49.79 | 500 | pass |
| catalog_search | 500 | 500 | 0 | 3.54 | 5.41 | 12.88 | 300 | pass |
| mock_provider_webhook | 52 | 52 | 0 | 13.96 | 20.45 | 21.3 | 500 | pass |

Duplicate webhook transition evidence:

- Duplicate webhook transition count: 0
- Duplicate payment transition count: 0
- Duplicate event probe passed: true

Human review of the generated report:

- Confirm all target rows pass before using this as readiness evidence.
- Confirm duplicate webhook transition count remains 0.
- Confirm this was generated against localhost and sandbox/mock inputs only.

This report must be generated only against a local auth-service using mock provider and sandbox data.

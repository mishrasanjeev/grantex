> **Internal artifact — not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Commerce V1 Hosted Staging E2E Evidence Template

Status: template only. Do not record bearer tokens, raw passports, idempotency keys, provider credentials, webhook secret values, private keys, or production data.

## Run Metadata

- Report type: commerce-v1-hosted-staging-e2e
- Generated at:
- Operator:
- Grantex API base: https://api-staging.grantex.dev
- Grantex portal base: https://staging.grantex.dev
- AgenticOrg base: https://staging.agenticorg.ai
- Seed manifest: docs/examples/commerce-staging-seed.manifest.json
- Tenant: cten_staging_commerce
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Provider: mock
- Live payments enabled: false
- Live Plural enabled: false

## Preconditions

- Staging DNS verified:
- Dedicated staging Postgres verified:
- Dedicated staging Redis verified:
- Staging secrets available by name:
- No production DB, Redis, or secrets used:
- No cloud resources created by this run:

## Required Secret Names

- ADMIN_API_KEY
- MOCK_PAYMENT_WEBHOOK_SECRET
- METRICS_API_KEY
- Commerce Passport signing key material
- GRANTEX_COMMERCE_BEARER_TOKEN or GRANTEX_AGENT_ASSERTION or GRANTEX_API_KEY

## Positive Checks

| Check | Status | HTTP status | Evidence reference |
| --- | --- | --- | --- |
| Grantex health | blocked |  |  |
| Grantex JWKS | blocked |  |  |
| Grantex commerce well-known | blocked |  |  |
| MCP initialize | blocked |  |  |
| MCP tools/list | blocked |  |  |
| MCP catalog search/get item | blocked |  |  |
| MCP inventory check | blocked |  |  |
| REST cart create | blocked |  |  |
| REST consent request | blocked |  |  |
| passport exchange | blocked |  |  |
| payment intent create | blocked |  |  |
| checkout create | blocked |  |  |
| mock webhook paid/failed/expired | blocked |  |  |
| duplicate webhook check | blocked |  |  |
| manual reconciliation | blocked |  |  |
| audit timeline check | blocked |  |  |
| portal route smoke | blocked |  |  |
| AgenticOrg real-staging demo/eval handoff | blocked |  |  |

## Negative Checks

| Check | Expected result | Status | Evidence reference |
| --- | --- | --- | --- |
| missing consent | refused | blocked |  |
| denied consent | refused | blocked |  |
| revoked passport | refused | blocked |  |
| expired passport | refused | blocked |  |
| amount cap breach | refused | blocked |  |
| disabled merchant | refused | blocked |  |
| untrusted agent | refused | blocked |  |
| stale inventory | refused | blocked |  |
| unsupported EMI/discount/warranty claim | refused | blocked |  |
| invalid webhook signature | refused | blocked |  |

## Redaction Confirmation

- secret values recorded: false
- bearer tokens recorded: false
- Raw passports recorded: false
- Idempotency keys recorded: false
- Provider credentials recorded: false
- Production data recorded: false

## No-Go Findings

- None recorded.

## Rollback Notes

- If staging commerce discovery must be hidden, disable staging discovery and stop staging workers.
- If a bad staging revision is active, roll back only the staging service revision.
- Production must not be changed.

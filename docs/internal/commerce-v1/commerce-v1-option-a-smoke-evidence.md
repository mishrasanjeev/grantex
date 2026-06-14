> **Internal artifact - not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Commerce V1 Option A Smoke Evidence

Status: C2G approved smoke evidence captured from a temporary Option A smoke service. This report is scrubbed and contains no bearer token values, passports, consent runtime material, idempotency key values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Generated at: 2026-05-17T05:54:50.986Z

Target host: grantex-auth-smoke-dd4mtrt2gq-uc.a.run.app

Provider: mock

Live flags: Commerce live mode false; live payments false; live Plural false.

AgenticOrg fixture env: .tmp/commerce-agent-real-staging.env

Variable names used: GRANTEX_COMMERCE_BASE_URL, GRANTEX_BASE_URL, AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL, AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID, AGENTICORG_COMMERCE_FIXTURE_AGENT_ID, AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID, AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID, GRANTEX_API_KEY

Synthetic IDs:
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Product: cprd_01KRT7Y4ZFHB6FE2Z4PDHP3H3K
- Variant: cvar_01KRT7Y4ZJNS9KQ3NT1HA0AX6D

## Summary

- Passed: 14
- Failed: 0
- Failed-safe: 6
- Skipped: 0

## Case Results

| Case | Status | HTTP | Latency ms | Error code | Synthetic refs |
| --- | --- | ---: | ---: | --- | --- |
| health | passed | 200 | 516 |  |  |
| jwks | passed | 200 | 345 |  |  |
| commerce_well_known | passed | 200 | 293 |  |  |
| mcp_initialize | passed | 200 | 294 |  |  |
| mcp_tools_list | passed | 200 | 288 |  |  |
| merchant_profile | passed | 200 | 300 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_search | passed | 200 | 323 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_get_item | passed | 200 | 303 |  | product_id=cprd_01KRT7Y4ZFHB6FE2Z4PDHP3H3K |
| inventory_check | passed | 200 | 303 |  | variant_id=cvar_01KRT7Y4ZJNS9KQ3NT1HA0AX6D |
| cart_create | passed | 200 | 427 |  | cart_id=ccart_01KRT80PTS3BA236ZWA1RW1DZR |
| consent_request | passed | 201 | 322 |  | consent_request_id=redacted |
| consent_exchange | failed-safe | 409 | 297 | consent_not_granted |  |
| payment_intent_create | passed | 200 | 356 |  | payment_intent_id=cpi_01KRT80QSDDAASHJMHNHDJHG7H |
| checkout_create | passed | 200 | 341 |  | payment_intent_id=cpi_01KRT80QSDDAASHJMHNHDJHG7H |
| payment_status | passed | 200 | 299 |  | payment_intent_id=cpi_01KRT80QSDDAASHJMHNHDJHG7H |
| missing_consent_refusal | failed-safe | 200 | 298 | validation_failed |  |
| amount_cap_breach_refusal | failed-safe | 200 | 303 | cart_not_payable |  |
| revoked_passport_refusal | failed-safe | 200 | 326 | cart_not_payable |  |
| expired_passport_refusal | failed-safe | 200 | 302 | cart_not_payable |  |
| denied_consent_refusal | failed-safe | 403 | 312 | consent_denied |  |

## Cleanup Status

Cleanup completed after evidence capture.

Deleted temporary Cloud Run service: grantex-auth-smoke
Deleted temporary Cloud SQL instance: grantex-commerce-smoke-pg
Deleted temporary Redis instance: grantex-commerce-smoke-redis
Deleted temporary smoke secrets: grantex-smoke-* only
Deleted temporary smoke image tag: auth-service-smoke:a664af2d4cae7c50cf6567205c4986ddb54805a1

Verified temporary smoke Cloud Run, Cloud SQL, Redis, and smoke secrets absent after cleanup.
Verified temporary smoke image tag absent after cleanup.
Verified production resources still present: grantex-auth, grantex-pg16, grantex-redis.
Production Commerce V1, live payment, and live Plural flags were not changed by this run.

## Redaction

The runner records only host/origin, variable names, synthetic IDs, case status, HTTP status, latency, and error codes. It never writes raw response payloads, usable passports, auth material, idempotency key values, webhook secrets, provider credentials, DB/Redis URLs, private keys, or secret values to this report.

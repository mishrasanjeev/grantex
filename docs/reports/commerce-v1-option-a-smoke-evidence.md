# Commerce V1 Option A Smoke Evidence

Status: C2E approved smoke evidence captured from a temporary Option A smoke service. This report is scrubbed and contains no bearer token values, passports, idempotency key values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Generated at: 2026-05-16T15:12:37.892Z

Target host: grantex-auth-smoke-876335597959.us-central1.run.app

Provider: mock

Live flags: Commerce live mode false; live payments false; live Plural false.

AgenticOrg fixture env: .tmp/commerce-agent-real-staging.env

Variable names used: GRANTEX_COMMERCE_BASE_URL, GRANTEX_BASE_URL, AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL, AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID, AGENTICORG_COMMERCE_FIXTURE_AGENT_ID, AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID, AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID, GRANTEX_API_KEY

Synthetic IDs:
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Product: cprd_01KRRN1K5HSQV7MGEDP8PD54Z2
- Variant: cvar_01KRRN1K5TB1MQ10GJJB91H2YT

## Summary

- Passed: 14
- Failed: 0
- Failed-safe: 6
- Skipped: 0

## Case Results

| Case | Status | HTTP | Latency ms | Error code | Synthetic refs |
| --- | --- | ---: | ---: | --- | --- |
| health | passed | 200 | 454 |  |  |
| jwks | passed | 200 | 321 |  |  |
| commerce_well_known | passed | 200 | 296 |  |  |
| mcp_initialize | passed | 200 | 303 |  |  |
| mcp_tools_list | passed | 200 | 302 |  |  |
| merchant_profile | passed | 200 | 295 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_search | passed | 200 | 335 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_get_item | passed | 200 | 328 |  | product_id=cprd_01KRRN1K5HSQV7MGEDP8PD54Z2 |
| inventory_check | passed | 200 | 310 |  | variant_id=cvar_01KRRN1K5TB1MQ10GJJB91H2YT |
| cart_create | passed | 200 | 465 |  | cart_id=ccart_01KRRNH8M8ZKWMRMDD5PN658BE |
| consent_request | passed | 201 | 356 |  | consent_request_id=IPLGk3vA0Utxt3DI6ADo1ubBavQP2yLd |
| consent_exchange | failed-safe | 409 | 319 | consent_not_granted |  |
| payment_intent_create | passed | 200 | 416 |  | payment_intent_id=cpi_01KRRNH9P3Y50WGAETGSHKDNHA |
| checkout_create | passed | 200 | 381 |  | payment_intent_id=cpi_01KRRNH9P3Y50WGAETGSHKDNHA |
| payment_status | passed | 200 | 325 |  | payment_intent_id=cpi_01KRRNH9P3Y50WGAETGSHKDNHA |
| missing_consent_refusal | failed-safe | 200 | 309 | validation_failed |  |
| amount_cap_breach_refusal | failed-safe | 200 | 319 | cart_not_payable |  |
| revoked_passport_refusal | failed-safe | 200 | 347 | cart_not_payable |  |
| expired_passport_refusal | failed-safe | 200 | 308 | cart_not_payable |  |
| denied_consent_refusal | failed-safe | 403 | 303 | consent_denied |  |

## Cleanup Status

Cleanup completed after evidence capture.

Deleted temporary Cloud Run service: grantex-auth-smoke
Deleted temporary Cloud SQL instance: grantex-commerce-smoke-pg
Deleted temporary Redis instance: grantex-commerce-smoke-redis

Deleted temporary smoke resources:
- Smoke secrets: grantex-smoke-* only
- Smoke image tag: auth-service-smoke:42f602bbecb1358794e8743dd4b162d92fe3cdc2

Verified temporary smoke Cloud Run, Cloud SQL, Redis, and smoke secrets absent after cleanup.

Production resources verified present and untouched after cleanup:
- Cloud Run service: grantex-auth
- Cloud SQL instance: grantex-pg16
- Redis instance: grantex-redis

Verified production resources still present: grantex-auth, grantex-pg16, grantex-redis.

Production Commerce V1, live payment, and live Plural flags were not changed by this run.

## Redaction

The runner records only host/origin, variable names, synthetic IDs, case status, HTTP status, latency, and error codes. It never writes raw response payloads, usable passports, auth material, idempotency key values, webhook secrets, provider credentials, DB/Redis URLs, private keys, or secret values to this report.

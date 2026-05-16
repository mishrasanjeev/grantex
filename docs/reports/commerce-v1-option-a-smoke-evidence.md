# Commerce V1 Option A Smoke Evidence

Status: C2D approved smoke evidence captured from a temporary Option A smoke service. This report is scrubbed and contains no bearer token values, passports, idempotency key values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Generated at: 2026-05-16T09:21:44.677Z

Target host: grantex-auth-smoke-dd4mtrt2gq-uc.a.run.app

Provider: mock

Live flags: Commerce live mode false; live payments false; live Plural false.

AgenticOrg fixture env: .tmp/commerce-agent-real-staging.env

Variable names used: GRANTEX_COMMERCE_BASE_URL, GRANTEX_BASE_URL, AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL, AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID, AGENTICORG_COMMERCE_FIXTURE_AGENT_ID, AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID, AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID, GRANTEX_API_KEY

Synthetic IDs:
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Product: cprd_01KRR1DTSAXMY57RRPTDSB6KBZ
- Variant: cvar_01KRR1DTSG62ZV9RFWFBHWTZ21

## Summary

- Passed: 14
- Failed: 0
- Failed-safe: 6
- Skipped: 0

## Case Results

| Case | Status | HTTP | Latency ms | Error code | Synthetic refs |
| --- | --- | ---: | ---: | --- | --- |
| health | passed | 200 | 353 |  |  |
| jwks | passed | 200 | 318 |  |  |
| commerce_well_known | passed | 200 | 317 |  |  |
| mcp_initialize | passed | 200 | 297 |  |  |
| mcp_tools_list | passed | 200 | 292 |  |  |
| merchant_profile | passed | 200 | 299 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_search | passed | 200 | 326 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_get_item | passed | 200 | 319 |  | product_id=cprd_01KRR1DTSAXMY57RRPTDSB6KBZ |
| inventory_check | passed | 200 | 304 |  | variant_id=cvar_01KRR1DTSG62ZV9RFWFBHWTZ21 |
| cart_create | passed | 200 | 425 |  | cart_id=ccart_01KRR1ES7QEJW667VDW9EXH4SH |
| consent_request | passed | 201 | 319 |  | consent_request_id=MRdNQPuqpZzWIOE70qNhaILaXmyRp_sU |
| consent_exchange | failed-safe | 409 | 305 | consent_not_granted |  |
| payment_intent_create | passed | 200 | 401 |  | payment_intent_id=cpi_01KRR1ET7PZE7Z4KHA027YNJZ0 |
| checkout_create | passed | 200 | 366 |  | payment_intent_id=cpi_01KRR1ET7PZE7Z4KHA027YNJZ0 |
| payment_status | passed | 200 | 314 |  | payment_intent_id=cpi_01KRR1ET7PZE7Z4KHA027YNJZ0 |
| missing_consent_refusal | failed-safe | 200 | 297 | validation_failed |  |
| amount_cap_breach_refusal | failed-safe | 200 | 315 | cart_not_payable |  |
| revoked_passport_refusal | failed-safe | 200 | 348 | cart_not_payable |  |
| expired_passport_refusal | failed-safe | 200 | 318 | cart_not_payable |  |
| denied_consent_refusal | failed-safe | 403 | 296 | consent_denied |  |

## Cleanup Status

Cleanup completed after evidence capture.

- Deleted temporary Cloud Run service: grantex-auth-smoke
- Deleted temporary Cloud SQL instance: grantex-commerce-smoke-pg
- Deleted temporary Redis instance: grantex-commerce-smoke-redis
- Deleted temporary smoke Secret Manager secrets
- Deleted temporary smoke image tag for commit 92026af74a2d71f6f1cefe19d6feac9b7249f30c
- Verified temporary smoke Cloud Run, Cloud SQL, Redis, and smoke secrets absent after cleanup
- Verified production resources still present: grantex-auth, grantex-pg16, grantex-redis
- Production Commerce V1, live payment, and live Plural flags were not changed by this run

## Redaction

The runner records only host/origin, variable names, synthetic IDs, case status, HTTP status, latency, and error codes. It never writes raw response payloads, usable passports, auth material, idempotency key values, webhook secrets, provider credentials, DB/Redis URLs, private keys, or secret values to this report.

# Commerce V1 Option A Smoke Evidence

Status: C2F approved smoke evidence captured from a temporary Option A smoke service. This report is scrubbed and contains no bearer token values, passports, idempotency key values, webhook secrets, provider credentials, raw payloads, DB/Redis URLs, private keys, or secret values.

Generated at: 2026-05-16T17:09:09.274Z

Target host: grantex-auth-smoke-dd4mtrt2gq-uc.a.run.app

Provider: mock

Live flags: Commerce live mode false; live payments false; live Plural false.

AgenticOrg fixture env: .tmp/commerce-agent-real-staging.env

Variable names used: GRANTEX_COMMERCE_BASE_URL, GRANTEX_BASE_URL, AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL, AGENTICORG_COMMERCE_FIXTURE_MERCHANT_ID, AGENTICORG_COMMERCE_FIXTURE_AGENT_ID, AGENTICORG_COMMERCE_FIXTURE_PRODUCT_ID, AGENTICORG_COMMERCE_FIXTURE_VARIANT_ID, GRANTEX_API_KEY

Synthetic IDs:
- Merchant: mch_staging_electronics_pilot
- Agent: cag_staging_agenticorg_sales
- Product: cprd_01KRRW5GHPGK90F3CD7TH1X5C6
- Variant: cvar_01KRRW5GHY3M38WKMDXKD1MHKR

## Summary

- Passed: 14
- Failed: 0
- Failed-safe: 6
- Skipped: 0

## C2F Payment-Intent Check

The positive payment intent path passed against the temporary smoke service with provider `mock`, Commerce live mode false, live payments false, and live Plural false.

## Case Results

| Case | Status | HTTP | Latency ms | Error code | Synthetic refs |
| --- | --- | ---: | ---: | --- | --- |
| health | passed | 200 | 389 |  |  |
| jwks | passed | 200 | 331 |  |  |
| commerce_well_known | passed | 200 | 290 |  |  |
| mcp_initialize | passed | 200 | 303 |  |  |
| mcp_tools_list | passed | 200 | 292 |  |  |
| merchant_profile | passed | 200 | 311 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_search | passed | 200 | 318 |  | merchant_id=mch_staging_electronics_pilot |
| catalog_get_item | passed | 200 | 306 |  | product_id=cprd_01KRRW5GHPGK90F3CD7TH1X5C6 |
| inventory_check | passed | 200 | 301 |  | variant_id=cvar_01KRRW5GHY3M38WKMDXKD1MHKR |
| cart_create | passed | 200 | 436 |  | cart_id=ccart_01KRRW6M9EGNR30KWDR303R8KK |
| consent_request | passed | 201 | 320 |  | consent_request_id=gmAMG7jQMeASLr2IUymZAXF3yyqNnLJP |
| consent_exchange | failed-safe | 409 | 312 | consent_not_granted |  |
| payment_intent_create | passed | 200 | 361 |  | payment_intent_id=cpi_01KRRW6N8F3HET2ANSB55RY1PS |
| checkout_create | passed | 200 | 350 |  | payment_intent_id=cpi_01KRRW6N8F3HET2ANSB55RY1PS |
| payment_status | passed | 200 | 302 |  | payment_intent_id=cpi_01KRRW6N8F3HET2ANSB55RY1PS |
| missing_consent_refusal | failed-safe | 200 | 305 | validation_failed |  |
| amount_cap_breach_refusal | failed-safe | 200 | 300 | cart_not_payable |  |
| revoked_passport_refusal | failed-safe | 200 | 313 | cart_not_payable |  |
| expired_passport_refusal | failed-safe | 200 | 322 | cart_not_payable |  |
| denied_consent_refusal | failed-safe | 403 | 305 | consent_denied |  |

## Cleanup Status

Cleanup completed after evidence capture.

Deleted temporary Cloud Run service: grantex-auth-smoke
Deleted temporary Cloud SQL instance: grantex-commerce-smoke-pg
Deleted temporary Redis instance: grantex-commerce-smoke-redis
Deleted temporary smoke secrets: grantex-smoke-* only
Deleted temporary smoke image tag: auth-service-smoke:81003bae4ce32b98e847c7f1ab536945079eb96a

Verified temporary smoke Cloud Run, Cloud SQL, Redis, and smoke secrets absent after cleanup.
Verified production resources still present: grantex-auth, grantex-pg16, grantex-redis.
Production Commerce V1, live payment, and live Plural flags were not changed by this run.

## Redaction

The runner records only host/origin, variable names, synthetic IDs, case status, HTTP status, latency, and error codes. It never writes raw response payloads, usable passports, auth material, idempotency key values, webhook secrets, provider credentials, DB/Redis URLs, private keys, or secret values to this report.

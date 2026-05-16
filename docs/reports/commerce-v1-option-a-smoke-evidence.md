# Commerce V1 Option A Smoke Evidence

Run date: 2026-05-15

## Summary

- Smoke URL host: `grantex-auth-smoke-dd4mtrt2gq-uc.a.run.app`
- Cloud Run revision: `grantex-auth-smoke-00004-t46`
- Cloud SQL: `grantex-commerce-smoke-pg`
- Redis: external Redis was created as `grantex-commerce-smoke-redis`; smoke runtime used in-container ephemeral Redis after external Redis connectivity failed
- Provider: `mock`
- Live payments: blocked / not enabled
- Live Plural: blocked / not enabled
- Production resources: not targeted
- Production resources untouched: yes
- Secrets, bearer tokens, passports, idempotency keys, webhook secrets, provider credentials, encrypted payloads, and raw webhook payloads: not recorded

## Result

- Passed: 22
- Failed: 0
- Skipped: 3
- C2B result: 22 passed, 0 failed, 3 skipped
- Passed checks | 22
- Failed checks | 0

| Check | Status | HTTP | Latency ms | Detail |
| --- | --- | ---: | ---: | --- |
| health | passed | 200 | 356.63 |  |
| jwks | passed | 200 | 324.04 |  |
| commerce_well_known | passed | 200 | 294.22 | merchant profile available |
| mcp_initialize | passed | 200 | 288.29 |  |
| mcp_tools_list | passed | 200 | 296.23 | 8 tools |
| merchant_get_profile | passed | 200 | 294.46 |  |
| catalog_search | passed | 200 | 305.72 | 5 products |
| catalog_get_item | passed | 200 | 307.75 |  |
| inventory_check | passed | 200 | 342.57 | 1 |
| cart_create | passed | 200 | 315.2 | created |
| consent_fixture_present | passed | 200 | 0.06 | seeded synthetic consent and passport fixture used |
| passport_exchange_fixture_present | passed | 200 | 0.01 | seeded synthetic checkout passport used |
| payment_create_intent | passed | 200 | 327.54 | authorized |
| checkout_create | passed | 200 | 343.5 | payment_pending |
| payment_get_status_after_checkout | passed | 200 | 307.9 | payment_pending |
| mock_webhook_paid | passed | 200 | 319.3 | paid |
| mock_webhook_failed | passed | 200 | 327.92 | failed |
| mock_webhook_expired | passed | 200 | 312.37 | expired |
| duplicate_webhook_no_double_transition | passed | 200 | 298.11 | duplicate |
| manual_reconciliation | passed | 200 | 300.2 |  |
| missing_consent_negative | passed | 200 | 298.63 | passport_required |
| invalid_webhook_signature_negative | passed | 401 | 297.65 | webhook_signature_invalid |
| audit_timeline_operator_check | skipped |  |  | operator auth material was not exported; skipped to avoid reading smoke secrets |
| provider_webhook_replay_dry_run | skipped |  |  | operator auth material was not exported; skipped to avoid reading smoke secrets |
| emergency_reenable_negative | skipped |  |  | operator auth material was not exported; skipped to avoid reading smoke secrets |

## Readiness Baseline

The prior merged Option A readiness baseline remains valid for replay-specific evidence:

| Baseline check | Status | HTTP | Detail |
| --- | --- | ---: | --- |
| provider webhook replay dry-run | pass | 200 | M14.1 replay SQL ambiguity fixed; response did not expose raw or encrypted payload material |

AgenticOrg hosted-staging mode is documented for a later pass. C2B used local AgenticOrg real-staging mode against the temporary Grantex smoke URL.
AgenticOrg fixture blocker remains: C2C needs synthetic consent/passport fixture support before full AgenticOrg checkout coverage.

## Cleanup

Cleanup deadline: `2026-05-15T23:59:00+05:30`

Cleanup Completed

Temporary smoke resources cleaned up: yes

Production DB/Redis used: no

Commerce live mode: false

Plural live: false

Cleanup commands were run after evidence collection to delete:

- `grantex-auth-smoke`
- `grantex-commerce-smoke-pg`
- `grantex-commerce-smoke-redis`
- `grantex-smoke-*` secrets
- smoke image tags, where safe

Cleanup verification after the run:

- `grantex-auth-smoke` was absent after cleanup
- `grantex-commerce-smoke-pg` was absent after cleanup
- `grantex-commerce-smoke-redis` was absent after cleanup
- `grantex-smoke-*` secrets: deleted / absent
- smoke image tags for this run: deleted
- Production `grantex-auth`, `grantex-pg16`, and `grantex-redis` still existed

# Commerce V1 Hosted Staging E2E Harness

## Purpose And Scope

This guide defines the M11 hosted staging E2E harness plan for Grantex Commerce V1 and the AgenticOrg Commerce Sales Agent handoff. It is a pre-cloud, pre-deploy planning artifact plus a dry-run safety harness. It does not create resources, deploy services, merge branches, change production config, write secrets, enable production Commerce V1, enable live payments, or enable live Plural.

The current pass is documentation and dry-run validation only. Hosted execution is a later milestone after the M9 infrastructure and M10 staging data prerequisites are complete.

## Safety Rules

- No production URL may be used as an E2E target.
- No live payment path may be enabled.
- No live Plural path may be enabled.
- No production secret version may be copied into staging.
- No production database, Redis, bucket, or queue may be used.
- No bearer token, raw passport, idempotency key, provider credential, webhook secret value, or private key may be written to a report.
- All evidence must be redacted before it is committed or attached to a PR.
- The dry-run harness must fail closed before any hosted request can run.

## Staging-Only Allowed Domains

The M11 harness may plan checks only for these staging domains:

- `https://api-staging.grantex.dev`
- `https://staging.grantex.dev`
- `https://staging.agenticorg.ai`

Localhost may be used only for explicit local dry-run comparison. Localhost is not a hosted staging target.

## Refused Production Domains

The M11 harness must refuse these domains in all modes:

- `https://grantex.dev`
- `https://api.grantex.dev`
- `https://app.agenticorg.ai`

Any URL with embedded username, password, token, secret, key, passport, bearer, or credential query material is also refused.

## Preconditions From M9 And M10

- Grantex staging infrastructure is approved but not created by this pass.
- Grantex API target is `grantex-auth-staging` behind `https://api-staging.grantex.dev`.
- Grantex portal target is `grantex-portal-staging` behind `https://staging.grantex.dev`.
- AgenticOrg staging services are planned behind `https://staging.agenticorg.ai`.
- Dedicated staging Postgres exists before any real seed.
- Dedicated staging Redis exists before any real seed.
- Dedicated staging Secret Manager entries exist before any real run.
- Staging data uses tenant `cten_staging_commerce`.
- Staging data uses merchant `mch_staging_electronics_pilot`.
- Staging data uses agent `cag_staging_agenticorg_sales`.
- Staging data uses category `electronics_appliances`.
- Staging provider is `mock`.
- Live flags are false.
- M8 mock provider checkout-state fix is present so payment intent state starts at `authorized`.
- M10 seed manifest is reviewed and ready: `docs/examples/commerce-staging-seed.manifest.json`.

## Required Auth Material Names Only

The hosted run will need staging-only secret values loaded from the approved staging runtime, but this guide records names only:

- `ADMIN_API_KEY`
- `MOCK_PAYMENT_WEBHOOK_SECRET`
- `METRICS_API_KEY`
- Commerce Passport signing key material
- One AgenticOrg connector credential: `GRANTEX_COMMERCE_BEARER_TOKEN`, `GRANTEX_AGENT_ASSERTION`, or `GRANTEX_API_KEY`

Do not paste values into shell history, docs, reports, PR descriptions, or logs.

## E2E Sequence

1. Grantex health
2. Grantex JWKS
3. Grantex commerce well-known
4. MCP initialize
5. MCP tools/list
6. MCP catalog search/get item
7. MCP inventory check
8. REST cart create
9. REST consent request
10. passport exchange
11. payment intent create
12. checkout create
13. mock webhook paid/failed/expired
14. duplicate webhook check
15. manual reconciliation
16. audit timeline check
17. portal route smoke
18. AgenticOrg real-staging demo/eval handoff

## Negative Checks

- missing consent
- denied consent
- revoked passport
- expired passport
- amount cap breach
- disabled merchant
- untrusted agent
- stale inventory
- unsupported EMI/discount/warranty claim
- invalid webhook signature

Each negative check must prove refusal without creating a successful checkout or irreversible state transition.

## Redacted Evidence Report Schema

The later hosted report should follow this shape and omit all secret values:

```json
{
  "report_type": "commerce-v1-hosted-staging-e2e",
  "generated_at": "ISO-8601 timestamp",
  "mode": "hosted-staging",
  "targets": {
    "api_base": "https://api-staging.grantex.dev",
    "portal_base": "https://staging.grantex.dev",
    "agenticorg_base": "https://staging.agenticorg.ai"
  },
  "seed_manifest": {
    "tenant_id": "cten_staging_commerce",
    "merchant_id": "mch_staging_electronics_pilot",
    "agent_id": "cag_staging_agenticorg_sales",
    "provider": "mock",
    "product_count": 12
  },
  "preconditions": [
    "staging DNS verified",
    "dedicated staging DB verified",
    "dedicated staging Redis verified",
    "staging secrets available by name"
  ],
  "checks": [
    {
      "name": "Grantex health",
      "status": "pass|fail|blocked",
      "http_status": 200,
      "duration_ms": 0,
      "evidence_ref": "redacted log line or request id only"
    }
  ],
  "negative_checks": [
    {
      "name": "invalid webhook signature",
      "status": "pass|fail|blocked",
      "expected_refusal": true,
      "evidence_ref": "redacted log line or request id only"
    }
  ],
  "redaction": {
    "secret_values_recorded": false,
    "bearer_tokens_recorded": false,
    "passports_recorded": false,
    "provider_credentials_recorded": false
  },
  "no_go": [],
  "rollback_notes": []
}
```

## Rollback And No-Go Criteria

Stop the hosted run and mark the report blocked if any of these occur:

- A target resolves to a production domain.
- A target uses a production database, Redis, or secret version.
- `COMMERCE_LIVE_MODE_ENABLED` or `PLURAL_LIVE_ENABLED` is true.
- Provider is anything other than `mock`.
- AgenticOrg tries to use direct Stripe, Plural, Pine, or provider credentials for commerce.
- Checkout succeeds without consent, with denied consent, with a revoked or expired passport, or above amount cap.
- Duplicate webhook changes state twice.
- Audit timeline is missing required events.
- Evidence contains unredacted auth material.

Rollback for a later hosted run is limited to disabling staging traffic, disabling staging commerce discovery, stopping staging workers, and restoring the previous staging revision. Production must not be touched.

## Exact Later-Run Commands

M11 dry-run planning:

```powershell
node scripts/commerce-staging-e2e-harness.mjs --dry-run
node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=https://api-staging.grantex.dev --agenticorg-base=https://staging.agenticorg.ai
node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=https://api.grantex.dev
```

The third command is a refusal check and must fail before any network request.

Later hosted staging execution, after M9/M10 prerequisites and a reviewed implementation of run mode:

```powershell
node scripts/commerce-staging-e2e-harness.mjs --run --api-base=https://api-staging.grantex.dev --agenticorg-base=https://staging.agenticorg.ai --manifest=docs/examples/commerce-staging-seed.manifest.json --report=docs/reports/commerce-v1-hosted-staging-e2e.md
```

AgenticOrg later real-staging handoff commands:

```powershell
$env:AGENTICORG_BASE_URL='https://staging.agenticorg.ai'
$env:GRANTEX_COMMERCE_BASE_URL='https://api-staging.grantex.dev'
$env:GRANTEX_BASE_URL='https://api-staging.grantex.dev'
python demos/commerce_sales_agent_demo.py --mode=hosted-staging
python -m pytest tests/evals/test_commerce_sales_agent_evals.py -q --hosted-staging
```

Those AgenticOrg commands are a command plan. They must not be treated as passing hosted evidence until the demo/eval supports non-mocked staging connectors and redacted reporting.

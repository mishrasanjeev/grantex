# Commerce V1 Staging Data Setup

Status: M10 planning, fixture, and validator work only. This pass does not create resources, connect to hosted services, deploy code, or write secrets.

## Seed Purpose

The staging seed prepares realistic but synthetic commerce data for the hosted Grantex Commerce V1 and AgenticOrg Commerce Sales Agent staging pair. It is intended to support later M11 hosted E2E evidence after the M9 infrastructure plan exists in a real staging environment.

The seed scope is narrow:

- Tenant: `cten_staging_commerce`
- Merchant: `mch_staging_electronics_pilot`
- Agent: `cag_staging_agenticorg_sales`
- Category: `electronics_appliances`
- Provider: `mock`
- Currency: `INR`
- Catalog size: 10-25 synthetic electronics/appliances products
- Commerce flags: sandbox only, no live payments, no live Plural

The source fixture is `docs/examples/commerce-staging-seed.manifest.json`.

## Seed Safety Rules

- Use synthetic staging-only data.
- Do not use production data.
- Do not use real customer names, emails, phones, addresses, payment details, or merchant credentials.
- Do not write raw Commerce Passports into docs, fixtures, logs, PRs, or reports.
- Do not write bearer tokens, API keys, provider credentials, webhook signing values, or idempotency keys into docs, fixtures, logs, PRs, or reports.
- Use `provider_key=mock` only.
- Keep `COMMERCE_LIVE_MODE_ENABLED=false`.
- Keep `PLURAL_LIVE_ENABLED=false`.
- Keep `PLURAL_SANDBOX_ENABLED=false` unless a real Plural sandbox contract is confirmed in a later milestone.
- Keep seed output redacted: IDs and counts are okay; secret values and generated references are not.
- Treat generated staging payment references as ephemeral evidence, not commit material.

## Production Refusal Rules

Any future staging seed script or job must refuse to run when any of these are true:

- `NODE_ENV=production`
- API base is `https://grantex.dev`
- API base is not `https://api-staging.grantex.dev`
- `PUBLIC_BASE_URL` is `https://grantex.dev`
- `JWT_ISSUER` is `https://grantex.dev`
- `COMMERCE_LIVE_MODE_ENABLED` is true
- `PLURAL_LIVE_ENABLED` is true
- `COMMERCE_SANDBOX_ENABLED` is false
- `COMMERCE_V1_ENABLED` is false for hosted staging
- Database host, database name, username, project ID, or Cloud SQL instance name contains `prod`, `production`, or `live`
- Redis host, Redis instance, or project ID contains `prod`, `production`, or `live`
- GCP project is the production project
- Cloud Run service is not `grantex-auth-staging`
- Provider is not `mock`
- Secret source is a production GitHub environment or production Secret Manager namespace

These are production refusal checks. They are not instructions to create staging resources in M10.

## Staging DNS Prerequisites

Do not seed until DNS and routing are confirmed:

- `api-staging.grantex.dev` resolves to the staging API only.
- `staging.grantex.dev` resolves to staging portal hosting only.
- AgenticOrg staging is allowed by CORS: `https://staging.agenticorg.ai`.
- Production domains must not be used in seed or smoke commands.

## Staging DB And Redis Prerequisites

Do not seed until dedicated staging data stores exist:

- Dedicated staging Postgres or staging database.
- Dedicated staging Redis or isolated staging Redis database/keyspace.
- No production database.
- No production Redis.
- Migrations applied to the staging database.
- Staging application role cannot mutate append-only audit rows except through approved audit writer paths.
- Staging backup/reset decision documented before destructive reset commands are used.

## Staging Secret Inventory By Name Only

Create staging-only secret values later using these names or documented staging-prefixed equivalents:

- `DATABASE_URL`
- `REDIS_URL`
- `ADMIN_API_KEY`
- `VAULT_ENCRYPTION_KEY`
- `RSA_PRIVATE_KEY`, if fixed app JWT signing is used
- `ED25519_PRIVATE_KEY`, if DID/signing paths are enabled
- `SSO_STATE_SECRET`
- `METRICS_API_KEY`
- `RESEND_API_KEY`, only if staging email/OTP is enabled
- `MOCK_PAYMENT_WEBHOOK_SECRET`
- Commerce Passport signing key material, according to the existing key path

Secret handling rules:

- Store values in staging Secret Manager and staging GitHub environment secrets only.
- Do not copy production secret versions.
- Do not commit `.env`, `.tmp`, generated env files, secret exports, tokens, raw passports, provider credentials, or local reports.
- Do not paste secret values into PR bodies, logs, or docs.

## Staging Seed Data Model

The manifest describes:

- One synthetic tenant: `cten_staging_commerce`.
- One synthetic electronics merchant: `mch_staging_electronics_pilot`.
- One trusted AgenticOrg sales agent identity: `cag_staging_agenticorg_sales`.
- One active policy with INR amount cap, scope allowlist, TTL caps, stale-price guard, and emergency disable false.
- One mock provider profile with live flags false.
- A tax-inclusive INR catalog with GST rate and HSN metadata.
- Warranty and return summaries for every product.
- Availability status for every product.
- Source system and last synced timestamp for every product.
- At least three products with variants.
- Webhook test reference requirements for paid, failed, expired, duplicate, invalid signature, stale timestamp, and unsupported event cases.
- Consent and Commerce Passport test user requirements for approved, denied, missing, revoked, expired, amount cap, and untrusted agent cases.

The manifest intentionally does not include tokens, raw passports, real emails, real phones, provider credentials, or signing values.

## Staging Seed Command Plan For Later

M10 does not add an executable hosted seed script. M10.1 should add a dry-run-only planner or a guarded staging seed script after infrastructure decisions are final.

Expected future command shape:

```bash
node scripts/commerce-staging-seed-plan.mjs --dry-run --manifest=docs/examples/commerce-staging-seed.manifest.json
node scripts/commerce-staging-seed-plan.mjs --dry-run --api-base=https://api-staging.grantex.dev --manifest=docs/examples/commerce-staging-seed.manifest.json
```

Expected later execution shape, after explicit approval:

```bash
node scripts/commerce-staging-seed.mjs --run --api-base=https://api-staging.grantex.dev --manifest=docs/examples/commerce-staging-seed.manifest.json
```

The future `--run` command must refuse production domains, production project IDs, production databases, production Redis, live commerce flags, live Plural flags, non-mock provider keys, and missing staging-only secret sources.

## Staging Smoke-Test Command Plan For Later

M11 should add a hosted staging E2E harness rather than reusing the local-only load harness unchanged.

Expected command shape:

```bash
node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=https://api-staging.grantex.dev --merchant-id=mch_staging_electronics_pilot --agent-id=cag_staging_agenticorg_sales
node scripts/commerce-staging-e2e-harness.mjs --run --api-base=https://api-staging.grantex.dev --merchant-id=mch_staging_electronics_pilot --agent-id=cag_staging_agenticorg_sales --report=docs/internal/commerce-v1/commerce-v1-hosted-staging-e2e.md
```

Smoke coverage should include:

- Health.
- JWKS.
- Commerce well-known.
- MCP initialize, tools/list, and tools/call.
- Catalog search and get item.
- Inventory check.
- Cart create.
- Consent request.
- Passport exchange.
- Payment intent create.
- Checkout create.
- Mock webhook paid, failed, expired, duplicate, and invalid signature.
- Manual reconciliation.
- Audit timeline.
- Portal payments, audit, passports, settings, and ops views.
- AgenticOrg demo/eval against `https://api-staging.grantex.dev`.

The hosted harness must not emit bearer tokens, raw passports, provider credentials, idempotency keys, or webhook signing values.

## Cleanup And Reset Plan

Reset must be staging-only and explicitly approved:

- Disable AgenticOrg staging traffic to Grantex commerce before destructive reset.
- Pause or disable staging reconciliation worker.
- Export staging evidence that is intentionally retained.
- Delete or truncate only records for `cten_staging_commerce`.
- Preserve append-only audit evidence when required by the pilot evidence plan.
- Rotate staging-only mock webhook signing material if generated events were shared outside the staging team.
- Re-run the seed and smoke checks.
- Never run cleanup against production DB, production Redis, production Cloud Run service, or production Firebase target.

## M10 Confirmation

This current pass does not create resources. It does not deploy. It does not merge. It does not change production config. It does not enable production Commerce V1. It does not enable live payments. It does not enable live Plural. It does not write real secret values.

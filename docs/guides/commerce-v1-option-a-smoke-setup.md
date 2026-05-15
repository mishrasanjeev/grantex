# Commerce V1 Option A Smoke Setup

Status: preparation only. This document does not deploy, create cloud resources, merge branches, change production config, enable production Commerce V1, enable live payments, enable live Plural, read secret values, or write secret values.

## Purpose

Option A is the cheapest temporary hosted smoke path for Grantex Commerce V1. It is not full staging. It exists only to prove that the hosted Grantex API can run the Commerce V1 mock-provider path over HTTPS with isolated staging data stores and staging-only secrets.

## Execution Outcome

Option A hosted smoke was executed after explicit approval and is now complete. The redacted evidence report is `docs/reports/commerce-v1-option-a-smoke-evidence.md`.

- Final smoke evidence recorded 22 passed checks, 0 failed checks, and 9 skipped negative checks.
- Health, JWKS, commerce well-known, MCP initialize/tools/list, catalog, inventory, cart, consent, passport exchange, mock payment intent, checkout, mock provider webhooks, duplicate webhook idempotency, manual reconciliation, audit timeline, provider webhook replay dry-run, and emergency re-enable negative check passed.
- Temporary smoke resources were deleted after evidence capture: `grantex-auth-smoke`, `grantex-commerce-smoke-pg`, `grantex-commerce-smoke-redis`, `grantex-smoke-*` secrets, and smoke image tags.
- Full hosted staging is still not provisioned. Option A did not create custom DNS, hosted AgenticOrg, Firebase portal staging, production-like scaling, or long-lived staging services.
- Live payments and live Plural remain blocked. The smoke used mock provider only with live flags false.
- AgenticOrg local-to-smoke was not run as valid hosted evidence because the current local demo/eval path is mocked.

## Cheapest Temporary Topology

| Component | Option A choice | Cost control |
| --- | --- | --- |
| GCP host project | Existing `grantex-prod` project as host only | Avoids new project setup cost and time |
| API runtime | Separate Cloud Run service `grantex-auth-smoke` | `min-instances=0`, `max-instances=1` |
| API URL | Direct Cloud Run `https://...run.app` URL | No custom DNS or certificate setup |
| Database | Temporary tiny Cloud SQL Postgres | Delete immediately after evidence |
| Redis | Temporary Basic 1GB Redis | Required because auth-service needs `REDIS_URL` |
| Provider | `mock` only | No live payment provider |
| Portal | Local portal against hosted API or skipped | No Firebase deploy |
| AgenticOrg | Local AgenticOrg demo/eval against hosted Grantex | No hosted AgenticOrg services |
| Evidence | Redacted local report after approved run | No raw payloads or secrets |

## Why Direct Cloud Run URL Is Allowed For First Smoke

Direct Cloud Run URLs are allowed only for Option A smoke because the goal is a temporary hosted API check, not browser-domain parity. The harness must allow exactly one explicitly approved `run.app` origin with `--allow-smoke-cloud-run-url` or `COMMERCE_STAGING_ALLOWED_SMOKE_URL`. Arbitrary `run.app` URLs remain refused.

This keeps production refusal intact while avoiding the cost and setup time of custom DNS for the first smoke.

## What Option A Proves

- Grantex auth-service can start in a hosted runtime with Commerce V1 enabled only on the smoke service.
- Hosted HTTPS API health, JWKS, commerce well-known, MCP, catalog, inventory, cart, consent, passport, payment intent, checkout, mock webhook, reconciliation, audit, provider webhook replay, and emergency re-enable paths can be exercised against isolated smoke data stores.
- Mock-provider payment and checkout paths stay sandbox-only.
- The staging harness still refuses production domains and live flags.
- AgenticOrg connector/demo code can point locally at a hosted Grantex Commerce API.

## What Option A Does Not Prove

- Custom DNS behavior for `api-staging.grantex.dev`.
- Browser origin behavior for `staging.grantex.dev`.
- FIDO RP ID or origin behavior on the final staging domain.
- Full hosted portal behavior through Firebase Hosting.
- Hosted AgenticOrg Cloud Run runtime, MCP discovery, or A2A discovery at `staging.agenticorg.ai`.
- Production-like scale, HA, failover, or long-lived operational posture.
- Plural sandbox or live payment behavior.

## Required Project And Region Placeholders

Use these defaults only after explicit approval:

```text
GCP_PROJECT_ID=grantex-prod
GCP_REGION=us-central1
ARTIFACT_REPO=grantex-images
CLOUD_RUN_SERVICE=grantex-auth-smoke
CLOUD_SQL_INSTANCE=grantex-commerce-smoke-pg
CLOUD_SQL_DATABASE=grantex_commerce_smoke
CLOUD_SQL_USER=grantex_commerce_smoke_app
REDIS_INSTANCE=grantex-commerce-smoke-redis
```

## Exact Non-Secret Environment Variables

Set these only on `grantex-auth-smoke`:

```text
NODE_ENV=staging
PUBLIC_BASE_URL=<approved smoke Cloud Run URL>
JWT_ISSUER=<approved smoke Cloud Run URL>
DID_WEB_DOMAIN=<approved smoke Cloud Run host only>
FIDO_RP_ID=<approved smoke Cloud Run host only>
FIDO_ORIGIN=<approved smoke Cloud Run URL>
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:4173
COMMERCE_V1_ENABLED=true
COMMERCE_SANDBOX_ENABLED=true
COMMERCE_ALLOW_AUTO_TENANT=false
COMMERCE_LOCAL_LOAD_TEST=false
COMMERCE_LIVE_MODE_ENABLED=false
PLURAL_SANDBOX_ENABLED=false
PLURAL_LIVE_ENABLED=false
COMMERCE_RECONCILIATION_WORKER_ENABLED=false
COMMERCE_RECONCILIATION_INTERVAL_MS=300000
COMMERCE_RECONCILIATION_LIMIT=50
METRICS_ENABLED=true
METRICS_REQUIRE_AUTH=true
SSO_ALLOW_INSECURE_URLS=false
WEBHOOK_ALLOW_INSECURE_URLS=false
LDAP_TLS_REJECT_UNAUTHORIZED=true
AUTO_GENERATE_KEYS=false
```

Do not set production domain values on this service.

## Required Secrets By Name Only

Create staging-only smoke secret names. Do not reuse production secret versions.

- `grantex-smoke-database-url`
- `grantex-smoke-redis-url`
- `grantex-smoke-admin-api-key`
- `grantex-smoke-vault-encryption-key`
- `grantex-smoke-rsa-private-key`
- `grantex-smoke-sso-state-secret`
- `grantex-smoke-metrics-api-key`
- `grantex-smoke-mock-payment-webhook-secret`
- `grantex-smoke-commerce-passport-signing-key`

Optional only if the smoke run needs the path:

- `grantex-smoke-ed25519-private-key`
- `grantex-smoke-resend-api-key`

## Commands Proposed But Not Run

Every command in this section is a proposed command. Do not run these until the user explicitly approves the final command list.

### Preflight Names

```powershell
# NOT RUN
$env:GCP_PROJECT_ID='grantex-prod'
$env:GCP_REGION='us-central1'
$env:CLOUD_RUN_SERVICE='grantex-auth-smoke'
$env:CLOUD_SQL_INSTANCE='grantex-commerce-smoke-pg'
$env:CLOUD_SQL_DATABASE='grantex_commerce_smoke'
$env:CLOUD_SQL_USER='grantex_commerce_smoke_app'
$env:REDIS_INSTANCE='grantex-commerce-smoke-redis'
```

### Create Tiny Temporary Cloud SQL

```powershell
# NOT RUN
gcloud sql instances create $env:CLOUD_SQL_INSTANCE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --database-version=POSTGRES_16 `
  --tier=db-f1-micro `
  --storage-type=HDD `
  --storage-size=10GB `
  --availability-type=zonal `
  --backup-start-time=03:00 `
  --no-deletion-protection

# NOT RUN
gcloud sql databases create $env:CLOUD_SQL_DATABASE `
  --project=$env:GCP_PROJECT_ID `
  --instance=$env:CLOUD_SQL_INSTANCE

# NOT RUN
gcloud sql users create $env:CLOUD_SQL_USER `
  --project=$env:GCP_PROJECT_ID `
  --instance=$env:CLOUD_SQL_INSTANCE `
  --password=<generate-smoke-password-outside-repo>
```

If `db-f1-micro` is unavailable in the selected region or edition, choose the cheapest approved PostgreSQL tier available in the Google Cloud console before running.

### Create Temporary Basic Redis

```powershell
# NOT RUN
gcloud redis instances create $env:REDIS_INSTANCE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --size=1 `
  --tier=basic `
  --redis-version=redis_7_0
```

Redis is included because the current auth-service startup requires `REDIS_URL`. Omitting it would require code changes and would weaken smoke evidence for revocation, rate-limit, usage, and commerce event paths.

### Create Staging-Only Secret Names

```powershell
# NOT RUN
gcloud secrets create grantex-smoke-database-url --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-redis-url --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-admin-api-key --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-vault-encryption-key --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-rsa-private-key --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-sso-state-secret --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-metrics-api-key --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-mock-payment-webhook-secret --project=$env:GCP_PROJECT_ID --replication-policy=automatic
gcloud secrets create grantex-smoke-commerce-passport-signing-key --project=$env:GCP_PROJECT_ID --replication-policy=automatic
```

Secret versions must be added only from secure local files or console entry. Do not paste values into docs, shell history, PRs, reports, or chat.

### Build And Deploy Separate Cloud Run Service

```powershell
# NOT RUN
gcloud builds submit apps/auth-service `
  --project=$env:GCP_PROJECT_ID `
  --tag=us-central1-docker.pkg.dev/grantex-prod/grantex-images/auth-service-smoke:<approved-commit-sha>

# NOT RUN
gcloud run deploy $env:CLOUD_RUN_SERVICE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --image=us-central1-docker.pkg.dev/grantex-prod/grantex-images/auth-service-smoke:<approved-commit-sha> `
  --min-instances=0 `
  --max-instances=1 `
  --cpu=1 `
  --memory=512Mi `
  --concurrency=20 `
  --no-allow-unauthenticated `
  --set-env-vars=NODE_ENV=staging,COMMERCE_V1_ENABLED=true,COMMERCE_SANDBOX_ENABLED=true,COMMERCE_ALLOW_AUTO_TENANT=false,COMMERCE_LOCAL_LOAD_TEST=false,COMMERCE_LIVE_MODE_ENABLED=false,PLURAL_SANDBOX_ENABLED=false,PLURAL_LIVE_ENABLED=false,COMMERCE_RECONCILIATION_WORKER_ENABLED=false,METRICS_ENABLED=true,METRICS_REQUIRE_AUTH=true,SSO_ALLOW_INSECURE_URLS=false,WEBHOOK_ALLOW_INSECURE_URLS=false,LDAP_TLS_REJECT_UNAUTHORIZED=true,AUTO_GENERATE_KEYS=false `
  --set-secrets=DATABASE_URL=grantex-smoke-database-url:latest,REDIS_URL=grantex-smoke-redis-url:latest,ADMIN_API_KEY=grantex-smoke-admin-api-key:latest,VAULT_ENCRYPTION_KEY=grantex-smoke-vault-encryption-key:latest,RSA_PRIVATE_KEY=grantex-smoke-rsa-private-key:latest,SSO_STATE_SECRET=grantex-smoke-sso-state-secret:latest,METRICS_API_KEY=grantex-smoke-metrics-api-key:latest,MOCK_PAYMENT_WEBHOOK_SECRET=grantex-smoke-mock-payment-webhook-secret:latest
```

If the smoke service must be reachable by the local harness without an identity token, use a restricted temporary invoker setup approved separately. Do not make production services public.

### Get Direct Cloud Run URL

```powershell
# NOT RUN
$env:SMOKE_URL = gcloud run services describe $env:CLOUD_RUN_SERVICE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --format='value(status.url)'
```

### Update URL-Dependent Env Vars

```powershell
# NOT RUN
$smokeHost = ([uri]$env:SMOKE_URL).Host

# NOT RUN
gcloud run services update $env:CLOUD_RUN_SERVICE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --set-env-vars=PUBLIC_BASE_URL=$env:SMOKE_URL,JWT_ISSUER=$env:SMOKE_URL,DID_WEB_DOMAIN=$smokeHost,FIDO_RP_ID=$smokeHost,FIDO_ORIGIN=$env:SMOKE_URL,CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:4173
```

### Run Migrations And Seed

Prefer app startup migrations only if the current service already runs them safely. If a separate migration command is required, run it as a one-off Cloud Run job or service command using the same smoke image, smoke DB, and smoke secrets only.

```powershell
# NOT RUN
node scripts/commerce-staging-seed-plan.mjs --dry-run --manifest=docs/examples/commerce-staging-seed.manifest.json

# NOT RUN
node scripts/commerce-staging-seed.mjs --run --api-base=$env:SMOKE_URL --manifest=docs/examples/commerce-staging-seed.manifest.json
```

If the executable hosted seed script is not implemented yet, stop and implement it as a separate guarded change before seeding.

### Harness Dry-Run With Explicit Smoke URL

```powershell
# NOT RUN
node scripts/commerce-staging-e2e-harness.mjs --dry-run --api-base=$env:SMOKE_URL --allow-smoke-cloud-run-url=$env:SMOKE_URL
```

### Hosted Smoke After Approval

```powershell
# NOT RUN
node scripts/commerce-staging-e2e-harness.mjs --run --api-base=$env:SMOKE_URL --allow-smoke-cloud-run-url=$env:SMOKE_URL --report=docs/reports/commerce-v1-hosted-staging-e2e.md
```

Run mode must remain fail-closed until a reviewed implementation exists and the required smoke env names are present.

### Local AgenticOrg Against Hosted Grantex

```powershell
# NOT RUN
$env:GRANTEX_COMMERCE_BASE_URL=$env:SMOKE_URL
$env:GRANTEX_BASE_URL=$env:SMOKE_URL
$env:AGENTICORG_COMMERCE_ALLOWED_SMOKE_URL=$env:SMOKE_URL
$env:AGENTICORG_COMMERCE_REAL_STAGING='1'
# Set exactly one Grantex auth env var securely outside logs.
python demos/commerce_sales_agent_demo.py --mode=real-staging --grantex-base $env:SMOKE_URL --allow-smoke-cloud-run-url $env:SMOKE_URL --evidence-report docs/reports/commerce-agent-real-staging-evidence.md
python -m pytest tests/evals/test_commerce_sales_agent_real_staging.py -q
```

Use only approved local AgenticOrg auth material. Do not print or commit bearer tokens, passports, idempotency keys, provider credentials, webhook secrets, raw payloads, or secret values.

## Evidence Report Command Plan

Create a redacted report only after real smoke checks run:

```powershell
# NOT RUN
node scripts/commerce-staging-e2e-harness.mjs --run --api-base=$env:SMOKE_URL --allow-smoke-cloud-run-url=$env:SMOKE_URL --report=docs/reports/commerce-v1-hosted-staging-e2e.md
```

The report must include only hostnames, request counts, status codes, redacted request IDs, pass/fail rows, blockers, and no-live-payment confirmation. It must not include secret values, bearer tokens, raw passports, idempotency keys, provider credentials, webhook secrets, encrypted payload material, or raw webhook payloads.

## Cleanup Commands Proposed But Not Run

```powershell
# NOT RUN
gcloud run services delete $env:CLOUD_RUN_SERVICE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --quiet

# NOT RUN
gcloud redis instances delete $env:REDIS_INSTANCE `
  --project=$env:GCP_PROJECT_ID `
  --region=$env:GCP_REGION `
  --quiet

# NOT RUN
gcloud sql instances delete $env:CLOUD_SQL_INSTANCE `
  --project=$env:GCP_PROJECT_ID `
  --quiet

# NOT RUN
gcloud secrets delete grantex-smoke-database-url --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-redis-url --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-admin-api-key --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-vault-encryption-key --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-rsa-private-key --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-sso-state-secret --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-metrics-api-key --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-mock-payment-webhook-secret --project=$env:GCP_PROJECT_ID --quiet
gcloud secrets delete grantex-smoke-commerce-passport-signing-key --project=$env:GCP_PROJECT_ID --quiet

# NOT RUN
gcloud artifacts docker images delete us-central1-docker.pkg.dev/grantex-prod/grantex-images/auth-service-smoke:<approved-commit-sha> `
  --project=$env:GCP_PROJECT_ID `
  --quiet
```

## Safety Controls

- Use a separate Cloud Run service; never update `grantex-auth`.
- Use a separate temporary database; never write to `grantex-pg16` or any production-shaped database.
- Use a separate temporary Redis instance; never write to `grantex-redis`.
- Use separate smoke secret names; never mount production secret versions.
- No production database.
- No production Redis.
- No production secrets.
- Mock provider only.
- Keep `COMMERCE_LIVE_MODE_ENABLED=false`.
- Keep `PLURAL_LIVE_ENABLED=false`.
- Keep `PLURAL_SANDBOX_ENABLED=false` until external Plural sandbox contract is confirmed.
- Use mock provider only.
- Keep Cloud Run `min-instances=0` and `max-instances=1` for the smoke service.
- Do not configure custom DNS in Option A.
- Do not deploy Firebase portal in Option A.
- Do not deploy hosted AgenticOrg in Option A.
- Delete smoke DB and Redis immediately after evidence collection unless the user approves a longer retention window.

## Rollback Plan

Rollback is deletion, not traffic migration:

1. Stop any running smoke harness.
2. Delete `grantex-auth-smoke`.
3. Delete temporary Redis.
4. Delete temporary Cloud SQL.
5. Delete smoke-only secrets.
6. Delete smoke image tags if they are no longer needed.
7. Confirm production services, production DB, production Redis, production secrets, live payment flags, and live Plural settings were untouched.

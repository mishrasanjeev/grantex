# Grantex Commerce V1 Hosted Staging Plan

Status: historical M9 staging artifact; superseded by the current OACP authority mapping guide in docs/guides/oacp-runtime-authority-and-adapter-mappings.md. Do not deploy from this historical document.

This plan defines the hosted staging target for Grantex Commerce V1 so AgenticOrg can run the Commerce Sales Agent against real hosted sandbox endpoints before any production enablement. It intentionally excludes production config changes, live payment credentials, live Plural, production data, and production Commerce V1 rollout.

## Hard Boundaries

- Do not deploy, merge, or create cloud resources during M9.
- Do not change production config.
- Do not enable production Commerce V1.
- Do not enable live payments.
- Do not enable live Plural.
- Do not use production secrets.
- No production DB or Redis.
- Do not commit `.tmp`, synthetic env files, bearer tokens, passports, idempotency keys, provider credentials, or secrets.
- Keep staging public messaging clear: staging is sandbox only and no live payment will be captured.

## Recommended Topology

| Component | Recommended staging target | Notes |
| --- | --- | --- |
| Auth/API | Cloud Run service `grantex-auth-staging` | Separate from production `grantex-auth`. |
| Portal | Firebase Hosting target `grantex-portal-staging` | If Firebase targets are unavailable, use a separate staging site or documented preview channel with a permanent staging domain. |
| API domain | `api-staging.grantex.dev` | Maps only to `grantex-auth-staging`. |
| Portal domain | `staging.grantex.dev` | Maps only to staging portal hosting. |
| Database | Dedicated staging Cloud SQL Postgres | No production clone with live customer data. Use sanitized seed data. |
| Cache | Dedicated staging Redis | No shared production Redis DB or key prefix. |
| Secrets | Dedicated staging Secret Manager secrets | Never mount production secret versions. |
| Commerce provider | Mock by default; optional Plural sandbox validation | Plural sandbox stays disabled unless sandbox credentials, `PLURAL_SANDBOX_ENABLED=true`, and scrubbed E2E evidence are approved for that staging run. |
| Metrics | Authenticated staging metrics | `METRICS_REQUIRE_AUTH=true`. |
| Reconciliation | Enabled after smoke passes | Start disabled for first deploy if needed, then set `COMMERCE_RECONCILIATION_WORKER_ENABLED=true`. |

The service should use a separate GCP project if available. If a separate project is not available, use a separate Cloud Run service, separate Cloud SQL instance/database, separate Redis instance, staging-only service account, staging-only Secret Manager names, and GitHub environment protection to prevent accidental production writes.

## Exact Non-Secret Environment Variables

Set these on `grantex-auth-staging` only:

```bash
NODE_ENV=staging
PUBLIC_BASE_URL=https://api-staging.grantex.dev
JWT_ISSUER=https://api-staging.grantex.dev
DID_WEB_DOMAIN=api-staging.grantex.dev
FIDO_RP_ID=staging.grantex.dev
FIDO_ORIGIN=https://staging.grantex.dev
CORS_ALLOWED_ORIGINS=https://staging.grantex.dev,https://staging.agenticorg.ai
COMMERCE_V1_ENABLED=true
COMMERCE_SANDBOX_ENABLED=true
COMMERCE_ALLOW_AUTO_TENANT=false
COMMERCE_LOCAL_LOAD_TEST=false
COMMERCE_LIVE_MODE_ENABLED=false
PLURAL_SANDBOX_ENABLED=false
PLURAL_LIVE_ENABLED=false
COMMERCE_RECONCILIATION_WORKER_ENABLED=true
COMMERCE_RECONCILIATION_INTERVAL_MS=300000
COMMERCE_RECONCILIATION_LIMIT=50
METRICS_ENABLED=true
METRICS_REQUIRE_AUTH=true
SSO_ALLOW_INSECURE_URLS=false
WEBHOOK_ALLOW_INSECURE_URLS=false
LDAP_TLS_REJECT_UNAUTHORIZED=true
```

Notes:

- `PLURAL_SANDBOX_ENABLED=false` stays false unless the staging run explicitly uses stored Plural sandbox credentials, approved callback URLs, webhook secret configuration, and scrubbed E2E evidence.
- `COMMERCE_V1_ENABLED=true` is permitted only on hosted staging. It is not approval to enable production Commerce V1.
- `COMMERCE_RECONCILIATION_WORKER_ENABLED=true` should be applied after health, JWKS, well-known, commerce smoke, and webhook smoke checks pass.
- Portal staging must point to `https://api-staging.grantex.dev`, not `https://grantex.dev` or the production API.

## Required Secrets By Name Only

Create staging-only secret values with these names or documented staging-prefixed equivalents:

- `DATABASE_URL`
- `REDIS_URL`
- `ADMIN_API_KEY`
- `VAULT_ENCRYPTION_KEY`
- `RSA_PRIVATE_KEY`, if fixed app JWT signing is used
- `ED25519_PRIVATE_KEY`, if DID/signing paths are enabled
- `SSO_STATE_SECRET`
- `METRICS_API_KEY`
- `RESEND_API_KEY`, if staging email/OTP is enabled
- `MOCK_PAYMENT_WEBHOOK_SECRET`
- Commerce Passport signing key material, according to the existing key path

Secret rules:

- Use staging-only values and staging-only IAM bindings.
- Do not copy production secret versions.
- Do not place secret values in docs, `.env`, workflow YAML, logs, PR comments, or local report files.
- Do not commit local `.tmp` evidence or synthetic env files.

## CI/CD Plan

Create manual `workflow_dispatch` staging deploy workflows only after this plan is approved. Do not alter the existing production deploy behavior as part of M9.

Recommended Grantex workflows:

- `deploy-auth-staging.yml`: build `apps/auth-service`, push a staging image, deploy Cloud Run service `grantex-auth-staging`.
- `deploy-portal-staging.yml`: build the portal, deploy Firebase Hosting target `grantex-portal-staging` or the documented alternative staging site.

GitHub environment:

- Environment name: `staging`.
- Required reviewers: at least one repository maintainer.
- Branch/source restriction: allow `main`, approved release branches, and explicitly named staging branches only.
- Environment secrets: staging-only GCP workload identity/provider/service account and staging-only app secrets.
- Require manual `workflow_dispatch`; do not deploy staging from arbitrary pushes initially.

No-production guardrails:

- Reject `GCP_PROJECT_ID=grantex-prod` unless the staging service names and staging domains are explicitly present.
- Reject Cloud Run service names other than `grantex-auth-staging`.
- Reject Firebase Hosting live production site deploys from staging workflows.
- Reject env where `PUBLIC_BASE_URL` is `https://grantex.dev`.
- Reject env where `COMMERCE_LIVE_MODE_ENABLED` or `PLURAL_LIVE_ENABLED` is set to true, or where live provider credential names are present.
- Run smoke checks against only `https://api-staging.grantex.dev` and `https://staging.grantex.dev`.

Post-deploy smoke checks:

- `GET https://api-staging.grantex.dev/health`
- `GET https://api-staging.grantex.dev/.well-known/jwks.json`
- `GET https://api-staging.grantex.dev/.well-known/commerce`
- MCP initialize, `tools/list`, and representative `tools/call`
- Portal load at `https://staging.grantex.dev`
- Commerce smoke sequence in the checklist below

Rollback commands:

```bash
gcloud run revisions list --service grantex-auth-staging --region <region> --project <staging-project>
gcloud run services update-traffic grantex-auth-staging --to-revisions <previous-revision>=100 --region <region> --project <staging-project>
firebase hosting:clone <staging-project>:<bad-version> <staging-project>:<previous-version> --site grantex-portal-staging
```

Rollback must not target production services or production Firebase sites.

## Staging E2E Checklist

Run these checks only after the staging services, DNS, database, Redis, and secrets exist:

- Health endpoint.
- JWKS endpoint.
- Commerce well-known endpoint.
- MCP initialize.
- MCP `tools/list`.
- MCP `tools/call`.
- AgenticOrg health.
- AgenticOrg MCP discovery.
- AgenticOrg A2A discovery.
- Catalog search.
- Catalog get item.
- Inventory check.
- Cart create.
- Consent request.
- Passport exchange.
- Payment intent create.
- Checkout create.
- Mock webhook paid.
- Mock webhook failed.
- Mock webhook expired.
- Duplicate webhook produces no double transition.
- Manual reconciliation.
- Audit timeline.
- Portal payments, audit, passports, settings, and ops views.
- AgenticOrg demo/eval against real staging endpoints.
- Negative case: denied consent.
- Negative case: missing consent.
- Negative case: revoked or expired passport.
- Negative case: amount cap.
- Negative case: disabled merchant.
- Negative case: untrusted agent.
- Negative case: stale inventory.
- Negative case: unsupported EMI, discount, or warranty.
- Negative case: invalid webhook signature.

The payment state smoke must verify the M8 alignment: mock payment intent returns `authorized`, checkout creation accepts `authorized`, and checkout advances `authorized -> checkout_created -> payment_pending`.

## Security Controls

- Restrict staging console access with a staging IAM group.
- Prefer a separate staging GCP project.
- Use a staging service account with only Cloud Run, Secret Manager, Cloud SQL, Redis, logging, and metrics permissions required by staging.
- Use Secret Manager names and IAM bindings that cannot read production secrets.
- Use dedicated staging Postgres and Redis.
- Use sanitized seed data only.
- Keep logs redacted for Authorization headers, passports, idempotency keys, provider IDs, webhook signatures, and secret names where appropriate.
- Enable rate limits on staging API endpoints.
- Require authenticated metrics with `METRICS_REQUIRE_AUTH=true`.
- Keep `SSO_ALLOW_INSECURE_URLS=false`, `WEBHOOK_ALLOW_INSECURE_URLS=false`, and `LDAP_TLS_REJECT_UNAUTHORIZED=true`.
- Block live provider credentials and live payment flags.
- Keep public UI copy clear that staging is sandbox only.
- Keep rollback scoped to staging service names and staging hosting target.

## Cost And Ops Notes

Expected services:

- 1 Cloud Run auth/API service.
- 1 Firebase Hosting staging target or alternate staging site.
- 1 staging Cloud SQL Postgres instance/database.
- 1 staging Redis instance.
- Staging Secret Manager entries.
- Staging logs and metrics.

Suggested minimums:

- Cloud Run min instances: `0` before formal pilot; consider `1` during scheduled demos.
- Cloud Run max instances: low cap such as `3` to `5` until load goals are defined.
- Cloud SQL: smallest HA decision that matches budget; non-HA is cheaper but has weaker availability evidence.
- Redis: smallest tier that supports test concurrency.
- Logs: set a shorter staging retention window than production.

Cleanup if temporary:

- Remove staging DNS records.
- Disable or delete staging Cloud Run services.
- Delete staging Firebase target/site only after preserving any required audit evidence.
- Delete staging database/Redis after export or explicit evidence retention decision.
- Destroy staging Secret Manager values.
- Remove staging GitHub environment secrets.

Risk/cost tradeoffs:

- A separate GCP project costs more setup time but sharply reduces blast radius.
- Non-HA Cloud SQL is cheaper but weakens failover evidence.
- Min instances `0` saves money but can add cold-start noise to demos and smoke tests.
- Public staging is easier for AgenticOrg E2E but needs stronger auth/rate limits; access-gated staging is safer but adds setup and demo friction.

## Blockers And Questions Before Implementation

- Confirm whether a separate GCP project exists for staging or must be created.
- Confirm whether `api-staging.grantex.dev` and `staging.grantex.dev` DNS can be configured.
- Confirm whether staging Cloud SQL and Redis budget is approved.
- Confirm whether GitHub environments, protection rules, and environment secrets can be created.
- Confirm whether Firebase Hosting can use target `grantex-portal-staging`; otherwise choose the documented alternative site/channel.
- Confirm whether staging should be public with auth/rate limits or IP/access-gated.
- Confirm whether staging email/OTP is needed; if not, omit `RESEND_API_KEY`.
- Confirm which existing Commerce Passport signing key path will be used in staging.
- Confirm whether Plural sandbox should remain disabled or be enabled only for a dedicated credentialed sandbox validation.

## Implementation Sequence For M10+

1. Create or identify the staging GCP project and staging GitHub environment.
2. Configure staging domains and DNS.
3. Provision dedicated staging Postgres and Redis.
4. Create staging-only secrets in Secret Manager and GitHub environment secrets.
5. Add manual staging deploy workflows with no-production guardrails.
6. Deploy `grantex-auth-staging` by manual approval.
7. Run health, JWKS, commerce well-known, and MCP smoke checks.
8. Deploy portal staging by manual approval.
9. Run portal smoke checks.
10. Enable reconciliation worker only after initial commerce smoke passes.
11. Run the full staging E2E checklist with AgenticOrg.
12. Record evidence in a staging readiness report without committing secret values or local temp files.

## M9 Confirmation

No deploy was performed. No merge was performed. No production config was changed. No production Commerce V1 flag was enabled. No live payment or live Plural path was enabled. No cloud resources were created by this planning document.

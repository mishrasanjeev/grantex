# Sub-processor Disclosure

**Status:** Current public disclosure. Subject to legal review. Not a certification document.
**Last reviewed:** 2026-05-24

This list enumerates the third-party services Grantex's maintainers use to operate the public hosted endpoints (`api.grantex.dev`, `grantex.dev`, `docs.grantex.dev`) and the SaaS tooling that supports the project. **Self-hosted Grantex deployments do not transit any of these sub-processors unless the operator opts in** — the open-source release runs entirely on infrastructure of the operator's choosing.

Every entry below is derived from artifacts inside this repository (deploy scripts, Helm charts, Docker Compose files, GitHub workflows, package dependencies). Items the repository does not evidence are marked **TBD**.

## Production runtime sub-processors (hosted Grantex)

| Sub-processor | Service | Purpose | Data categories | Location | Evidence |
|---|---|---|---|---|---|
| Google LLC | Google Cloud Run | Stateless auth-service compute | All API request/response payloads | `us-central1` (US) | `deploy/gcp/setup.sh` (`run.googleapis.com`, `CR_SERVICE="grantex-auth"`) |
| Google LLC | Google Cloud SQL for PostgreSQL 16 | Primary datastore — agents, grants, audit, commerce state | All persisted application data | `us-central1` (US) | `deploy/gcp/setup.sh` (`sqladmin.googleapis.com`, `SQL_INSTANCE="grantex-pg16"`) |
| Google LLC | Google Memorystore for Redis | Rate-limit counters, idempotency keys, short-lived caches | Request metadata; no PII at rest beyond TTL | `us-central1` (US) | `deploy/gcp/setup.sh` (`redis.googleapis.com`, `REDIS_INSTANCE="grantex-redis"`) |
| Google LLC | Google Artifact Registry | Container image hosting for auth-service builds | Build artifacts, no customer data | `us-central1` (US) | `deploy/gcp/setup.sh` (`artifactregistry.googleapis.com`, `AR_REPO="grantex-images"`) |
| Google LLC | Google Secret Manager | Runtime secrets for `api.grantex.dev` | Vault encryption key, signing keys, third-party API keys | `us-central1` (US) | `deploy/gcp/setup.sh` (`secretmanager.googleapis.com`) |
| Google LLC | Google Cloud DNS | DNS hosting for `grantex.dev` zone | DNS records only | Global (Google anycast) | `deploy/gcp/dns.sh`, `deploy/gcp/setup.sh` (`dns.googleapis.com`) |
| Google LLC | Firebase Hosting | Static marketing site (`grantex.dev`, `web/`) | No PII; CDN access logs only | Google CDN, global | `firebase.json` |
| GitHub, Inc. (Microsoft) | GitHub | Source control, issue tracking, GitHub Actions CI/CD, GitHub Security Advisories | Code, build artifacts, vulnerability reports | US (GitHub-managed) | `.github/workflows/*.yml`, project hosted at `github.com/mishrasanjeev/grantex` |

## Optional sub-processors (only when feature-flagged on)

The following providers are integrated in code but **disabled by default**; operators must explicitly enable them with the listed environment variables.

| Sub-processor | Service | Purpose | Enabled by | Evidence |
|---|---|---|---|---|
| Stripe, Inc. | Stripe | Subscription billing for paid plans | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | `docker-compose.yml:59-63`, `apps/auth-service/src/config.ts` |
| Anthropic, PBC | Datadog (when configured as anomaly destination) | Anomaly alerting and metric forwarding | `ANOMALY_DESTINATIONS` env containing `datadog` (operator-supplied API key) | README anomaly section; `packages/destinations` Datadog adapter |
| Amazon Web Services, Inc. | AWS S3 | Audit log export destination (immutable archive) | `AUDIT_DESTINATIONS` containing `s3` | `packages/destinations/package-lock.json` (`@aws-sdk/client-s3`) |
| Google LLC | Google BigQuery | Audit log export destination (analytics) | `AUDIT_DESTINATIONS` containing `bigquery` | `packages/destinations/package-lock.json` (`@google-cloud/bigquery`) |
| Apache Kafka operators | Kafka (operator-managed) | Audit/event streaming | `AUDIT_DESTINATIONS` containing `kafka` | `packages/destinations/package-lock.json` (`kafkajs`) |
| Cloud Native Computing Foundation | OpenTelemetry collector (operator-managed sink) | Traces/metrics export | `OTEL_EXPORTER_OTLP_ENDPOINT` | `apps/auth-service/src/config.ts:51`, `deploy/helm/grantex/values.yaml:114-119` |

## Notably *not* in use today

- **No transactional email provider configured.** TBD if SendGrid / Postmark / AWS SES is wired in for verification emails before public signup launch.
- **No SMS provider configured.**
- **No CRM, analytics, or session-replay tooling** (e.g., Segment, Mixpanel, FullStory) is referenced in the runtime code paths.
- **No third-party customer-support tool** is integrated into the hosted product.
- **No live payment processor.** Plural has a gated sandbox hosted-checkout adapter, but live Plural processing is fail-closed in code (`COMMERCE_LIVE_MODE_ENABLED` / `PLURAL_LIVE_ENABLED` default to off — see `apps/auth-service/src/lib/commerce/live-mode-guard.ts`).

## Change process

Adding a new sub-processor requires:

1. A PR that updates this file with the row, evidence path, and data categories.
2. A corresponding entry in the GitHub release notes for the version that introduces the dependency.
3. Existing customers receive at least 30 days' notice via the public CHANGELOG and a banner in the developer portal before the new processor begins receiving production data.

## Contact

Procurement and DPA questions: `security@grantex.dev` (see `SECURITY.md` for the canonical contact).

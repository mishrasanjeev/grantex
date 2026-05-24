# Data Residency Statement

**Status:** Current public disclosure. Subject to legal review. Not a certification document.
**Last reviewed:** 2026-05-24

This page describes where Grantex stores and processes customer data on the **hosted** offering (`api.grantex.dev`), and the residency choices available to operators running their **own** Grantex deployment.

## Hosted Grantex (`api.grantex.dev`) — single region today

All production-grade data for the hosted service is currently pinned to **Google Cloud `us-central1` (Council Bluffs, Iowa, USA)**. This is sourced from `deploy/gcp/setup.sh`:

```
REGION="us-central1"
SQL_INSTANCE="grantex-pg16"       → us-central1
REDIS_INSTANCE="grantex-redis"    → us-central1
AR_REPO="grantex-images"          → us-central1
CR_SERVICE="grantex-auth"         → us-central1
```

| Data class | Storage location | Notes |
|---|---|---|
| Agents, grants, audit, commerce records | Cloud SQL PostgreSQL, `us-central1` | Encrypted at rest by GCP (AES-256). Backups stored in the same region. |
| Rate-limit + idempotency state | Memorystore Redis, `us-central1` | TTL-bound, no long-lived PII. |
| Container images | Artifact Registry, `us-central1` | Build artifacts only. |
| Runtime secrets | Secret Manager, `us-central1` | Vault encryption key, JWT signing keys. |
| Marketing site (`grantex.dev`) | Firebase Hosting | Global CDN edge (Google anycast); origin in US. |
| DNS records | Cloud DNS | Global anycast. |

**Cross-border transfers.** Operating the hosted service from `us-central1` means that requests originating outside the United States cross a border at request time. Customer payloads are not replicated to other regions by Grantex.

## EU / India / multi-region availability

A multi-region offering (EU and India) is on the public roadmap (`ROADMAP.md`, item "Managed Cloud"). **It is not available today.** Until then:

- Customers with EU data-residency obligations under GDPR should evaluate the self-hosting option below.
- Customers with DPDP Act (India) "significant data fiduciary" obligations may require self-hosting to keep data within India. See `docs/compliance/dpdp-act-2023.mdx` for the technical control mapping.

## Self-hosted Grantex — operator-chosen residency

Grantex is Apache 2.0 and ships with a Helm chart (`deploy/helm/grantex/`) and Docker Compose stack (`docker-compose.prod.yml`). When you self-host, **the data never leaves the infrastructure you control** — Grantex maintainers receive no telemetry from your deployment by default.

Operator-controlled residency knobs:

- **Compute** — anywhere your Kubernetes cluster or container host runs.
- **PostgreSQL** — point `DATABASE_URL` at any Postgres 14+ instance in your region of choice.
- **Redis** — point `REDIS_URL` at any Redis 6+ instance in your region of choice.
- **Object storage destination** (optional audit export) — choose any S3-compatible bucket region.
- **OpenTelemetry sink** (optional) — point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector in your region.

See `docs/self-hosting.md` for the full operator runbook.

## Backup, retention, and deletion

- **Backups:** WAL-archive backups recommended per the Cloud SQL default policy on hosted; operator-defined on self-hosted. A formal backup/restore runbook is **TBD** as a follow-up doc.
- **Retention:** audit-log retention is operator-configurable; defaults documented in `apps/auth-service/src/config.ts`.
- **Deletion:** DPDP erasure flow (`/v1/dpdp/data-principals/:id/erasure`) and consent withdrawal flows are implemented in `apps/auth-service/src/routes/dpdp.ts`. Deletion propagates to the consent record, the associated grant, and audit-entry anonymization.

## Contact

Residency or transfer questions: `security@grantex.dev`.

# Commerce V1 C6P First Connector Sync Adapter Planning

Status: planned as an internal safe-foundation packet.

Base:

- Grantex main: `c8d995fea23f29a6aba4075de785bf671ca1d676`
- Connector registry foundation:
  `docs/internal/commerce-v1/commerce-v1-c6n-merchant-system-connectors.md`
- Release rehearsal gap assessment:
  `docs/internal/commerce-v1/commerce-v1-c6og-release-rehearsal-status-launch-gap-assessment.md`

C6P plans the first connector sync adapter without enabling runtime sync. This
packet is internal preview planning only. It is sandbox-only, non-live,
non-publication, non-certifying, and non-enabling. It does not add routes,
migrations, portal UI, production configuration, secrets, credentials, provider
credentials, public discovery, checkout or payment behavior, live payment
behavior, live Plural behavior, provider calls, merchant private API calls,
production allowlists, or runtime connector execution.

C6P does not add routes, workers, schedules, migrations, portal UI changes,
workflow changes, runtime APIs, connector execution, or sync jobs.

AgenticOrg never directly executes merchant private API calls. AgenticOrg can
only consume Grantex-grounded, read-only buyer discovery outputs from approved
Grantex surfaces; connector planning, connector registry, dry-run evidence, and
any later sync execution remain Grantex-owned.

## First Adapter Target

The first adapter target is a CSV/manual catalog dry-run adapter backed by test
doubles only.

Why this is the starting point:

- C6N already defines `manual` and `csv` connector registry types as the only
  runtime-implemented registry types.
- CSV/manual catalog dry-run can exercise source precedence, stale/conflict
  blockers, tenant boundaries, redaction, and audit evidence without contacting
  merchant private systems.
- It can use synthetic rows and local fixtures to prove sync planning posture
  before any real merchant, credential, scheduler, or outbound connector work is
  approved.

Out of scope for C6P:

- Shopify remains non-live and not called.
- WooCommerce remains non-live and not called.
- Magento remains non-live and not called.
- Custom API remains declaration-only and not called.
- ERP, billing, OMS, WMS, logistics, and CRM/support remain metadata-only and
  not called.
- Payment provider connectors remain metadata-only and not called.
- Plural, Stripe, Pine, payment providers, and merchant private APIs remain
  non-live and not called.

## Traceability

| Requirement | C6P planning surface | Review evidence |
| --- | --- | --- |
| Start with metadata, dry-run behavior, and test doubles only | CSV/manual dry-run adapter contract | C6P doc test and C6N connector tests |
| Keep AgenticOrg from direct merchant private API execution | Execution boundary section | C6P doc test and C6N caller-boundary tests |
| Keep Grantex connector work non-live | Runtime posture and stop conditions | Focused guardrail scans |
| Define source precedence | Source precedence model section | C6P doc test and C6N source-precedence tests |
| Define stale/conflict blockers | Blocker model section | C6P doc test and C6N stale/conflict tests |
| Define tenant boundaries | Tenant boundary section | C6P doc test and C6N tenant tests |
| Define credential redaction | Redaction section | C6P doc test and C6N private-field rejection tests |
| Define audit evidence | Dry-run evidence section | C6P doc test and future dry-run evidence tests |
| Define rollback and stop conditions | Rollback and stop-condition sections | C6P doc test |

## Metadata Contract

C6P does not create a new runtime API. A later approved implementation can use
the existing C6N connector registry rows as the source of connector metadata.

Required planning fields:

| Field | Source | Notes |
| --- | --- | --- |
| `tenant_id` | Existing authenticated tenant context | Must not cross tenants. |
| `merchant_id` | Existing merchant scope | Owning merchant or operator only. |
| `connector_key` | C6N registry | Safe lowercase key, not an internal secret. |
| `connector_type` | C6N registry | First target is `csv` or `manual`. |
| `runtime_mode` | C6N registry | Expected `csv_catalog_import` or `manual_catalog_api`. |
| `source_domains` | C6N registry | Catalog, price, and inventory first. |
| `source_priority` | C6N registry | Lower value wins within a source domain. |
| `sync_status` | C6N registry | Dry-run may propose status, not persist it without approval. |
| `health_state` | C6N registry | Stale/conflict states remain blockers. |
| `last_sync_at` | C6N registry | Evidence timestamp only. |
| `last_successful_sync_at` | C6N registry | Evidence timestamp only. |
| `stale_after_seconds` | C6N registry | Used for stale-source blocking. |
| `conflict_blockers` | C6N registry | Must be explicit safe blocker codes. |
| `audit_reference` | Commerce audit | Required for dry-run evidence. |

Forbidden planning fields:

- API keys
- access tokens
- refresh tokens
- passwords
- client secrets
- private keys
- provider credentials
- raw payloads
- raw merchant-system responses
- private URLs
- customer data
- DB or Redis URLs
- production config values
- concrete allowlist values

## Dry-Run Request Shape

The dry-run request shape is documentation only. It is not a route contract and
does not enable runtime behavior.

```json
{
  "mode": "dry_run",
  "adapter": "csv_manual_catalog_test_double",
  "tenant_scope": "<tenant_id>",
  "merchant_scope": "<merchant_id>",
  "connector_key": "csv_catalog_dry_run",
  "source_domains": ["catalog", "price", "inventory"],
  "input": {
    "fixture_ref": "synthetic-csv-catalog-v1",
    "rows_source": "test_double"
  },
  "controls": {
    "metadata_only": true,
    "test_double_only": true,
    "outbound_sync_enabled": false,
    "provider_call_enabled": false,
    "merchant_private_api_call_enabled": false,
    "agenticorg_direct_execution_enabled": false,
    "checkout_payment_enabled": false,
    "public_discovery_enabled": false,
    "production_config_written": false,
    "credential_material_accepted": false
  }
}
```

## Dry-Run Result Shape

The dry-run result shape is deterministic evidence for review. It must not be
treated as production approval.

```json
{
  "status": "blocked_or_preview",
  "mode": "dry_run",
  "adapter": "csv_manual_catalog_test_double",
  "connector_key": "csv_catalog_dry_run",
  "source_domains_checked": ["catalog", "price", "inventory"],
  "rows_seen": 3,
  "rows_accepted_for_preview": 3,
  "rows_rejected": 0,
  "source_precedence_preview": [
    {
      "domain": "catalog",
      "primary_connector_key": "csv_catalog_dry_run",
      "status": "preview"
    }
  ],
  "blockers": [
    "dry_run_only",
    "test_double_only",
    "outbound_sync_not_enabled",
    "agenticorg_direct_execution_not_allowed",
    "credentials_not_stored",
    "provider_call_not_enabled"
  ],
  "audit_evidence": {
    "event_type": "merchant.connector.dry_run.preview",
    "request_id": "<request_id>",
    "audit_reference": "<audit_event_id>",
    "redaction": "no credential material, raw payloads, private URLs, or customer data recorded"
  }
}
```

## Source Precedence Model

Dry-run source precedence must use the C6N source domains:

- catalog
- price
- inventory
- order
- fulfillment
- refund
- settlement
- support

The first C6P dry-run is allowed to plan catalog, price, and inventory only.
Order, fulfillment, refund, settlement, and support remain metadata-only
domains. They must carry an execution-domain blocker until a separate approved
runtime chain defines safe behavior.

Precedence rules:

1. Filter by tenant and merchant before comparing connectors.
2. Exclude disabled connectors from primary source selection.
3. Prefer lower `source_priority` values.
4. Break ties by `connector_key` for deterministic review output.
5. Mark a domain blocked when no source of truth is declared.
6. Mark a domain blocked when the primary source is stale or conflicted.
7. Do not promote a dry-run preview into persisted sync state without separate
   approval.

## Stale And Conflict Blockers

Dry-run planning must fail closed for:

- `source_of_truth_not_declared`
- `connector_disabled`
- `connector_health_stale`
- `last_sync_stale`
- `source_conflict_blocker`
- `sync_failed_blocker`
- `sync_status_blocked`
- `execution_domain_metadata_only`
- `custom_api_runtime_not_implemented`
- `external_connector_runtime_not_implemented`
- `payment_provider_execution_not_enabled`
- `agenticorg_direct_execution_not_allowed`
- `provider_call_not_enabled_by_registry`
- `credentials_not_stored_by_registry`

Blocked dry-run results must include remediation guidance, for example:

- declare a source of truth for the missing domain
- resolve conflicting connector priority
- refresh stale CSV/manual fixture evidence
- disable or remove a conflicted connector
- keep external connector runtime blocked until separately approved

## Tenant Boundary

The dry-run plan must preserve the C6N caller boundary:

- operator callers can review a tenant-scoped merchant connector plan
- owning merchant callers can review only their own merchant connector plan
- CommerceAgent callers are denied connector planning and management
- service callers are denied unless a future approved internal job model defines
  a constrained non-live dry-run role
- AgenticOrg callers are never allowed to execute merchant private API calls

Dry-run test doubles must not load data from another tenant or merchant. Any
tenant mismatch, merchant mismatch, missing merchant record, or cross-merchant
connector reference is a hard blocker.

## Credential Redaction

C6P does not introduce credential intake. The dry-run plan must reject
credential-like fields and values before evidence is written.

Redaction requirements:

- no credential values in request logs
- no credential values in audit metadata
- no credential values in dry-run JSON
- no raw merchant-system payloads
- no provider metadata
- no private URLs
- no customer data
- no DB or Redis URLs
- no production config values
- no concrete allowlist values

Credential fields remain blocked until a later approved credential handling
chain defines intake, encryption, rotation, access control, redaction, audit,
and rollback.

## Audit Evidence

Dry-run evidence should be deterministic, reviewable, and redacted.

Required audit evidence:

- tenant and merchant scope
- connector key and connector type
- adapter name
- dry-run mode
- source domains checked
- source precedence preview
- stale/conflict blocker list
- row counts or fixture counts
- redaction confirmation
- non-enabling controls
- request ID
- audit reference

Audit evidence must not include credentials, raw payloads, private URLs,
customer data, provider metadata, production config values, concrete allowlist
values, checkout URLs, payment IDs, live provider IDs, or direct merchant-system
responses.

## Real Merchant Launch Blockers

C6P does not approve real merchant launch. Real merchant launch remains blocked
until all of the following are reviewed and approved:

- real merchant source-system scope
- source-of-truth map for catalog, price, inventory, order, fulfillment, refund,
  settlement, and support
- credential intake, storage, rotation, and redaction process
- tenant-boundary evidence for real merchant connector configuration
- stale/conflict/source-precedence evidence
- dry-run audit evidence for the selected connector
- rollback and disablement procedure
- outbound sync approval
- provider approval where provider systems are involved
- public discovery approval
- production Commerce V1 approval
- checkout/payment approval
- live payment, live Plural, and live provider approval
- production allowlist approval

## Stop Conditions

Stop and require a new approved work item if any C6P follow-up:

- adds a runtime sync route, worker, scheduler, migration, or portal UI
- stores, prints, or accepts real connector credentials
- calls Shopify, WooCommerce, Magento, custom APIs, ERP, billing, OMS, WMS,
  logistics, CRM/support, payment providers, Plural, Stripe, Pine, or merchant
  private APIs
- allows AgenticOrg to call merchant private systems directly
- writes production configuration or production allowlists
- sets public discovery flags or allowlist values
- enables Grantex public discovery or AgenticOrg public commerce discovery
- enables production Commerce V1
- enables checkout/payment creation, public checkout, fulfillment execution,
  refund execution, live payments, live Plural, or live providers
- exposes secrets, provider metadata, raw payloads, customer data, private URLs,
  private commerce IDs, production config values, or concrete allowlist values
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, protocol-publication, or
  live-payment certification
- treats sandbox, demo, synthetic, fixture, dry-run, or rehearsal output as
  production approval
- requires cloud commands, cloud resources, manual deploys, or manual deploy
  workflow triggers

## Rollback

C6P is docs and tests only. Rollback is limited to removing:

- `docs/internal/commerce-v1/commerce-v1-c6p-first-connector-sync-adapter-planning.md`
- `apps/auth-service/tests/commerce-c6p-connector-sync-planning.test.ts`

There are no runtime routes, workers, schedules, migrations, portal UI changes,
production config changes, secrets, credentials, public discovery settings,
checkout/payment behavior, live provider behavior, production allowlists, cloud
resources, or deployment workflow changes to roll back.

## Validation

C6P validation should include:

- `npm --prefix apps/auth-service test -- commerce-connectors-c6n.test.ts commerce-c6p-connector-sync-planning.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  live Plural/provider credentials, certification claims, direct provider calls,
  direct merchant private API calls, AgenticOrg direct execution, and outbound
  sync enablement

Expected scan hits should be limited to stop-condition text, denylist regex
literals, negative assertions, or explicit disabled-control examples.

# Commerce V1 C6Q Sandbox E2E Test Merchant Rehearsal

Status: implemented as an executable local sandbox rehearsal with fake public
test data.

Base:

- Grantex C6P draft base:
  `codex/commerce-c6p-connector-sync-adapter-planning`
- C6P planning packet:
  `docs/internal/commerce-v1/commerce-v1-c6p-first-connector-sync-adapter-planning.md`

C6Q creates a deterministic sandbox E2E rehearsal for a fake merchant and fake
catalog data. It does not approve production launch. It is sandbox-only,
non-live, non-public, not allowlisted, not production-approved, non-certifying,
and non-enabling. It does not add runtime routes, migrations, portal UI,
production configuration, secrets, credentials, public discovery, checkout or
payment behavior, live payment behavior, live Plural behavior, provider calls,
merchant private API calls, production allowlists, or public protocol
publication.

Do not approve production launch from C6Q rehearsal evidence.

## Fake Data Source

C6Q uses a checked-in fixture snapshot under:

`docs/internal/commerce-v1/fixtures/c6q-sandbox-e2e/dummyjson-homegoods-products.snapshot.json`

The fixture is based on the public DummyJSON products API shape and is marked as
`public_fake_catalog`. DummyJSON describes its products endpoint as fake product
data for testing and prototyping. Automated tests do not call DummyJSON or any
external network. The fixture contains only synthetic product names, synthetic
SKU values, public fake image URLs, and no real merchant identity, address,
phone, email, tax ID, GST/PAN, catalog, brand, credential, token, raw payload,
provider metadata, production config, or allowlist value.

The optional live source reference is:

- `https://dummyjson.com/docs/products`

## Test Merchant

| Field | Value |
| --- | --- |
| Merchant name | DummyJSON Home Goods Sandbox Store |
| Merchant ID | `mch_sandbox_dummyjson_homegoods_0001` |
| Tenant ID | `cten_sandbox_dummyjson_homegoods_0001` |
| Requested category | `home_furniture` |
| Runtime category | `electronics_appliances` |
| Status | `sandbox_only`, `not_live`, `not_approved`, `not_public`, `not_allowlisted` |

home_furniture is not implemented in the current Grantex runtime. C6Q uses
`electronics_appliances` only because it is the only supported runtime category
preset. The mismatch is documented in the fixture and does not approve the
merchant for public launch or production use.

## Rehearsal Flow

The C6Q test executes the safe flow locally:

1. Load the sandbox test merchant fixture.
2. Load the stable DummyJSON-style fake product fixture.
3. Normalize products into Grantex agent-preview product and variant shape.
4. Compute category, catalog, and sandbox onboarding checks.
5. Generate the public-safe agent-facing preview.
6. Compute read-only discovery review eligibility.
7. Record synthetic audit snapshots for review request and operator decision.
8. Compute rollout proposal dry-run evidence.
9. Record synthetic audit snapshot for AgenticOrg handoff request.
10. Produce the Grantex AgenticOrg buyer discovery preview payload.
11. Simulate AgenticOrg buyer session consumption from the Grantex payload.
12. Return grounded read-only discovery responses.
13. Refuse checkout, payment, live provider, live Plural, fulfillment, and
    refund/return requests.
14. Keep the C6Oe conformance gate available for PR validation.
15. Produce evidence only inside test memory or local `.tmp` validation output.
16. Confirm no production, live, public, or allowlist action occurred.

## Guardrails

C6Q keeps these controls false:

- `public_discovery_enabled`
- `agenticorg_public_discovery_enabled`
- `checkout_payment_enabled`
- `live_provider_enabled`
- `live_plural_enabled`
- `production_allowlist_written`
- `outbound_sync_enabled`
- `provider_call_enabled`
- `merchant_private_api_call_enabled`
- `agenticorg_direct_execution_enabled`

AgenticOrg never directly calls merchant private APIs. The test models
AgenticOrg as a read-only consumer of the Grantex buyer discovery preview.

## Blocker Handling

The rehearsal validates blockers for:

- missing category mapping
- missing price
- unsafe image URL
- unsupported category
- stale source timestamp
- private field in source

Negative source examples are constructed inside the test and are not committed
as fixture catalog data.

## Audit Evidence

Synthetic local audit evidence covers:

- `merchant.sandbox_fixture.created`
- `merchant.connector.catalog_dry_run.preview`
- `merchant.agent_facing_preview.generated`
- `merchant.sandbox_onboarding.read_only_discovery_review.requested`
- `merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready`
- `merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed`
- `merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested`

Audit metadata is public-safe and redacted. It records fixture counts, status,
blockers, and non-enabling controls only.

## Stop Conditions

Stop and require a new approved work item if any follow-up:

- uses a real merchant scraped from the web
- uses a real merchant name, real address, real phone, real email, tax ID,
  GST/PAN, real catalog, or real brand as production approval
- calls DummyJSON, FakeStoreAPI, payment providers, provider APIs, or merchant
  private APIs from automated tests
- stores or logs credentials, tokens, secrets, raw payloads, private URLs,
  provider metadata, customer data, production config, or concrete allowlists
- enables Grantex public discovery or AgenticOrg public commerce discovery
- enables production Commerce V1
- enables checkout/payment creation, fulfillment execution, refund execution,
  live payments, live Plural, or live providers
- sets public discovery flags or production allowlists
- publishes public protocol materials
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, protocol-publication,
  or live-payment certification
- treats sandbox, demo, synthetic, fixture, dry-run, or rehearsal evidence as
  production approval
- requires cloud commands, cloud resources, manual deploys, or manual deploy
  workflow triggers

## Validation

C6Q validation should include:

- `npm --prefix apps/auth-service test -- commerce-connectors-c6n.test.ts commerce-c6p-connector-sync-planning.test.ts commerce-c6q-sandbox-e2e-test-merchant.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  live Plural/provider credentials, certification claims, direct provider calls,
  direct merchant private API calls, real merchant names/addresses/phones/emails
  and tax IDs, and synthetic/test IDs proposed as production candidates

Expected scan hits should be limited to stop-condition text, denylist regex
literals, negative test assertions, or explicit disabled-control examples.

## Rollback

C6Q is docs, fixture, and tests only. Rollback is limited to removing:

- `docs/internal/commerce-v1/commerce-v1-c6q-sandbox-e2e-test-merchant.md`
- `docs/internal/commerce-v1/fixtures/c6q-sandbox-e2e/dummyjson-homegoods-products.snapshot.json`
- `apps/auth-service/tests/commerce-c6q-sandbox-e2e-test-merchant.test.ts`

No runtime route, migration, worker, schedule, portal UI, production config,
secret, credential, public discovery setting, checkout/payment behavior, live
provider behavior, production allowlist, cloud resource, or deployment workflow
is created by this slice.

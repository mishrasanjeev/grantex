# Commerce V1 Open Protocol Packaging Draft

Status: internal packaging draft only.

Created: 2026-06-07.

This draft packages the merged Agentic Commerce C6I-C6N product-chain PRs for
internal open-protocol review. It is not public protocol publication, not
schema.org publication, not UCP certification, not ACP certification, not AP2
certification, not provider certification, not production approval, not public
discovery approval, and not checkout or payment approval.

This draft does not deploy, merge, create cloud resources, change production
configuration, touch secrets, enable public discovery, enable production
Commerce V1, enable checkout or payment creation, enable live payments, call
providers, call merchant private APIs, or claim certification.

## Merged Base

The packaging draft is based only on these reviewed and merged PRs. Where a
slice was rebased or fixed during review, the table records the final merged PR
head and the merge commit now present on the owning repository's `main` branch.

| Slice | Repo | PR | Final PR head SHA | Merge commit SHA | Packaging role |
| --- | --- | --- | --- | --- | --- |
| C6I buyer session orchestration | AgenticOrg | https://github.com/mishrasanjeev/agentic-org/pull/718 | `787b56c621ee5cb8d4ce4321056844ae25280fa0` | `d02657be67c4be256cd1f0b3d52d46e20c5de891` | Buyer-agent read-only session wrapper, intent classification, channel-neutral response, grounded refusal model. |
| C6J schema.org preview adapter | Grantex | https://github.com/mishrasanjeev/grantex/pull/511 | `ac90162ca0aee9a1e955fb70f388f6634b0e5d68` | `54eca8eb43a3b196f9a15958567aa44f24fc0521` | Public-safe schema.org JSON-LD preview from canonical merchant/catalog/readiness state. |
| C6K UCP-style capability profile preview | Grantex | https://github.com/mishrasanjeev/grantex/pull/512 | `c8eedb2dff57763bfc87c76009f849084f0f2abd` | `9d2a69b72756f28093c222796c8de822ab5ce0c3` | Grantex-owned UCP-style preview metadata under `dev.grantex.commerce.discovery.preview`. |
| C6L ACP-style checkout shape preview | Grantex | https://github.com/mishrasanjeev/grantex/pull/513 | `cd0da84f6e08c4dd4d3d4e16dfb739c97f6da5ff` | `f606fc0963ba3622c7ab46b33b12637fa8d45485` | Sandbox-only cart and checkout shape mappings with explicit blockers. |
| C6M AP2-style evidence preview | Grantex | https://github.com/mishrasanjeev/grantex/pull/514 | `d3a2e521b1fa7bb81f3629c61d0c3bc4554ed364` | `38af5020fa7a5e4b24cdedc49194d0a2894677d0` | Deterministic unsigned AP2-style evidence preview from canonical consent, passport, policy, cart, payment, agent, and audit state. |
| C6N connector foundation | Grantex | https://github.com/mishrasanjeev/grantex/pull/515 | `50efe65b6806d03e7ed3896b1da418580769b4f6` | `488505e19a4283d875c3a88a760e8b752c288403` | Existing-system connector registry foundation, metadata-only, non-executing, tenant-scoped. |

Repository tips after the merged product-chain stack:

- AgenticOrg main after C6I: `d02657be67c4be256cd1f0b3d52d46e20c5de891`
- Grantex main after C6N: `488505e19a4283d875c3a88a760e8b752c288403`

## Packaged Preview Surface

### Buyer Session Envelope

Source: AgenticOrg C6I.

The buyer session surface is channel-neutral and may be adapted for ChatGPT,
Claude, Gemini, WhatsApp, Telegram, web chat, and future channels. The package
includes the response fields needed by all channels:

- status
- message
- merchant preview
- catalog samples
- allowed capabilities
- blocked capabilities
- source reference
- refusal code
- evidence summary

The buyer session is read-only. Checkout, payment, live-provider, fulfillment,
refund, return, replacement, chargeback, and unsupported actions must return a
refusal and must not call providers or merchant systems.

### Grantex Schema.org JSON-LD Preview

Source: Grantex C6J.

The schema.org adapter is packaged as historical-preview JSON-LD generated from
canonical Grantex merchant, catalog, and readiness state. It may include only
safe Product, Offer, MerchantReturnPolicy, and OfferShippingDetails fields when
evidence exists.

It must not expose tenant IDs, merchant IDs, product IDs, variant IDs, SKUs,
private merchant data, secrets, provider metadata, raw payloads, allowlists, or
production configuration.

Publication remains blocked:

- `schemaorg_publication_enabled: false`
- `publication_status: not_published`
- `certification_claims: []`

### Grantex UCP-Style Capability Profile Preview

Source: Grantex C6K.

The UCP-style package uses Grantex-owned preview identifiers only. The namespace
for services, capabilities, and transports is:

`dev.grantex.commerce.discovery.preview`

The package must not publish `dev.ucp.*`, must not claim UCP certification, and
must not present preview metadata as certified external capability metadata.

Controls remain blocked:

- `ucp_publication_enabled: false`
- `ucp_certification_claim: none`
- `certified_ucp_namespace_published: false`
- `certified_capabilities_published: false`
- `commerce_v1_runtime_enabled_by_preview: false`

### Grantex ACP-Style Cart And Checkout Shape Preview

Source: Grantex C6L.

The ACP-style package maps cart and checkout concepts to existing Grantex
sandbox foundations. It is a shape historical preview state. It does not create payment
intents, checkout links, public checkout sessions, provider calls, live payment
flows, refunds, returns, or fulfillment actions.

Controls remain blocked:

- `acp_publication_enabled: false`
- `acp_certification_claim: none`
- `public_checkout_enabled: false`
- `payment_intent_creation_enabled_by_preview: false`
- `checkout_link_creation_enabled_by_preview: false`
- `provider_call_enabled_by_preview: false`
- `live_payment_enabled_by_preview: false`

Missing consent, passport, policy, cart, or payment-intent evidence must appear
as explicit blockers. Unsupported fields must remain explicit blockers.

### Grantex AP2-Style Evidence Preview

Source: Grantex C6M.

The AP2-style package is deterministic and unsigned. It is an evidence preview
from Commerce Passport, consent record, policy decision, cart hash, amount cap,
merchant state, agent identity, audit reference, and idempotency/replay evidence
where available.

It is not AP2 certification, not AP2 publication, not payment-network
submission, not a signed production mandate, and not a provider approval.

Controls remain blocked:

- `ap2_publication_enabled: false`
- `ap2_certification_claim: none`
- `ap2_signed_mandate_created: false`
- `signed_production_mandate_created: false`
- `signature_status: unsigned_preview`
- `payment_network_submission_enabled: false`
- `checkout_payment_creation_enabled_by_preview: false`

### Merchant Existing-System Connector Registry

Source: Grantex C6N.

The connector package describes how merchants declare existing systems without
letting AgenticOrg call those systems directly. Supported metadata connector
types are:

- manual
- CSV
- custom API
- Shopify
- WooCommerce
- Magento
- ERP
- billing
- OMS
- WMS
- logistics
- CRM/support
- payment provider

The source precedence domains are:

- catalog
- price
- inventory
- order
- fulfillment
- refund
- settlement
- support

The registry is metadata-only. It must not store credentials, call providers,
call merchant private APIs, enable outbound sync, enable AgenticOrg direct
execution, enable public discovery, write production configuration, or enable
checkout/payment execution.

Controls remain blocked:

- `metadata_only_registry: true`
- `credentials_stored_by_registry: false`
- `outbound_sync_enabled_by_registry: false`
- `agenticorg_direct_execution_allowed: false`
- `provider_call_enabled_by_registry: false`
- `checkout_payment_enabled_by_registry: false`
- `live_payment_enabled_by_registry: false`
- `public_discovery_enabled_by_registry: false`
- `production_config_written_by_registry: false`

## Cross-Protocol Contract

Every packaged artifact must include or inherit these facts:

- historical-preview
- sandbox-only where runtime state is involved
- tenant-scoped
- Grantex-grounded
- non-publication
- non-certifying
- non-live
- non-enabling
- no provider calls
- no merchant private API calls from AgenticOrg
- no secrets, credentials, raw payloads, provider metadata, allowlists, or
  production configuration

## Publication Blockers

Public publication is blocked until all of these have explicit approval:

1. Governance accepts the final packaging PR or merged base.
2. Legal/product/security approve public protocol publication.
3. Public discovery rollout is separately approved.
4. Production Commerce V1 enablement is separately approved.
5. Checkout/payment creation is separately approved.
6. Live-provider and live-payment approvals are separately granted.
7. Certification claims are backed by independent conformance or certification
   evidence.
8. Merchant-specific public data has production approval and is not synthetic,
   sandbox, demo, or private.
9. AgenticOrg public discovery remains disabled until a future approved rollout.
10. AgenticOrg continues to avoid direct calls to providers and merchant private
    APIs.

## Stop Conditions

Stop packaging or publication work immediately if any future change:

- sets `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- sets `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- sets production allowlists
- enables AgenticOrg public discovery
- enables production Commerce V1
- enables checkout or payment creation in production
- enables public checkout
- enables live payment
- enables live provider execution
- stores real credentials in repository, logs, fixtures, docs, or examples
- calls Plural, Stripe, Pine, a payment provider, or a merchant private API
  directly from AgenticOrg
- claims schema.org, UCP, ACP, AP2, MPP, A2A, provider, or production
  certification
- treats sandbox, demo, synthetic, or test data as production approval

## Rollback Notes

This package is documentation and preview manifest only. To roll it back, revert
the packaging branch or remove:

- `docs/internal/commerce-v1/commerce-v1-open-protocol-packaging-draft.md`
- `docs/internal/commerce-v1/open-protocol-packaging-manifest.preview.json`

No runtime flags, production configuration, provider credentials, merchant
connector credentials, public discovery settings, or cloud resources are created
by this package.

## Readiness Result

Internal packaging draft: GO.

Public protocol publication: NO-GO.

Production discovery, production checkout/payment, live providers, live
payments, provider calls, merchant private API execution, and certification
claims remain blocked.

## Next Remediation Prompt

```text
Task: Plan Agentic Commerce C6O conformance fixtures and first real connector sync adapter foundation.

Do not deploy, run cloud commands, create cloud resources, change production config, touch secrets, enable public discovery, enable production Commerce V1, enable checkout/payment creation, enable live payments, call providers, call merchant private APIs from AgenticOrg, or claim certification.

Use the merged C6I-C6N base: AgenticOrg PR #718 and Grantex PRs #511-#515. Define C6O reviewable slices for preview conformance fixtures, schema/manifest validators, and the first safe real connector sync adapter plan. Keep all artifacts sandbox-only, historical-preview, non-live, non-publication, and non-certifying. For connector sync, start with metadata, dry-run, stale/conflict blockers, tenant boundaries, credential redaction, and test doubles before any live merchant-system call.
```

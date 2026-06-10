# Commerce V1 C6M AP2-Style Evidence Preview

Status: implemented as preview-only foundation.

This slice adds an authenticated AP2-style evidence preview for review before
open protocol packaging. It does not claim AP2 certification, does not publish
AP2 capabilities, does not create or sign a production mandate, does not submit
to a payment network, does not enable public discovery, does not enable
production Commerce V1, does not create checkout or payment paths, does not
enable live payments, does not enable live Plural, does not call providers,
does not expose provider credentials or provider metadata, does not write
production configuration, and does not set allowlists.

## Traceability

| Requirement | Implementation | Validation |
| --- | --- | --- |
| Add AP2-style evidence preview from canonical state | `readAp2EvidencePreview` reads tenant-scoped Commerce Passport, consent, policy, cart hash, amount cap, merchant state, agent, audit, and idempotency evidence. | `commerce-merchants.test.ts` preview success case. |
| Keep preview unsigned and non-certified | Response sets `signature_status: unsigned_preview`, `ap2_certification_claim: none`, and all publication/submission/signing controls to `false`. | Route and OpenAPI assertions. |
| Include replay and idempotency evidence where supported | Preview summarizes cart, payment intent, and audit idempotency hash presence without exposing raw keys. | Route assertions. |
| No private leakage | Service emits public-safe text, booleans, counts, safe hashes, and redaction flags only. | Negative leakage assertions and guardrail scans. |
| Sandbox/non-live only | Live merchants return `409 ap2_evidence_preview_live_merchant_blocked`. | Live merchant route test. |

## Endpoint

`GET /v1/commerce/merchants/{merchant_id}/ap2-evidence-preview`

Allowed callers:

- operator
- owning merchant

Denied callers:

- CommerceAgent
- service caller
- merchant for a different merchant ID

Live merchants return `409 ap2_evidence_preview_live_merchant_blocked`.
Sandbox merchants with missing evidence receive a blocked preview with explicit
evidence blockers and remediation.

## Preview Rules

The preview may include:

- deterministic unsigned evidence package metadata
- safe merchant state summary
- Commerce Passport presence, scopes, amount cap, and revocation/expiry status
- consent status, approved scope counts, amount cap, and hash presence
- policy decision hash and policy amount cap summary
- cart snapshot hash, total amount, currency, and line-item count
- agent reference hash and trust status
- audit reference hash and audit idempotency hash presence
- payment intent status and sandbox provider environment
- non-enabling controls, blockers, remediation, and evidence summary

The preview must not include:

- tenant IDs
- exact merchant IDs
- passport JTIs
- consent record IDs
- audit event IDs
- agent IDs
- cart IDs
- payment intent IDs
- provider payment IDs
- provider order IDs
- checkout URLs
- provider raw status
- provider metadata
- provider credentials
- raw cart line items
- raw payloads
- raw idempotency keys
- secrets, tokens, JWTs, private keys, DB URLs, or Redis URLs
- public discovery allowlist values
- production config assignments
- AP2 certification, conformance, or approval claims

## Stop Conditions

Stop and require separate approval if any change attempts to:

- claim AP2 certification, conformance, approval, or network readiness
- publish AP2 capabilities
- create or sign a production mandate
- submit evidence to a payment network
- set `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
- set `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
- enable production Commerce V1
- enable checkout or payment creation in production
- enable live payments or live Plural
- call Plural, Stripe, Pine, payment providers, or merchant private APIs
- store or print real provider credentials
- expose private merchant data, exact internal IDs, raw payloads, provider
  metadata, allowlists, production config, or secrets

## Rollback

Rollback is code-only:

1. Remove the route import and endpoint from `apps/auth-service/src/routes/commerce.ts`.
2. Remove `apps/auth-service/src/lib/commerce/ap2-evidence-preview.ts`.
3. Remove the C6M OpenAPI path and `Ap2EvidencePreview` component.
4. Remove C6M tests and guide references.

No migration, secret, production configuration, provider account, public
discovery setting, allowlist, checkout/payment route enablement, signed
mandate, payment-network submission, or cloud resource is created by this
slice.

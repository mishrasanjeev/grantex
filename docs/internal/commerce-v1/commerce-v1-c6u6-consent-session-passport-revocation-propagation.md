# C6U6 Consent, Session, and Passport Revocation Propagation

Status: internal implementation note only. This document does not approve production launch, real merchants, public discovery, checkout/payment, live providers, live Plural, production config, production allowlists, cloud resources, provider calls, merchant private API calls, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, merchant approval, or production readiness.

## Executive Summary

C6U6 defines the authority boundary for buyer-agent sessions. Grantex remains the authority for consent, Commerce Passport issuance and verification, revocation, merchant status, agent status, policy evaluation, and audit evidence. AgenticOrg may consume only buyer-safe authority summaries and must fail closed when authority is missing, stale, expired, revoked, disabled, mismatched, ambiguous, or unsupported.

This slice does not enable checkout, payment creation, live payment, live Plural, provider calls, merchant private API calls, public discovery, production allowlists, or production launch.

## Grantex Authority Model

Grantex owns:
- Consent request, grant, denial, expiry, and revocation state.
- Commerce Passport signing, verification, scope checks, expiry checks, tenant checks, merchant checks, agent checks, and revocation checks.
- Merchant enablement, emergency disable, and production approval state.
- Commerce agent registration, trust, suspension, and disablement state.
- Policy decisions for protected actions.
- Audit events for consent, passport issue, verify, revoke, policy denial, merchant disable, agent disable, checkout refusal, and payment refusal.

Protected actions include checkout creation, payment intent creation, payment status reads for agent callers, and any future payment-affecting action. A protected action must not proceed unless Grantex can verify fresh consent, a valid Commerce Passport, matching tenant, matching merchant, matching agent, required scopes, merchant eligibility, agent eligibility, policy allow, and non-revoked state.

## AgenticOrg Session-Consumption Model

AgenticOrg may cache only a buyer-safe summary of Grantex authority. It must not cache or expose raw Commerce Passport JWTs, raw consent payloads, raw provider payloads, provider credentials, merchant private payloads, private URLs, DB/Redis URLs, webhook secrets, production config values, or concrete allowlist values.

If AgenticOrg has no fresh authority summary, it must either re-check with Grantex through a Grantex-owned contract or refuse the protected action. Cached state cannot override a Grantex revoked, expired, disabled, denied, or stale state.

## Required Authority Fields

Future Grantex-to-AgenticOrg authority summaries should include only buyer-safe values:
- `consent_status`
- `passport_status`
- `session_status`
- `merchant_status`
- `agent_status`
- `policy_decision`
- `authority_checked_at`
- `passport_expires_at`
- `consent_expires_at`
- `revocation_status` or redacted revocation reference
- `merchant_reference` or scoped merchant handle
- `agent_reference` or scoped agent handle
- `buyer_session_reference`
- `audit_event_id`
- `decision_id`

Raw IDs should be avoided where a scoped reference is enough. Raw JWTs and raw private evidence must not be included.

## Revocation Propagation

Revocation can originate from buyer consent withdrawal, passport revocation, merchant disablement, commerce-agent disablement, policy denial, incident response, fraud/abuse moderation, or operator rollback. Once Grantex records revocation or disablement, AgenticOrg must treat any cached buyer session as invalid for protected actions until Grantex returns a fresh allowed authority summary.

Revocation propagation is fail-closed:
- Missing consent means no protected action.
- Missing passport means no protected action.
- Expired passport means refused.
- Revoked passport means refused.
- Disabled merchant means refused.
- Disabled commerce agent means refused.
- Policy denial means refused.
- Mismatched merchant, agent, buyer, or session means refused.
- Stale authority means refresh or refuse.
- Ambiguous authority means refuse.

## Freshness and Staleness

AgenticOrg should treat authority as stale when `authority_checked_at` is missing, older than the configured short TTL, or contradicted by any expiration or revocation marker. Payment-affecting flows should use a short TTL and prefer an online Grantex verification path. C6U6 does not define a production TTL or enable a production path.

## Mismatch Handling

The tenant, merchant, agent, buyer principal, session, and passport must refer to the same scoped authority chain. Any mismatch must refuse. A Grantex-only approval does not authorize AgenticOrg exposure. An AgenticOrg-only cached session does not authorize Grantex commerce.

## Buyer-Safe Refusal Wording

Safe wording:
- "I need fresh Grantex consent before continuing."
- "The Commerce Passport is no longer valid. Please request fresh consent through Grantex."
- "The merchant or agent is not enabled for this commerce action."
- "Grantex policy did not allow this action."
- "The buyer session authority is stale, so I cannot continue."

Unsafe wording:
- "Here is the passport JWT."
- "The private provider payload says..."
- "The merchant private endpoint returned..."
- "Checkout/payment is approved."
- "Live provider or live Plural is available."

## Private-Only Fields

Keep private: raw passports, JWTs, tokens, provider credentials, raw consent payloads, raw connector payloads, merchant private URLs, provider internals, DB/Redis URLs, webhook secrets, production config values, concrete production allowlists, raw reviewer notes, and private incident evidence.

## Audit and Evidence Requirements

Every protected-action decision should have an audit trail that can answer:
- Which consent record was checked.
- Which Commerce Passport or redacted passport reference was checked.
- Which merchant and agent status were checked.
- Which policy decision was checked.
- Whether revocation was checked online or from a fresh summary.
- Whether the action was refused, why, and by which owner.

Audit evidence must be redacted before it is shared with AgenticOrg or a buyer channel.

## Stop Conditions

Stop C6U6 work if it adds public discovery enablement, checkout/payment enablement, live payment, live Plural, provider calls, merchant private API calls, production config, production allowlists, cloud resources, secrets, workflow changes, migrations, protocol publication, external submission, certification, compliance, conformance, standardization, merchant approval, public-launch readiness, or production readiness claims.

## Remaining Gaps

- Channel-specific refusal packs.
- Order, fulfillment, refund, support, settlement, and payout contracts.
- Sandbox checkout E2E.
- Live provider readiness.
- AgenticOrg CI/CD cloud-build guard follow-up.
- Shared production-grade revocation TTL policy.
- Buyer-facing consent UX and revocation UX.

## Validation

C6U6 validation should run focused consent/session/passport revocation propagation tests, nearby commerce consent/passport/policy/no-Plural/public-discovery tests, Commerce Preview Conformance gate, typecheck where touched, whitespace diff check, ASCII check, secret/private scan, passport/JWT/raw-token scan, production config/allowlist scan, public discovery enablement scan, checkout/payment/live-provider scan, direct provider/Plural scan, merchant private API scan, raw connector/private payload scan, and overclaim scan.

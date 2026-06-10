# Commerce V1 C6U11 Provider Sandbox Webhook Reconciliation Foundation

Status: internal planning and test foundation only.

C6U11 defines a provider-neutral sandbox adapter contract and hardening expectations for webhook replay and reconciliation. It uses supplied local test facts only. It does not add a live provider adapter, provider credentials, production checkout, payment creation for production, live Plural, carrier calls, merchant-private API calls, settlement, payout, refund execution, public discovery, workflow changes, cloud resources, or production config.

## Scope

C6U11 is Grantex-owned and limited to helper, tests, and documentation:

- A local sandbox contract helper that evaluates supplied facts.
- Deterministic redacted references for sandbox payment intent sequencing.
- Webhook signature, replay, duplicate, malformed, and unknown-event expectations.
- Reconciliation expectations for pending age, status mismatch, and manual review.
- Explicit non-enablement language for live provider use and money movement.

This is not a provider adapter rollout. It is not a payment approval, checkout approval, merchant approval, production launch, certification, compliance claim, conformance claim, standardization claim, or live provider approval.

## Sandbox Provider Adapter Contract

The sandbox adapter contract is provider-neutral and deterministic. It can represent:

- `create sandbox intent` from tenant, merchant, payment intent, amount, line item snapshot, idempotency hash, source freshness, and audit references.
- `get sandbox status` from supplied local status facts only.
- `normalize provider status` into the Commerce payment status taxonomy.
- `normalize provider errors` into buyer-safe messages.
- Redacted provider references only, such as hashed local references.

The contract requires:

- `tenant_id`
- `merchant_id`
- `payment_intent_id`
- local sandbox environment
- local sandbox adapter selection
- hashed idempotency key reference
- redacted audit evidence references

The contract refuses:

- live or unknown environment
- non-local adapter selection
- missing tenant, merchant, payment intent, idempotency, or audit facts
- credentials, raw provider payloads, raw connector payloads, private URLs, provider execution fields, carrier fields, settlement fields, payout fields, refund execution fields, and merchant-private API fields

The contract never instantiates provider adapters and never performs a network call.

## Normalized Status Taxonomy

Allowed normalized sandbox statuses are:

| Normalized status | Meaning | Execution implication |
| --- | --- | --- |
| `authorized` | Local sandbox intent can continue test sequencing | No money movement |
| `payment_pending` | Local sandbox fact says payment remains pending | No money movement |
| `paid` | Supplied sandbox fact maps to a terminal paid state | No settlement or payout |
| `failed` | Supplied sandbox fact maps to failure | No retry execution |
| `expired` | Supplied sandbox fact maps to expiration | No provider call |
| `cancelled` | Supplied sandbox fact maps to cancellation | No provider call |
| `manual_review_required` | Unknown or ambiguous value | Fail closed |

Unknown, ambiguous, or unsupported values must map to `manual_review_required`.

## Normalized Error Taxonomy

C6U11 uses the existing provider-neutral error taxonomy:

- `provider_unavailable`
- `invalid_provider_credentials`
- `provider_validation_failed`
- `provider_rate_limited`
- `provider_timeout`
- `payment_declined`
- `payment_expired`
- `webhook_signature_invalid`
- `webhook_replay_detected`
- `unsupported_provider_event`
- `unknown_provider_error`

Buyer-safe errors must not include raw provider request IDs, raw payloads, tokens, credentials, private URLs, webhook secrets, DB URLs, Redis URLs, or private evidence. Provider-specific error details may be represented only as redacted references or hashed local references.

## Webhook Signature, Replay, And Idempotency Expectations

Webhook handling must be designed around these expectations before any later runtime hardening:

- Signature state must be verified before event facts can influence payment state.
- Missing, invalid, or unconfirmed signature state must refuse protected status use.
- Replay windows must reject stale events.
- Duplicate event IDs must be idempotently ignored without a second transition.
- Event IDs must be stable references.
- Unknown event types must require manual review.
- Malformed or ambiguous status facts must require manual review.
- Webhook evidence must be redacted and must not carry raw request bodies.
- Webhook handling must not call a provider, Plural, a carrier, or a merchant-private API.

## Reconciliation Expectations

Reconciliation in this foundation consumes supplied facts only:

- Pending payment age is evaluated locally.
- Young pending payments remain `no_change`.
- Status mismatches map to `manual_review_required`.
- Unknown provider status maps to `manual_review_required`.
- Terminal supplied facts may recommend a Commerce status transition, but do not execute settlement, payout, refund, carrier, provider, or merchant-private actions.
- Terminal existing payment status remains idempotently unchanged.
- Reconciliation must not pull live status from a provider.
- Reconciliation must not move money automatically.

## Audit And Evidence Requirements

Every protected sandbox contract, webhook, and reconciliation decision needs redacted evidence references:

- audit event reference
- tenant and merchant scope
- payment intent reference
- idempotency hash or event ID hash where applicable
- source freshness timestamp or local fixture source
- manual review reason for ambiguous states

Evidence must be enough for internal traceability without leaking secrets or raw provider material.

## Redaction Rules

Public and audit-visible summaries must redact or refuse:

- access tokens
- API keys
- bearer tokens
- raw passports
- JWTs
- webhook secrets
- provider credentials
- encrypted secret blobs
- raw connector payloads
- raw provider payloads
- raw request bodies
- private URLs
- DB URLs
- Redis URLs
- merchant-private API URLs
- provider payment IDs
- provider order IDs
- settlement IDs
- payout IDs
- refund transaction IDs
- carrier label or tracking URLs

Redacted output should use stable local references such as hashed event or status references.

## Manual Review And Stop Conditions

Stop and require manual review if any of these appear:

- live environment requested
- non-local provider adapter requested
- provider credentials are required
- raw provider payload is needed
- webhook signature state is missing, invalid, or unconfirmed
- webhook replay state is stale
- event type is unknown
- status is ambiguous
- reconciliation detects a mismatch
- settlement, payout, refund execution, carrier, provider, Plural, or merchant-private API behavior is required
- production checkout or public discovery would be needed

## What This Does Not Enable

C6U11 does not enable:

- live provider use
- live Plural
- production Commerce V1
- production checkout
- payment creation for production
- live payments
- provider credentials
- provider calls
- Plural calls
- carrier or shipping provider calls
- merchant-private API calls
- public discovery
- production allowlists
- settlement
- payout
- refund execution
- fulfillment or delivery execution
- route, endpoint, OpenAPI, migration, workflow, cloud, deploy, or config changes
- external protocol publication or submission

## Evidence Required Before Later Live Review

A later live-mode review would need separate evidence before any approval discussion:

- legal and partner approval records
- security review for credential storage and rotation
- operator runbooks for incident, rollback, and disablement
- feature flag and config review without secrets in source
- provider adapter contract review
- webhook signature verification evidence
- replay and idempotency evidence
- reconciliation evidence for mismatch and manual review states
- refund, settlement, and payout non-execution evidence
- audit retention and privacy review
- production endpoint health diagnostics handled under separately approved procedures

C6U11 does not collect, approve, or certify that evidence.

## API, OpenAPI, Migration, Workflow, And Config Note

C6U11 adds no migration, route, endpoint, OpenAPI surface, workflow, config, secret, provider adapter, carrier adapter, cloud resource, deploy behavior, public discovery surface, production allowlist, or AgenticOrg runtime behavior.

OpenAPI is unchanged because C6U11 exposes no external API surface.

## AgenticOrg Future-Consumption Note

AgenticOrg must continue refusing provider, payment, fulfillment, refund, settlement, or payout status unless Grantex later supplies buyer-safe source facts through an approved surface. AgenticOrg must not infer live provider state, payment outcome, reconciliation state, refund status, settlement state, or payout state from these sandbox fixtures.

## Future Slices

Future work must stay separately reviewed:

- real sandbox provider adapter implementation
- webhook signature runtime verification hardening
- reconciliation dashboard or API
- refund execution proposal
- settlement and payout reporting
- AgenticOrg buyer-safe consumption
- live provider review with live mode still blocked until separately approved

## Explicit Non-Approval Language

This C6U11 slice does not approve live provider use, live Plural, payment approval, checkout approval, production checkout, production Commerce V1, public discovery, merchant approval, production launch, certification, compliance, conformance, standardization, live payment use, settlement, payout, refund execution, fulfillment execution, delivery execution, carrier integration, or external protocol publication.

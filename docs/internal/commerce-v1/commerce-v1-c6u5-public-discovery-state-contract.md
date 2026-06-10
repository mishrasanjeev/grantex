# C6U5 Public Discovery State Contract

Status: internal implementation note only. This document does not approve production launch, real merchants, public discovery, checkout/payment, live providers, live Plural, production config, production allowlists, cloud resources, provider calls, merchant private API calls, protocol publication, external submission, certification, compliance, conformance, standardization, public-launch readiness, merchant approval, or production readiness.

## Executive summary

C6U5 defines the shared state contract that Grantex and AgenticOrg must use before any buyer-facing public discovery can be considered. The contract is fail-closed. Missing, stale, mismatched, expired, blocked, rejected, ambiguous, unsupported, or demo-only state keeps buyer-facing public discovery hidden or refused.

This slice does not make discovery public. It only documents and tests the state vocabulary and the non-enabling behavior that current Grantex preview and AgenticOrg handoff surfaces must preserve.

## Shared state enum

| State | Meaning | Buyer-facing behavior in C6U5 |
| --- | --- | --- |
| `hidden` | No public discovery path is visible. | Hidden/refused. |
| `draft` | Merchant or metadata is being prepared. | Hidden/refused. |
| `sandbox_review` | Sandbox read-only review is in progress. | Hidden/refused. |
| `approved_for_sandbox_preview` | Internal sandbox preview evidence is complete enough for controlled review. | Internal preview only; not public discovery. |
| `blocked` | A gate failed or a reviewer blocked progress. | Hidden/refused. |
| `rejected` | Reviewer rejected the state. | Hidden/refused. |
| `expired` | Evidence or review state is no longer fresh. | Hidden/refused. |
| `production_pending` | Production decision is pending. | Hidden/refused. |
| `future_public_enabled` | Reserved future enum for a separately approved slice. | Still hidden/refused in this PR. |

## Owner responsibilities

Grantex owns merchant readiness, discovery review, rollout proposal, source/freshness evidence, preview conformance facts, production allowlist decisions, and audit evidence.

AgenticOrg owns buyer-agent exposure, channel-safe discovery behavior, buyer-facing refusal wording, public metadata hiding, channel rollback, and Grantex-only commerce calls.

Neither side may expose public discovery unless a future approved slice shows both Grantex and AgenticOrg in a compatible public-enabled state with fresh evidence, rollback ownership, and separate production controls.

## Transition rules

Every transition must be recorded as audit evidence. A Grantex-only approval cannot expose AgenticOrg public discovery. An AgenticOrg-only approval cannot expose a Grantex merchant. Synthetic, demo, fixture, or dry-run evidence cannot count as production approval.

`approved_for_sandbox_preview` can support controlled internal preview, but it still blocks public discovery, checkout/payment, live provider access, live Plural, merchant private APIs, production allowlists, and public publication.

`future_public_enabled` is only a future enum placeholder in C6U5. It is not active, not a launch decision, and not a production or merchant approval.

## Evidence requirements

Future exposure would require all of the following before a separate enabling PR could even be reviewed:

- Grantex review decision and audit event reference.
- AgenticOrg exposure decision and audit event reference.
- Source/freshness evidence for public-safe merchant, catalog, inventory, and commercial facts.
- Rollback owner and channel rollback path.
- Public-safe buyer wording.
- Evidence that no private merchant fields, raw connector payloads, credentials, tokens, JWTs, DB/Redis URLs, webhook secrets, private URLs, provider internals, production config values, or concrete allowlists are exposed.

## Mismatch and stale handling

Missing state, unsupported state values, Grantex/AgenticOrg mismatch, expired evidence, stale source/freshness, rejected state, blocked state, and production-pending state all fail closed. The buyer-safe behavior is hidden or refused, with a generic message that discovery is not available.

## Rollback behavior

Rollback must be available before any future public exposure. A rollback from either owner must hide AgenticOrg public metadata and make Grantex discovery state non-public. C6U5 does not implement channel rollback because no channel is enabled.

## Public-safe buyer wording

Allowed wording:

- "This merchant is not available for public discovery."
- "This is an internal sandbox preview only."
- "Public discovery is not enabled for this merchant."

Unsafe wording:

- "This merchant is approved for public discovery."
- "This merchant is production ready."
- "This merchant is certified or compliant."
- "Public discovery is enabled."
- "Checkout, payment, live provider, or live Plural is available."

## Private-only fields

Keep private: real merchant identifiers, tenant identifiers, internal system names, raw connector payloads, private URLs, production allowlists, production config values, provider credentials, tokens, JWTs, passports, DB/Redis URLs, webhook secrets, audit raw payloads, and reviewer private notes.

## Stop conditions

Stop C6U5 work if it adds runtime routes, migrations, workflow changes, production config, secrets, cloud resources, provider calls, merchant private API calls, production allowlists, public discovery enablement, checkout/payment enablement, live provider enablement, live Plural enablement, protocol publication, external submission, certification, compliance, conformance, standardization, merchant approval, public-launch readiness, or production readiness claims.

## Remaining gaps

- Consent/session/passport revocation propagation.
- Channel-specific refusal packs.
- Order, fulfillment, refund, support, settlement, and payout contracts.
- Sandbox checkout E2E.
- Live provider readiness.
- AgenticOrg CI/CD cloud-build guard follow-up.

## Validation

C6U5 validation should run the focused public discovery state contract tests, nearby public discovery/readiness/preview tests, Commerce Preview Conformance gate, typecheck where touched, whitespace diff check, ASCII check, secret/private scan, production config/allowlist scan, public discovery enablement scan, checkout/payment/live-provider scan, direct provider/Plural scan, merchant private API scan, raw connector/private payload scan, and overclaim scan.

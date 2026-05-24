> **Internal artifact — not public marketing or compliance evidence.**
> This file was relocated from `docs/reports/` to `docs/internal/commerce-v1/`
> on 2026-05-24 to mark it as operator-internal documentation. It is
> excluded from the public Mintlify navigation (`docs/docs.json`). Do
> not link this file from any public marketing page or external sales
> material. See `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md`
> item P0-5 for the audit context.

# Grantex Commerce V1 Read-Only Discovery Rollout Plan

Status: planning package only
Date: 2026-05-18
Scope: future human-approved Grantex production read-only Commerce discovery rollout
Production changes made by this package: none
Production Commerce V1 enabled by this package: no
Read-only discovery enabled by this package: no
Checkout or payment creation enabled by this package: no
Live payments enabled by this package: no
Live Plural enabled by this package: no
Secrets inspected or changed: no

This document is an implementation-ready approval package for a later
read-only production Commerce discovery rollout. It does not approve or perform
the rollout.

## Current Deployed Gate Evidence

C5C deployed the narrow read-only discovery gate in Grantex production at
commit `6904ca641e365636bb82dfda849d39f01af88efe`.

The post-deploy read-only safety smoke recorded this posture:

| Check | Result |
| --- | --- |
| `https://api.grantex.dev/health` | 200 |
| `https://api.grantex.dev/.well-known/jwks.json` | 200, public JWKS only |
| `https://api.grantex.dev/.well-known/grantex-commerce` | 503 fail-closed |
| API discovery cache posture | `no-store` and `no-cache` on the fail-closed response |
| `https://grantex.dev/.well-known/grantex-commerce` | 404 absent |
| `https://grantex.dev/commerce-playground.html` | 200 public education page |

The same smoke confirmed the production environment names for public discovery,
broader Commerce V1, Commerce live mode, and Plural live mode are absent or not
enabled. No provider credential markers, live-payment markers, live-Plural
markers, or production-readiness/certification overclaims were observed in the
summarized read-only checks.

## Candidate Merchant Allowlist

No named production merchant is approved by the current docs or evidence.

Do not use internal, staging, smoke, or local merchant identifiers as production
allowlist entries. Existing evidence includes non-production merchant IDs for
internal smoke and staging validation only; those are not merchant-owner
approval records.

Rollout blocker:

- A named production merchant approval record is required before the allowlist
  can be populated.
- The approval record must identify the merchant owner, reviewed public
  profile fields, product wording approval, legal/compliance approval, and
  operations owner.
- This planning package intentionally contains no concrete allowlist value.

## Production Config Names For Later Approval

The future approved rollout would use these non-secret production config names:

| Config name | Later rollout purpose |
| --- | --- |
| `COMMERCE_PUBLIC_DISCOVERY_ENABLED` | Enables the read-only well-known discovery response only after approval. |
| `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST` | Restricts public discovery to explicitly approved merchant records. |

This document records names only. It does not record or propose config values.

## Config Names That Must Remain Disabled Or Absent

These production config names must remain disabled or absent during the
read-only discovery rollout unless a separate, explicit approval changes that
posture:

| Config name | Required posture |
| --- | --- |
| `COMMERCE_V1_ENABLED` | Remains disabled; broader Commerce runtime is out of scope. |
| `COMMERCE_LIVE_MODE_ENABLED` | Remains disabled; live payments are out of scope. |
| `PLURAL_LIVE_ENABLED` | Remains disabled; live Plural is out of scope. |
| Any live provider flag | Remains disabled; provider live paths are out of scope. |

No checkout, cart, payment intent, payment status mutation, MCP tool-call
runtime, provider credentials, webhooks, or reconciliation workers are enabled
by the read-only discovery gate.

## AgenticOrg Dependency Sequencing

AgenticOrg public commerce discovery must stay hidden before and during the
Grantex read-only rollout.

Required sequence:

1. Keep `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED` disabled.
2. Obtain all Grantex human approvals listed in this package.
3. Enable only the Grantex read-only discovery config names in a later approved
   rollout.
4. Run the Grantex read-only smoke checklist.
5. Keep AgenticOrg public commerce discovery hidden if any Grantex smoke check
   fails or if the merchant profile is not approved.
6. Consider AgenticOrg public commerce discovery only through a separate
   approval after Grantex read-only smoke passes.

## Human Approval Checklist

All approvals are required before any production config change.

| Gate | Required approval |
| --- | --- |
| Security | Route gate, allowlist behavior, cache posture, rate-limit posture, and rollback reviewed. |
| Legal/compliance | Merchant identity, consent wording, payment wording, and public claims reviewed. |
| Product wording | Public capability language approved and confirmed not to imply launch readiness. |
| Operations/on-call/support | Owner, monitoring plan, incident path, and rollback responsibility approved. |
| Backup/RPO | No new state dependency for discovery; broader Commerce runtime remains disabled. |
| Named merchant | Merchant owner approves exact public profile fields before allowlisting. |
| AgenticOrg dependency | AgenticOrg remains hidden until Grantex read-only smoke passes and a separate approval is granted. |

## No-Go Conditions

Do not proceed with production read-only discovery if any condition below is
true:

- A named production merchant approval record is missing.
- Security, legal/compliance, product wording, operations, backup/RPO, or
  AgenticOrg dependency approval is incomplete.
- The rollout requires enabling `COMMERCE_V1_ENABLED`.
- The rollout would enable checkout, cart creation, payment intent creation,
  payment status mutation, MCP tool calls, webhooks, or reconciliation workers.
- Live payments, live Plural, or any live provider flag would be enabled.
- Provider credentials, webhook secrets, API keys, database URLs, Redis URLs,
  private keys, raw payloads, or secret values would appear in the discovery
  payload.
- The public profile includes production-ready, live-payment-ready,
  external-pilot-ready, AP2/UCP/ACP certification, provider certification, or
  Plural certification claims.
- The rollback path cannot hide discovery by disabling the discovery-specific
  config names.
- AgenticOrg public commerce discovery would be enabled before Grantex
  read-only smoke passes.

## Future Read-Only Rollout Runbook

Do not run these steps until a human-approved rollout explicitly authorizes
them.

1. Confirm the deployed Grantex revision includes C5C commit
   `6904ca641e365636bb82dfda849d39f01af88efe` or newer.
2. Confirm `COMMERCE_V1_ENABLED`, `COMMERCE_LIVE_MODE_ENABLED`,
   `PLURAL_LIVE_ENABLED`, and live provider flags remain disabled or absent.
3. Confirm `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains disabled.
4. Confirm the named merchant approval record exists and matches the intended
   public profile.
5. Apply only the approved read-only discovery config names.
6. Do not apply broad Commerce runtime, checkout/payment, live payment, or live
   Plural config changes.
7. Deploy or revise only if the platform requires a revision for config-name
   changes.
8. Run the read-only smoke checklist below.
9. Record summarized evidence only: endpoint, HTTP status, latency,
   error/blocker code, headers, non-secret marker booleans, and redacted hashes.

## Read-Only Smoke Checklist

Production smoke must use read-only checks and must not create state. Runtime
isolation should be confirmed through config inspection, C5C test coverage, and
non-mutating observations; do not send state-changing production requests unless
a separate approval explicitly permits that test.

| Check | Expected result |
| --- | --- |
| Health | `GET https://api.grantex.dev/health` returns 200. |
| JWKS | `GET https://api.grantex.dev/.well-known/jwks.json` returns public key material only. |
| Approved merchant discovery | `GET https://api.grantex.dev/.well-known/grantex-commerce` for the approved merchant returns reviewed non-secret read-only metadata. |
| Missing merchant selector | Missing selector fails closed when more than one allowlisted merchant exists. |
| Non-allowlisted merchant | Non-allowlisted merchant selector fails closed. |
| No broader runtime | `COMMERCE_V1_ENABLED` remains disabled or absent. |
| No live mode | `COMMERCE_LIVE_MODE_ENABLED`, `PLURAL_LIVE_ENABLED`, and live provider flags remain disabled or absent. |
| No provider credential metadata | Discovery payload contains no provider credentials, provider account secrets, webhook secrets, DB/Redis URLs, private keys, raw payloads, or secret values. |
| No overclaims | Discovery payload contains no production-ready, live-payment-ready, external-pilot-ready, AP2/UCP/ACP certification, provider certification, or Plural certification claims. |
| Cache/header posture | Discovery and fail-closed responses use conservative cache headers appropriate for gated public metadata. |
| AgenticOrg dependency | AgenticOrg public commerce discovery remains hidden. |

## Rollback Plan

Rollback must not require secret rotation or provider configuration changes.

1. Disable or unset `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
2. Clear `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
3. Redeploy or revise only if the platform requires it for config-name changes.
4. Confirm `GET https://api.grantex.dev/.well-known/grantex-commerce` fails
   closed and does not expose read-only metadata.
5. Confirm `GET https://api.grantex.dev/.well-known/jwks.json` remains public
   and non-secret.
6. Confirm `COMMERCE_V1_ENABLED`, `COMMERCE_LIVE_MODE_ENABLED`,
   `PLURAL_LIVE_ENABLED`, and live provider flags remain disabled or absent.
7. Confirm AgenticOrg public commerce discovery remains hidden.
8. Record rollback evidence without raw payloads or secret values.

## Recommendation

Keep production Commerce discovery disabled until all human approvals are
complete and a named production merchant approval record exists.

When approvals are complete, prefer a short, config-only read-only rollout using
the narrow C5C discovery gate and a single approved merchant allowlist entry.
Keep the broader Commerce runtime, checkout/payment paths, live payments, live
Plural, provider credential paths, AgenticOrg public commerce discovery, and all
certification/readiness claims disabled or absent.

## Future Approved-Run Prompt

Do not run this prompt until human-approved.

```text
Task: C5D approved Grantex read-only production Commerce discovery rollout.

Approved:
- Enable only Grantex read-only Commerce discovery for the named approved production merchant.
- Use only the narrow read-only discovery gate.
- Do not enable production Commerce V1 runtime.
- Do not enable checkout/payment creation.
- Do not enable live payments.
- Do not enable live Plural.
- Do not enable AgenticOrg commerce public discovery.
- Do not touch secrets except existing deployment references required by the normal deploy path.
- Do not run state-changing production requests.

Before rollout:
1. Confirm the deployed Grantex revision includes C5C commit `6904ca641e365636bb82dfda849d39f01af88efe` or newer.
2. Confirm security, legal/compliance, product wording, operations/on-call/support, backup/RPO, named merchant, and AgenticOrg dependency approvals are complete.
3. Confirm the named production merchant approval record exists.
4. Confirm `COMMERCE_V1_ENABLED`, `COMMERCE_LIVE_MODE_ENABLED`, `PLURAL_LIVE_ENABLED`, and live provider flags remain disabled or absent.
5. Confirm `AGENTICORG_COMMERCE_PUBLIC_DISCOVERY_ENABLED` remains disabled.
6. Stop if checkout/payment, MCP runtime, live provider paths, or certification/readiness claims would be enabled.

Rollout:
1. Apply only the approved read-only discovery config names:
   - `COMMERCE_PUBLIC_DISCOVERY_ENABLED`
   - `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`
2. Deploy or revise only if the platform requires it for config-name changes.
3. Do not change secrets or live flags.

Read-only smoke:
1. GET health.
2. GET JWKS.
3. GET approved merchant discovery.
4. Confirm missing or non-allowlisted merchant discovery fails closed.
5. Confirm no provider credential, secret, live-payment, live-Plural, or overclaim markers.
6. Confirm conservative cache headers.
7. Confirm AgenticOrg public commerce discovery remains hidden.

Rollback:
1. Disable or unset `COMMERCE_PUBLIC_DISCOVERY_ENABLED`.
2. Clear `COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST`.
3. Redeploy or revise only if required.
4. Confirm discovery fails closed.
```

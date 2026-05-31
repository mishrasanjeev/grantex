# Commerce V1 C5W Demo Home Goods Store Walkthrough

Status: docs/examples only
Date: 2026-05-27
Scope: synthetic merchant demo packet for read-only discovery walkthroughs
Production changes made by this record: none
Production rollout approved by this record: no
Production allowlist value approved by this record: no
Public discovery enabled by this record: no
Checkout or payment creation enabled by this record: no
Live payment or live Plural enabled by this record: no
Secrets inspected or changed: no

This walkthrough explains how to present
`docs/examples/commerce-c5w-demo-home-goods-store-packet.json` in an internal
demo. "Demo Home Goods Store" is a synthetic/demo-only merchant profile. It is
not a real merchant, not onboarding approval, not production approval, and not
an allowlist candidate.

## Demo Purpose

The demo may show a single merchant profile moving through a review-first,
read-only discovery preview. It is suitable for internal walkthroughs of the
merchant self-onboarding experience and should remain detached from production
configuration.

## What The Demo May Show

- Merchant identity preview for `Demo Home Goods Store`.
- Public payload preview with non-secret metadata only.
- Demo approval reference placeholders.
- Demo owner assignment placeholders.
- Demo scan summary placeholders.
- Read-only discovery posture.
- Blocked checkout, payment, live Plural, live provider, and provider
  credential paths.

## What The Demo Must Not Imply

- No real merchant approval.
- No production allowlist.
- No public discovery enablement.
- No production Commerce V1 enablement.
- No checkout or payment creation.
- No live payments.
- No live Plural.
- No provider credentials.
- No certification or readiness claim.

## Suggested UI Labels

| Field | Demo label |
| --- | --- |
| Display name | Demo Home Goods Store |
| Status | Demo-ready, not production-approved |
| Allowed | Read-only discovery preview |
| Blocked | Checkout, payments, live Plural, provider credentials, production allowlist |

## Demo Packet Summary

- Merchant ID: `mch_demo_readonly_homegoods_0001`.
- Tenant reference: `cten_demo_readonly_homegoods_0001`.
- Agent reference: `cag_demo_readonly_sales_0001`.
- Decision state: `demo_ready_not_production`.
- Production rollout permitted: `false`.
- Grantex production read-only discovery remains fail-closed.
- AgenticOrg public commerce discovery remains gated.

## Public-Safe Boundary

The packet contains only synthetic identifiers, demo approval references,
role-label owner placeholders, non-secret payload preview fields, and demo scan
summaries. It must not be expanded with private contracts, private contacts,
signed approvals, pricing terms, customer data, real addresses, phone numbers,
emails, PAN or GST IDs, provider credentials, tokens, raw payloads, DB or Redis
URLs, private keys, or production config values.

## Stop Conditions

Stop the demo and keep it outside production if any condition appears:

- Any real private merchant artifact appears.
- Any production config or allowlist value appears.
- Any claim says the demo merchant is approved.
- Any request asks to enable public discovery.
- Any request asks to enable checkout or payment creation.
- Any request asks to enable live payment or live Plural.
- Any provider credential path is introduced.

## Explicit Non-Approval

This walkthrough and packet do not approve a merchant, do not approve a
production allowlist value, do not enable public discovery, do not enable
Commerce V1, do not enable checkout or payment creation, do not enable live
payments, do not enable live Plural, and do not approve AgenticOrg public
commerce discovery.

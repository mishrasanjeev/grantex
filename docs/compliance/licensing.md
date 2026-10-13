---
title: "Usage and licensing"
description: "Self-use and commercial-agreement policy for existing and new covered users. Software adoption awaits release scope; prior grants remain unchanged."
---

**Status: Approved for policy publication; not adopted by a software release.**
**Legal review approval:** Received by owner attestation on 12 October 2026.
**Prepared:** 12 October 2026. No effective date or covered release has been approved.

## Short notice

Under this policy: personal and internal use is free;
commercializing the platform requires an agreement with Orchestrum Technologies LLP.
Agreements: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in).

The policy covers existing and new users of covered software and Orchestrum-hosted
commercial offerings. An older account is not an exemption. Software adoption
awaits the release scope below; existing hosted customers require the contractual
transition described below, not a backdated obligation.

Current Apache-2.0 rights remain unchanged. This policy is not an additional
restriction on existing Apache-licensed software, specifications or SDKs.

## The workable licensing model

Use mixed licensing, with an explicit boundary rather than attempting to revoke
an already published license:

| Material or service | Treatment |
| --- | --- |
| Previously Apache-licensed code and copies | Original grants remain, including commercial use |
| Eligible new Orchestrum-controlled platform material | Separate self-use/commercial-agreement license after explicit adoption |
| Published SDKs, specifications and third-party components | Retain their published licenses; no silent conversion |
| Orchestrum-operated hosting, support, reseller/OEM access or brand rights | Applicable service or commercial agreement, separate from source-code rights |
| Your business data, prompts, workflows and outputs | No ownership claim is added by this licensing policy |

The concrete candidate is
`licensing/ORCHESTRUM-SELF-USE-COMMERCIAL-1.0-DRAFT.md`; its proposed identifier is
`LicenseRef-Orchestrum-Self-Use-Commercial-1.0`. The adoption record is
`licensing/scope.json`. The text is approved for policy publication, not adoption.
The current scope has **zero covered files**, no release version and no effective
date. Owner publication and owner-attested legal approval are recorded; neither
designates code for adoption. Its reference baseline commit is a
source-review reference, **not a licensing cutoff**.

Prefer separately identifiable original modules that have not already been
distributed under Apache-2.0. Do not move old code into a new folder or change
its header and call that a new licensing right. For mixed or derived files,
document the retained material and obtain a specific rights/notice assessment.

This protects eligible new software and commercial service/brand arrangements
going forward. It does not stop someone commercializing an independent,
previously Apache-licensed implementation. Hosted plans and support can be
monetized separately without changing its source license.

## Existing users and new users

The agreement requirement is not limited to new customers. Existing and new users
must have a written agreement with Orchestrum Technologies LLP for commercialization
of software validly covered by the new license or of Orchestrum-hosted platform
capabilities under the applicable service terms. Account age alone does not exempt
a covered commercial offering.

For existing hosted commercial customers:

1. Identify the covered commercial offering and check the current agreement.
2. Give the notice and obtain the acceptance required by that agreement and
   applicable law before changing the conditions for continued commercial use.
3. Execute a commercial agreement or amendment covering the offering. An existing
   signed agreement that already authorizes it satisfies the requirement; a duplicate
   agreement is not required merely because this notice was published.

No retroactive fees, automatic acceptance, account suspension or effective date
are created by publishing this policy. Existing executed agreements control until
validly amended or replaced. Self-use remains free of a software license fee;
hosting and provider charges are separate.

For previously distributed Apache-2.0 copies, the existing commercial permissions
remain available. An existing user may separately agree to commercial services or
additional rights, but an agreement cannot be made mandatory solely to exercise
those already-granted permissions by changing this page.

## What self-use means

Personal use, evaluation, development and an organization's own operations would
be royalty-free for the software covered by the finalized future license. This
includes internal agents and a bank or merchant serving its own customers in its
ordinary business. Revenue from that ordinary business, selling the merchant's
own goods, or using agent output does not by itself commercialize the platform.

The proposed self-use permission would allow installing, running, copying and
modifying covered software for those purposes, retaining applicable notices.
It does not promise free hosted subscriptions, unlimited usage, infrastructure,
model inference, messaging, telephony, payment processing or third-party services.
Their applicable plans and charges remain separate.

## What would require an agreement

Before commercially offering covered platform software or capabilities to other
parties, obtain a written agreement with Orchestrum Technologies LLP. Examples:

- Reselling or sublicensing covered software as a paid product.
- Operating paid hosted or managed platform access for third parties.
- White-labeling the platform or embedding its agent/runtime capabilities in a
  product or service sold to third parties.
- Selling third-party access to a platform-based agent service.

A consultant helping a customer operate that customer's own licensed deployment
is not automatically a platform reseller. Selling platform access as part of that
consulting service would require an agreement. Borderline arrangements should be
confirmed in writing before relying on the future license.

No price, royalty rate, exclusivity, approval, support or service level is implied.
Send the proposed offering, deployment model and intended users to
[sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in). An inquiry is not an agreement.

## Scope of a future license

Only an explicitly identified future release and material for which Orchestrum
has the necessary licensing rights could adopt the finalized new terms. A release
manifest must identify covered files, versions and artifacts, excluded
Apache-licensed material, and third-party notices. The policy must not claim
exclusive rights over external contributions without supporting rights records.

Already-granted Apache-2.0 permissions remain in place for that material,
including commercial rights, forks and copies. Republishing the same code or
changing a footer does not withdraw those permissions. Future modifications may
have different terms only where authorized; retained Apache components still
carry their original license and notice obligations.

Third-party dependencies retain their own licenses. Protocol specifications,
published interoperability contracts, SDKs and examples must each have an explicit
release-by-release licensing decision; this proposal does not silently relicense
them. Ownership and trademark notices do not override any software license.

## Source availability and distribution

If adopted, a license restricting commercialization would be source-available,
not an OSI-approved open-source license. Do not call it Apache-2.0 with an added
commercial restriction or advertise restricted releases as unrestricted open source.

The candidate text defines self-use, commercialization, noncommercial sharing,
data/output boundaries, proposed patent permission, trademarks, separate hosted
charges, disclaimers and a proposed notice/cure process. Publication approval is
recorded, not software adoption or a guarantee of enforceability. Source-specific
rights clearance, exact scope and release details are still required. Existing source-license
disclaimers continue to apply to existing releases.

## Exact application to a future release

For each covered entry in `licensing/scope.json`, record the exact repository
path, SHA-256 content hash, license identifier and non-sensitive rights-clearance
reference. Keep contracts and personal/legal evidence outside the public repository.
Record the approved release version, effective date and owner/legal approval
references before changing the manifest's status to an active software adoption.

Only then apply the finalized custom-license header to the eligible new material
and publish matching package notices. Keep retained Apache notices where they
belong. Packages containing both types need an accurate mixed-license description,
not an Apache-only label or an unsupported claim of exclusive ownership.

Future contributors to that covered material must expressly agree to reviewed
contribution terms that let Orchestrum grant the intended self-use and commercial
permissions. Current Apache contribution terms do not automatically create those
rights or assign contributors' copyrights.

Do not infer eligibility from an author name or from the reference baseline's
date. Keep already Apache-distributed material outside the exclusive commercial
claim, even if its current file hash changes.

No licensing phone-home, agent transaction check, credential collection, runtime
lockout or billing change is introduced by this documentation work.

## Before a software release adopts the license

1. Publication and legal-review approval were supplied by the owner on 12 October
   2026. Keep that approved text and its provenance distinct from source-specific
   rights clearance and software release adoption.
2. Verify copyright ownership and contributor agreements for each covered item;
   preserve grants for material Orchestrum cannot relicense exclusively.
3. Approve the exact release/file manifest, final license text and effective date.
   No effective date is implied by the preparation date above.
4. Publish the final license and changelog; align covered file headers, package
   metadata, registries, documentation, READMEs and public notices. Do not alter
   third-party or legacy-license labels.
   Update contribution/header-check instructions for the approved covered scope,
   and include the applicable license texts/notices in images and distributions.
5. Keep historic releases and their licenses accessible. Give hosted customers
   appropriate notice and obtain required contractual acceptance separately.
6. Review the website's quiet footer link for readability and discoverability;
   material terms must not be hidden or implied to be already accepted.

Until those steps are complete, the current LICENSE and applicable executed
hosted-service agreements control. Publishing this policy changes no billing, entitlements,
runtime behavior or existing license grants.

## References

- [Apache License 2.0, sections 2, 4 and 5](https://www.apache.org/licenses/LICENSE-2.0)
- [Apache licensing FAQ](https://www.apache.org/foundation/license-faq.html)
- [Open Source Definition](https://opensource.org/osd)


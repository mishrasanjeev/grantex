# Terms of Service (Draft)

**Status:** Draft. Subject to legal review. **Not a legally executed agreement and not legal advice.**
**Last reviewed:** 2026-05-24
**Applies to:** the hosted Grantex services at `grantex.dev` and `api.grantex.dev`.

The open-source Grantex software is licensed separately under the Apache License 2.0 (see `LICENSE`); these Terms govern only your use of the hosted service operated by the Grantex maintainers.

## 1. Acceptance

By creating an account, calling the hosted API with credentials issued by the service, or otherwise using the hosted service, you agree to these Terms. If you are agreeing on behalf of an organization, you represent that you have authority to bind that organization.

## 2. The service

Grantex provides a delegated authorization service for AI agents: agent registration, scoped authorization, grant-token issuance and verification, audit logging, and the supporting consent UI. Detailed behavior is described in the protocol specification (`SPEC.md`) and the public API reference (`docs.grantex.dev/api-reference`).

## 3. Your account

- You must keep your API keys, signing keys, and admin credentials confidential.
- You are responsible for activity that occurs under your account, including activity by any agent or end user you have authorized.
- You must not use the service to violate any applicable law or to enable a third party to do so.

## 4. Acceptable use

You may not, and may not permit your agents or end users to:

- Reverse engineer, decompile, or attempt to derive the signing keys of the hosted service.
- Use the service to facilitate fraud, theft, harassment, or other unlawful activity.
- Probe, scan, or stress-test the service except via published load-test endpoints with prior coordination.
- Send personal data the service is not designed to handle (see [Privacy Policy](./privacy-policy.md), Section 2 — no payment-card data, no special-category personal data).
- Circumvent rate limits, billing meters, or the central live-mode guard.

We may suspend or terminate access for material breach, with notice where reasonable.

## 5. Fees

If your plan is paid, fees are described in your order form or at `grantex.dev/pricing` (pricing page **TBD**). Fees are billed through Stripe (see [Sub-processors](./sub-processors.md)). Unpaid invoices may result in service suspension after notice.

## 6. Beta and early-access features

Features labelled "beta", "preview", "closed beta", or "experimental" are provided **as-is** with no service-level commitments. Today this includes Commerce V1 (`README.md` section "Agentic Commerce V1 (closed beta)"), the Trust Registry, and the SOC 2 readiness mapping.

## 7. Service level

Target availability for the production hosted service is **99.5%** monthly, measured at the auth-service `/health` endpoint, excluding scheduled maintenance announced at least 48 hours in advance. A formal SLA with credits is **TBD**.

## 8. Data ownership and processing

You retain ownership of all data you submit. The service processes that data only as described in the [Privacy Policy](./privacy-policy.md) and the [DPA template](./dpa.md). For self-hosted Grantex you control all data; these Terms do not apply.

## 9. Confidentiality

Each party will protect the other's non-public information with at least the same degree of care it uses for its own (and no less than a reasonable degree of care). Public artifacts — the spec, the open-source code, documentation, and published metrics — are not confidential.

## 10. Intellectual property

- The open-source software is yours to use under the Apache 2.0 license.
- The "Grantex" name, logo, and the hosted-service branding remain ours.
- Feedback you provide may be used to improve the service without obligation, but Grantex will not publicly attribute negative feedback to you without consent.

## 11. Warranties and disclaimers

The hosted service is provided **as-is** and **as-available**, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. Some jurisdictions do not allow the exclusion of implied warranties; in those jurisdictions the exclusions apply to the maximum extent permitted by law.

## 12. Limitation of liability

To the maximum extent permitted by law, neither party will be liable to the other for indirect, incidental, special, consequential, or punitive damages, or for loss of profits, revenue, goodwill, or data, arising out of these Terms. Each party's total liability is capped at the fees you paid in the 12 months preceding the event giving rise to the claim. These limits do not apply to either party's indemnity obligations or to your payment obligations.

## 13. Termination

Either party may terminate for material breach uncured 30 days after written notice. Sections 8 (Data), 11 (Disclaimers), 12 (Liability), 14 (Governing law) survive termination. On termination, the data return-or-delete process in the [DPA](./dpa.md), Section 10 applies.

## 14. Governing law and disputes

The governing law and venue are those specified in your executed order form. The template default is Delaware, United States. Either party may seek injunctive relief in any court of competent jurisdiction.

## 15. Changes

We may revise these Terms; material changes will be announced at least 30 days in advance via the public CHANGELOG and the developer portal. Continued use after the effective date constitutes acceptance.

## 16. Contact

`security@grantex.dev`

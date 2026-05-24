# Data Processing Addendum (Template)

**Status:** Draft template. Subject to legal review. **Not a legally executed agreement and not legal advice.**
**Last reviewed:** 2026-05-24

This template forms the basis of the Data Processing Addendum that Grantex offers to customers of the hosted service. It is published so procurement teams can review the terms before requesting a signed copy. The signed copy that the parties execute will be a PDF derived from this template, countersigned by both parties; this Markdown file does not constitute that signed agreement.

Customers requiring a signed DPA should email `security@grantex.dev` with their legal counter-party details.

---

## 1. Parties

- **Processor:** Grantex maintainers (the entity operating `api.grantex.dev`; legal entity name **TBD** pending company formation / counsel review).
- **Controller:** the customer organization identified in the executed cover sheet.

This addendum supplements the Apache 2.0 license of the open-source software and any commercial agreement covering the hosted service. In a conflict, the executed cover sheet governs.

## 2. Subject matter and duration

The Processor processes personal data on behalf of the Controller solely to deliver the Grantex Delegated Authorization Platform hosted service. Processing continues for the term of the underlying agreement and during any wind-down period defined in Section 10 (Return or Deletion).

## 3. Nature and purpose of processing

- Issuing, verifying, and revoking agent grant tokens.
- Recording consent records and audit entries linked to data principals.
- Operating the supporting administrative, support, and security functions of the platform.

## 4. Categories of personal data

| Category | Examples |
|---|---|
| Account / developer | Email, name, organization, hashed API key |
| End-user / data principal | Principal identifier supplied by the Controller (typically a pseudonymous ID), optional WebAuthn credential references |
| Authorization events | Scope strings, timestamps, agent DIDs, IP addresses captured for rate limiting |
| Audit metadata | Action, status, request ID, hashed references to third-party identifiers |
| Optional compliance | DPDP consent records, grievance references, erasure request IDs |

Grantex does **not** request payment-card data, government identifiers, or special-category personal data. Customers must not transmit such data to the platform.

## 5. Categories of data subjects

- The Controller's developers and administrators.
- The Controller's end users (data principals) whose authorization is brokered by Grantex.
- Authorized agents acting on behalf of those end users.

## 6. Sub-processors

A current list is maintained at [docs/compliance/sub-processors.md](./sub-processors.md). The Processor will provide at least 30 days' notice (via CHANGELOG and the developer portal) before engaging a new production sub-processor; the Controller may object in writing within that window, in which case the parties will discuss an alternative arrangement in good faith.

## 7. Technical and organisational measures

The Processor maintains the following safeguards, summarised here and described in detail in `docs/security/` and `SECURITY.md`:

- **Encryption in transit** — TLS 1.2+ enforced on all public endpoints.
- **Encryption at rest** — provider-native (Cloud SQL, Memorystore, Secret Manager) plus an application-level vault key for sensitive fields.
- **Key management** — JWT signing keys and the vault encryption key live in Google Secret Manager and are rotatable without redeploy.
- **Access controls** — least-privilege IAM on infrastructure; CODEOWNERS-gated reviews on the source; CI-required status checks on `main`.
- **Multi-tenancy isolation** — every row is developer-scoped and proven by `tests/security-multi-tenancy.test.ts`.
- **Vulnerability management** — published disclosure policy and SLA in `SECURITY.md`; weekly Dependabot updates configured in `.github/dependabot.yml`.
- **Live commerce side-effects fail closed** — central guard in `apps/auth-service/src/lib/commerce/live-mode-guard.ts`.

## 8. Confidentiality

Personnel with access to personal data are bound by confidentiality obligations and receive security training appropriate to their role.

## 9. Breach notification

The Processor will notify the Controller **without undue delay and in any event within 72 hours** of becoming aware of a personal-data breach affecting the Controller's data. The notification will include: nature of the breach, categories and approximate number of data subjects and records affected, likely consequences, and measures taken or proposed.

## 10. Return or deletion of data

On termination of the underlying agreement, the Controller may, within 30 days, request:

- **Export** — a JSON export of all personal data the Processor holds about the Controller's tenants; or
- **Deletion** — irreversible deletion of that data and a written confirmation.

The DPDP erasure endpoint (`POST /v1/dpdp/data-principals/:id/erasure`, see `apps/auth-service/src/routes/dpdp.ts`) is available throughout the term for per-principal deletion.

## 11. International transfers

The Processor relies on the European Commission's Standard Contractual Clauses (Module Two: Controller-to-Processor) for any transfer of EEA-origin personal data outside the EEA, plus the UK International Data Transfer Addendum and the Swiss FDPIC adequacy mechanism as applicable. Today, all hosted processing occurs in `us-central1`; see [data-residency.md](./data-residency.md).

## 12. Audits

The Controller may request, no more than once per year and on at least 60 days' notice, evidence of the Processor's compliance with this Addendum. The Processor will respond with the most recent SOC 2 attestation **when available** (status today: SOC 2 readiness control mapping published in `docs/security/soc2-report.mdx`; formal third-party attestation pending). On-site audits are by mutual written agreement.

## 13. Liability

Liability under this Addendum is subject to the limits in the underlying commercial agreement. Open-source self-hosted use is governed solely by the Apache 2.0 license.

## 14. Governing law

The governing law and venue are those specified in the executed cover sheet. The template defaults to Delaware, United States, pending company-formation decisions.

## 15. Signature block

This template becomes binding only when both parties sign the executed cover sheet that incorporates these terms by reference. **The Markdown file alone is not a signed agreement.**

# Privacy Policy (Draft)

**Status:** Draft. Subject to legal review. **Not a legally executed privacy notice and not legal advice.**
**Last reviewed:** 2026-05-24
**Applies to:** the hosted Grantex services at `grantex.dev`, `api.grantex.dev`, and `docs.grantex.dev`.

This draft is published so customers and end users can review Grantex's privacy practices before a counsel-reviewed version is countersigned and published.

## 1. Who we are

Grantex is an open protocol and a hosted developer service operated by the Grantex maintainers (the legal entity name and registered office are **TBD** pending company formation). For privacy questions or to exercise the rights below, contact `security@grantex.dev`.

## 2. What we collect and why

### As a developer using the hosted service

- **Account data** — name, email, organization, password hash, hashed API key. Used to authenticate you and to operate the service.
- **Usage and billing data** — request counts, error counts, plan tier, Stripe customer ID if billing is enabled. Used for billing and capacity planning.
- **Operational logs** — request ID, timestamp, source IP, route, status code, latency. Used for security monitoring and debugging. Retained per the schedule below.

### As an end user (data principal) whose agent uses Grantex

- **Principal identifier** — the opaque identifier your developer assigned you (typically pseudonymous).
- **Authorization events** — what scopes you granted, to which agent, when, and when you revoked them. This is the core audit trail Grantex exists to provide.
- **Optional WebAuthn credential references** — only if your developer turned on FIDO/WebAuthn.
- **DPDP consent records, grievance references, erasure request IDs** — only if your developer is using the DPDP compliance features.

We do **not** ask you for payment-card data, government identifiers, biometrics, location, or contacts.

## 3. Legal bases (GDPR-equivalent)

- **Contract** — to deliver the service the developer agreed to.
- **Legitimate interest** — to keep the service secure (rate limiting, anomaly detection, audit).
- **Consent** — for any optional cookies that go beyond strictly necessary (see [Cookie Policy](./cookie-policy.md)).
- **Legal obligation** — to respond to lawful requests from regulators.

## 4. How long we keep it

| Category | Retention |
|---|---|
| Account data | For the life of the account; deleted within 30 days of account closure. |
| Authorization audit trail | Operator-configurable; default 365 days on the hosted service. |
| Operational logs | 30 days. |
| Backups | 30 days, rolling. |
| DPDP / GDPR erasure records | Indefinitely, anonymized — required as proof the erasure occurred. |

## 5. Sub-processors and international transfers

We use a small number of third-party services to operate the hosted offering. The full list and locations are in [sub-processors.md](./sub-processors.md). Hosted processing occurs in the US (`us-central1`); see [data-residency.md](./data-residency.md). For EEA / UK / Swiss transfers we rely on Standard Contractual Clauses; see [dpa.md](./dpa.md).

## 6. Your rights

Depending on where you live, you have some or all of the following rights:

- **Access** — request a copy of the data we hold about you.
- **Rectification** — correct inaccurate data.
- **Erasure** — ask us to delete your data. For agent-authorization records this is implemented programmatically via `POST /v1/dpdp/data-principals/:principalId/erasure` (see `apps/auth-service/src/routes/dpdp.ts`); your developer can also trigger this on your behalf.
- **Portability** — receive your data in JSON.
- **Restriction** and **objection** to certain processing.
- **Withdrawal of consent** at any time, with no effect on lawfulness of earlier processing.
- **Lodge a complaint** with your local supervisory authority (e.g., EU DPA, the UK ICO, the Indian DPB).

Exercise any of these by emailing `security@grantex.dev`. We aim to respond within 30 days.

## 7. Children

Grantex is a developer infrastructure service. We do not knowingly collect personal data from children under 13 (or the equivalent age of digital consent in your jurisdiction). If you believe we have, please contact us and we will delete it.

## 8. Cookies and tracking

The marketing site (`grantex.dev`) uses Google Analytics for aggregate traffic statistics. The developer portal and API use only strictly necessary cookies (session, CSRF). Full details in the [Cookie Policy](./cookie-policy.md).

## 9. Security

How we protect data is described in `SECURITY.md` and the [DPA template](./dpa.md), Section 7. To report a vulnerability, see `SECURITY.md`.

## 10. Changes

Material changes to this policy will be announced via the public CHANGELOG and the developer portal at least 30 days before they take effect. The `Last reviewed` date at the top of this file is the authoritative version marker.

## 11. Contact

`security@grantex.dev`

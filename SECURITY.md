# Security Policy

## Supported Versions

Only the following versions of Grantex components receive security patches:

| Component | Version | Supported |
|-----------|---------|-----------|
| Protocol spec | v1.0 | ✅ Yes |
| `@grantex/sdk` | 0.1.x | ✅ Yes |
| `grantex` (Python) | 0.1.x | ✅ Yes |
| `@grantex/langchain` | 0.1.x | ✅ Yes |
| `@grantex/autogen` | 0.1.x | ✅ Yes |
| `@grantex/vercel-ai` | 0.1.x | ✅ Yes |
| `grantex-crewai` | 0.1.x | ✅ Yes |
| `@grantex/cli` | 0.1.x | ✅ Yes |

If you are running a version not listed above, please upgrade before reporting.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Send a report to **security@grantex.dev** with:

- A clear description of the vulnerability and its potential impact
- The affected component(s): `auth-service`, `sdk-ts`, `sdk-py`, `cli`, or `SPEC.md`
- Steps to reproduce or a minimal proof-of-concept
- Any suggested mitigations you have identified

Encrypt sensitive reports with our PGP key (available at `https://grantex.dev/.well-known/security.asc`).

### Response SLA

| Stage                      | Target                          |
|----------------------------|---------------------------------|
| Acknowledgement            | 48 hours                        |
| Substantive response       | 7 business days                 |
| Patch (Critical / High)    | 30 days from confirmation       |
| Patch (Medium / Low)       | Next scheduled release          |

We will keep you informed of progress throughout the remediation process.

---

## Coordinated Disclosure

We follow a **coordinated disclosure** model:

1. Reporter submits vulnerability to `security@grantex.dev`.
2. We triage, reproduce, and confirm within 7 business days.
3. We develop and test a fix, keeping the reporter in the loop.
4. We publish a patched release and a CVE (if applicable).
5. Reporter is credited by name (or anonymously, at their choice) in the release notes.
6. Reporter may publish their own write-up 30 days after the patched release ships, or earlier by mutual agreement.

We will not pursue legal action against researchers who act in good faith and follow this policy.

---

## Scope

### In scope

| Component           | Examples                                                  |
|---------------------|-----------------------------------------------------------|
| `auth-service`      | Token issuance, verification, revocation, delegation      |
| `sdk-ts`            | `@grantex/sdk` — client-side token handling, JWT verify   |
| `sdk-py`            | `grantex` package — same surface as sdk-ts                |
| `langchain`         | `@grantex/langchain` — scope enforcement, audit callbacks |
| `autogen`           | `@grantex/autogen` — function registry, scope enforcement |
| `vercel-ai`         | `@grantex/vercel-ai` — tool scope checks, audit logging  |
| `crewai`            | `grantex-crewai` — tool scope enforcement                 |
| `cli`               | `@grantex/cli` — CLI tool, credential handling            |
| `portal`            | Developer portal — auth flow, API key handling            |
| `SPEC.md`           | Protocol design flaws (e.g. cryptographic weaknesses)     |

### Out of scope

- Vulnerabilities in third-party dependencies (report upstream; let us know so we can track)
- Physical access attacks
- Social engineering of Grantex staff
- Denial-of-service attacks against hosted infrastructure
- Findings that require the attacker to already have valid admin credentials with no additional privilege escalation
- Automated scanner output without evidence of exploitability

---

## Bug Bounty

We do not currently operate a formal bug bounty programme. We recognize impactful reports publicly in release notes and on our [Hall of Thanks](https://grantex.dev/security/thanks).

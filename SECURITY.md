# Security Policy

## Supported Versions

Only the following versions of Grantex components receive security patches:

| Component | Version | Supported |
|-----------|---------|-----------|
| Protocol spec | v1.0 | ✅ Yes |
| `@grantex/sdk` | 0.3.x | ✅ Yes |
| `grantex` (Python) | 0.3.x | ✅ Yes |
| `@grantex/cli` | 0.2.x | ✅ Yes |
| `github.com/mishrasanjeev/grantex-go` | 0.1.x | ✅ Yes |
| `@grantex/mcp` | 0.1.x | ✅ Yes |
| `@grantex/mcp-auth` | 2.0.x | ✅ Yes |
| `@grantex/langchain` | 0.1.x | ✅ Yes |
| `@grantex/express` | 0.1.x | ✅ Yes |
| `grantex-fastapi` | 0.1.x | ✅ Yes |
| `@grantex/gateway` | 0.1.x | ✅ Yes |
| `@grantex/adapters` | 0.1.x | ✅ Yes |
| `@grantex/conformance` | 0.1.x | ✅ Yes |
| `@grantex/autogen` | 0.1.x | ✅ Yes |
| `@grantex/vercel-ai` | 0.1.x | ✅ Yes |
| `grantex-crewai` | 0.1.x | ✅ Yes |
| `grantex-openai-agents` | 0.1.x | ✅ Yes |
| `grantex-adk` | 0.1.x | ✅ Yes |
| `@grantex/dpdp` | 0.1.x | ✅ Yes |

If you are running a version not listed above, please upgrade before reporting.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report via one of:

- **Email**: [security@grantex.dev](mailto:security@grantex.dev)
- **GitHub Security Advisories**: [Report a vulnerability](https://github.com/mishrasanjeev/grantex/security/advisories/new)

Include in your report:

- A clear description of the vulnerability and its potential impact
- The affected component(s): `auth-service`, `sdk-ts`, `sdk-py`, `cli`, or `SPEC.md`
- Steps to reproduce or a minimal proof-of-concept
- Any suggested mitigations you have identified

### Encrypted reports

If a report contains exploit code, customer data, or other material you do not
want to send in cleartext, request our PGP key by emailing
`security@grantex.dev` with the subject **"PGP key request"** and we will reply
with the current public key and its fingerprint within one business day. The
fingerprint will also be posted at `https://grantex.dev/.well-known/security.asc`
**(URL provisioning is TBD — until it is published, email is the source of
truth).** Do not assume any key you find on a public key server is ours unless
the fingerprint matches what we emailed you.

### Response SLA

Acknowledgement and substantive-response windows apply to every report.
Remediation targets depend on the assessed severity using the CVSS v3.1
qualitative scale:

| Stage                       | Target                                       |
|-----------------------------|----------------------------------------------|
| Acknowledgement of receipt  | Within **48 hours** (business hours, IST/UTC)|
| Substantive triage response | Within **5 business days**                   |
| Remediation — **Critical**  | Patch shipped within **7 calendar days** of confirmation; coordinated disclosure once patched |
| Remediation — **High**      | Patch shipped within **14 calendar days** of confirmation |
| Remediation — **Medium**    | Patch shipped within **30 calendar days** of confirmation |
| Remediation — **Low**       | Patch shipped within **90 calendar days** of confirmation, or in the next regularly scheduled release |
| Status updates              | Every **7 calendar days** while remediation is open |

Severity is assigned by the Grantex security responder based on CVSS v3.1
exploitability, scope, and impact. We will share our reasoning with the
reporter and adjust on substantive feedback. If the issue is in a third-party
dependency, the calendar starts when the upstream patch (or a Grantex
mitigation) is available.

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
| `gateway`           | `@grantex/gateway` — reverse-proxy, token enforcement     |
| `mcp` / `mcp-auth`  | MCP server and OAuth 2.1 auth server                      |
| `dpdp`              | `@grantex/dpdp` — DPDP compliance, consent handling       |
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

## Recognition (no monetary bug bounty)

Grantex does **not** currently operate a paid bug bounty programme. We are an
open-source project and a small commercial team; a formal monetary programme
is on the roadmap but is not in place today, and we will not invent one.

What we do offer:

- **Hall of Thanks** — researchers who report a valid vulnerability and follow
  this policy are credited by name (or anonymously, on request) at
  `https://grantex.dev/security/thanks` and in the release notes for the
  fix. **The page is provisioning-pending; until it is live we will keep an
  internal list and migrate it once the page ships.** TBD.
- **CVE assignment** — for qualifying issues we will request a CVE via the
  GitHub CNA and credit you in it.
- **Swag** — Grantex stickers / shirt, on request, when shipping logistics
  allow.

If you are reporting to us under a third-party VDP platform (e.g. HackerOne,
Bugcrowd) on behalf of one of our customers: please also send a copy to
`security@grantex.dev` so we can triage in parallel.

---

## Related procurement / compliance documents

- [Data Processing Addendum (template)](docs/compliance/dpa.md)
- [Sub-processor disclosure](docs/compliance/sub-processors.md)
- [Data residency statement](docs/compliance/data-residency.md)
- [Privacy Policy (draft)](docs/compliance/privacy-policy.md)
- [Terms of Service (draft)](docs/compliance/terms-of-service.md)
- [Cookie Policy (draft)](docs/compliance/cookie-policy.md)
- [SOC 2 readiness control mapping](docs/soc2-type1/report.md) — not a third-party attestation; see the file's own warning block.

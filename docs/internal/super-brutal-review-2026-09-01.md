# Grantex Super-Brutal Functional, Security, Supply-Chain, and License Review

**Review date:** 2026-09-01

**Baseline:** `3f453e766ab944ee701fc3c0d0b48071d326b65e`

**Scope:** tracked Grantex source, tests, examples, lockfiles, workflows,
containers, public documentation, SDK packages, and local Docker behavior.

## Verdict

The remediated checkout passed the repository's functional, dependency,
license-policy, documentation, and Docker E2E gates listed below. No known
dependency advisory remained in the 36 npm lockfiles or 14 Python install
surfaces at the time of review. Go analysis reported zero reachable or imported
package vulnerabilities; one no-fix advisory remains on the unimported
`golang.org/x/crypto/openpgp` package. No reviewed dependency
used AGPL, GPL, SSPL, BUSL, Commons Clause, Elastic, or PolyForm terms.

This is engineering evidence, not a warranty of security, non-infringement, or
legal compliance. Automated metadata cannot detect copied code, patent claims,
trademark conflicts, missing contributor assignments, or a dependency whose
published license metadata is inaccurate. Qualified counsel must review the
exact distributed artifacts and provenance before relying on a legal opinion.

## Findings Closed

### Critical

1. **Refresh recovery was erased by server restart.** Migration 093 cleared
   replay columns every time the idempotent migration runner started. A durable
   `grantex_migration_markers` sentinel now performs the legacy plaintext purge
   exactly once. A Docker harness proves encrypted response recovery survives
   an auth-service restart.
2. **OAuth lost-response recovery was incomplete.** Standard OAuth refresh now
   has a 300-second request-bound recovery path requiring the old token,
   client, DPoP key, and 16-256 character idempotency key. Mismatch still
   revokes the family. AES-256-GCM envelopes protect cached bearer material,
   and expiry cleanup removes it.

### High

1. **Caller retries changed identity.** TypeScript, Python, and Go clients now
   retain an automatically generated refresh retry key for five minutes in the
   current process. Callers can supply and durably persist an explicit key for
   restart/failover recovery.
2. **Server quota hints were clipped.** All three primary SDKs previously
   capped `Retry-After` at the ten-second exponential-backoff limit. They now
   honor the server window up to a defensive two-minute ceiling. This fixed a
   reproducible full-suite failure without weakening production limits.
3. **Known vulnerable dependency graphs existed.** `nanoid` was advanced to
   3.3.18 across affected locks; `body-parser` to 2.3.0 where resolved; the
   LangChain example moved to maintained `@langchain/core`; and Terraform's
   `x/net`, `x/text`, and `x/sys` graph was updated. Audits now report clean.
4. **Mutable build inputs.** Active third-party actions and service/base images
   are immutable SHA/digest pins. Tagged releases now attach generic SLSA
   provenance using official generator release `v2.1.0`.

### Medium

1. Dependabot omitted multiple npm, Python, Docker, and Go install surfaces.
   Every tracked manifest surface is now covered and CI enforces completeness.
2. Three generated example locks contained workstation-local `file:` paths.
   They were rebuilt portably, and policy now rejects local, drive, UNC, or
   temporary-directory resolutions.
3. Several TypeScript examples had stale APIs, no lockfile, or a `typecheck`
   command that only printed TypeScript help. Eleven standalone examples now
   install and genuinely typecheck in CI against registry and checkout shapes.
4. CodeQL alert 282 interpolated `null` implicitly in the JSONB probe. The
   probe now uses the intended explicit string.
5. License review depended on ad hoc checks. CI now classifies npm, Python, and
   Go graphs, fails unknown/unapproved terms, and requires notices for observed
   LGPL-3.0-or-later and CC-BY-4.0 material.
6. Vitest 4 no longer honored the old pool configuration. E2E files now run
   with one worker, and test timeouts accommodate one legitimate quota reset.
7. JWT payload decoders were reviewed call by call. Framework tool execution
   and A2A server middleware use JWKS-backed `verifyGrantToken()`. Remaining
   decoders are diagnostics, local A2A preflight, or audit metadata extraction,
   not authorization boundaries. A2A and Vercel documentation now states the
   actual verification timing and trust boundary.

## Verification Evidence

| Surface | Result |
|---|---|
| Auth service | Typecheck clean; 167 files passed, 1 skipped; 2,138 tests passed, 2 skipped |
| TypeScript SDK | Typecheck/build/package clean; 31 files and 456 tests passed |
| Python SDK | Ruff and strict Mypy clean; 612 tests passed; wheel/sdist built |
| Go SDK | `go test ./...` and `go test -race ./...` passed |
| Node packages | CLI, adapters, integrations, conformance, Gemma, x402, gateway, MCP, MPP, DPDP, and standalone package suites passed |
| Python integrations | FastAPI, CrewAI, OpenAI Agents, Google ADK, A2A, Gemma, and Strands tests plus strict Mypy passed |
| Portal | 938 tests, typecheck, and production build passed |
| Examples | Eleven TypeScript examples and the x402 weather example typechecked; Next.js starter built |
| Docker E2E | Fresh Postgres/Redis; all 93 migrations; 23 files and 255 tests passed |
| Crash boundary | `npm run test:e2e:refresh-restart` proved encrypted refresh recovery after container restart |
| npm supply chain | 36 lockfiles and 4,093 resolved entries; every npm audit clean |
| Python supply chain | 14 install surfaces; vulnerability and reviewed-license policy clean |
| Go supply chain | All three modules passed tests, `govulncheck`, and license checks |
| Documentation | 346/346 navigation targets resolved; public-doc integrity and SEO/AEO gates passed |
| Workflow syntax | Every workflow parsed as YAML; external references passed pin policy |

## Reviewed License Notices

- Optional Sharp/libvips platform packages in the Next.js example carry
  `LGPL-3.0-or-later` obligations when redistributed. See
  `THIRD_PARTY_NOTICES.md` and provide the required license/source-relocation
  information with the actual binary bundle.
- `caniuse-lite` includes CC-BY-4.0 browser compatibility data. Preserve its
  attribution when redistributing the data.
- Apache-2.0 for Grantex does not override dependency terms. The scanner's
  allowlist is a reviewed build policy, not a declaration that every possible
  use satisfies every license condition.

## Residual Risks and External Work

1. The portal production build emits one approximately 745 kB JavaScript chunk.
   It is a performance and cache-efficiency issue, not a correctness or known
   vulnerability finding. Route-level splitting should be scheduled.
2. Current Google Cloud/OpenTelemetry dependency paths still include deprecated
   `node-domexception@1.0.0` and `glob@10.5.0`. The audited versions have no
   known advisory in this graph; they remain monitored pending upstream removal.
3. The Go SDK requires `golang.org/x/crypto` for `cryptobyte` through JWX. The
   module also contains unsafe, unmaintained `openpgp` code (GO-2026-5932), but
   Grantex does not import that package and `govulncheck` reports zero reachable
   or imported-package findings. There is no fixed module version; replace the
   dependency path if upstream JWX removes it.
4. Dependency and license results are time-bound. Scheduled scans, Dependabot,
   artifact SBOMs, image scanning, signatures, and provenance must continue.
5. Production custody/payment providers, private plugins, secrets, network
   policy, data residency, incident response, backups, and legal agreements are
   operator-controlled and cannot be proven from this checkout.
6. SOC 2 attestation, counsel approval, published PGP material, the Hall of
   Thanks, GitHub team provisioning, and branch-protection activation remain
   external actions where the public repository already uses qualified wording.

## Release Conditions

Merge and deployment are permitted only after the pull request's required CI,
CodeQL, dependency review, and security scan are green. After merge, verify
Cloud Run and Firebase workflow conclusions from JSON, run production E2E and
MPP E2E, then publish SDK candidates through the trusted-publishing workflow.
Only after clean registry installs should candidate labels be changed to
published labels in a follow-up reviewed commit.

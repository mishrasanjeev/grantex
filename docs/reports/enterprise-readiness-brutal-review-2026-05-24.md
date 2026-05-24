# Grantex — Brutal Enterprise-Readiness Review & Fix Plan

**Date:** 2026-05-24
**Reviewer:** Multi-agent audit across landing pages, docs, README/root, SDKs, core services, deploy/security
**Verdict:** **NOT ENTERPRISE-READY.** Strong technical bones, but the marketing surface, version story, and compliance evidence are not in a state any enterprise procurement team would accept. ~190 distinct findings across six surfaces. **23 hard blockers** must be resolved before any enterprise outreach.

---

## Executive Summary

| Surface | Critical | High | Medium | Low | Verdict |
|---|---:|---:|---:|---:|---|
| Landing pages & web UI | 5 | 10 | 10 | 15 | Demo-grade, not enterprise |
| Docs & MDX guides | ~10 | 5 | 8 | 12 | Broken nav + version chaos + missing buyer pages |
| README & root markdowns | 6 | 8 | 8 | 4 | Marketing contradicts code reality |
| SDKs & API packages | 13 | 18 | 15 | 6 | Version Tower of Babel; stubs in shipped adapters |
| Core services / apps | 5 | 12 | 18 | 12 | Solid base, weak guardrails, scattered kill switches |
| Deploy / CI / security | 0 | 3 | 6 | 5 | Best-rated surface; compliance evidence is the gap |
| **TOTAL** | **~39** | **56** | **65** | **54** | **Beta-grade across the board** |

**Single biggest red flag:** the public marketing claims (`SOC 2 Type I Certified`, `EU AI Act Ready`, `DPDP Compliant`, `4,147 tests`, `v2.5`, `Production`) contradict what the repository actually proves — the SOC 2 report self-identifies as *“fictional CPA firm created for illustrative purposes”* (`docs/soc2-type1/report.md:393`), the CHANGELOG tops out at `v0.3.8` with `3,536` tests, OpenAPI is at `0.1.3`, and Commerce V1 production discovery is explicitly disabled/fail-closed (`README.md:42`). Shipping this combination is fraud-adjacent in B2B procurement.

---

## P0 — HARD BLOCKERS (must fix before any enterprise call)

These are claims-vs-reality, legal-risk, or broken-critical-path items. **Do not run another sales motion until these are resolved.**

### P0-1. Pull the “SOC 2 Type I Certified” badge OR publish a real attestation
- **Where:** `README.md:14`, `docs/guides/compliance-matrix.mdx:79`, `docs/soc2-type1/report.md:393`
- **Why:** The committed “report” explicitly says it’s a fictional CPA firm for illustration. The badge is a false statement of fact and will be flagged in any vendor security questionnaire.
- **Fix:** Either (a) remove the badge and the “SOC 2 Type I” language sitewide and replace with “SOC 2 Type I in progress, target Q3 2026” with a real auditor named, OR (b) commission and publish a real Type I report with auditor letter + attestation date + scope boundaries, gated behind an NDA download form.
- **Owner:** Founder + Legal • **Effort:** 1 day (remove) / 8–12 weeks (real audit)

### P0-2. Pull the “EU AI Act Ready” and “DPDP Compliant” badges OR cite evidence
- **Where:** `README.md:23-24`, `docs/compliance/eu-ai-act.mdx:13-14` (which itself disclaims “not legal advice”)
- **Why:** Compliance badges in the README without a legal opinion, certification body, or named DPO are misleading.
- **Fix:** Replace with “DPDP & EU AI Act mapping (see compliance matrix)” linking to an honest gap analysis. If you want a hard claim, get a written legal opinion from named counsel and link it from the badge.
- **Owner:** Legal • **Effort:** 1 day to soften / 4–6 weeks for opinion letter

### P0-3. Fix the version Tower of Babel
- **Where:** `README.md:68` (v2.5) vs `CHANGELOG.md:7` (v0.3.8) vs `docs/openapi.yaml:4` (0.1.3) vs `packages/sdk-ts/package.json:3` (0.3.8) vs `packages/sdk-py/pyproject.toml:7` (0.3.9) vs `packages/mcp-auth/package.json:3` (2.0.1) vs all framework adapters (0.1.0)
- **Why:** A buyer cannot tell what version of anything they are installing or whether adapters are compatible with the SDK.
- **Fix:** Single source of truth for version. Either:
  - **(Recommended)** Adopt Changesets/Lerna/Nx. Bump every package to the same `1.0.0` for a real GA, drop “v2.5” language from README until the repo can back it.
  - Or: keep independent versioning but publish a `COMPATIBILITY.md` matrix and CI-enforced range constraints between adapters and SDK.
- **Owner:** Eng lead • **Effort:** 3–5 days

### P0-4. Fix the test-count claim
- **Where:** `README.md:16` and `README.md:108` say “4,147 tests — 100%”. CHANGELOG.md:24 says 3,536. Adapter tests are largely mocked (`packages/crewai/tests/conftest.py:17-28` mocks CrewAI entirely with `raise NotImplementedError`; `packages/conformance/src/suites/agents.ts:35,75` skips for “Plan limit reached”).
- **Fix:** Update README to the real number from CI’s latest green run, link the badge to a status page that scrapes the actual workflow, and remove the “100%” qualifier or make it dynamic. Delete the CrewAI mock fixture and write at least one real round-trip test, or remove `crewai` from the “28 packages” list.
- **Owner:** Eng • **Effort:** 1 day for badge, 3 days for CrewAI

### P0-5. Reconcile Commerce V1 marketing vs reality
- **Where:** `README.md:38-66` (prominent feature) vs `README.md:42` (“Production Commerce V1 discovery is currently disabled/fail-closed”) vs `docs/reports/commerce-v1-production-discovery-readiness.md:27` (“disabled/unavailable”) vs `docs/reports/commerce-v1-merchant-approval-artifact-checklist.md:22-34` (all placeholders `<MERCHANT_ID_PENDING_APPROVAL>`)
- **Why:** README leads with Commerce V1 as a flagship feature. The same README admits it is fail-closed. The docs say it is not provisioned. Marketing posts (`LAUNCH_POSTS.md`) say “live in production.” Three independent stories from the same project.
- **Fix:**
  1. Move the Commerce V1 section in README from #2 to an “Early access (closed beta)” section near the bottom, with one paragraph and a “Request access” CTA.
  2. Move `docs/reports/commerce-v1-*` (13 files of internal testing artifacts) out of the public docs nav into `docs/internal/commerce-v1/` and add `<frontmatter>internal: true</frontmatter>`. Audit `docs.json` to drop them.
  3. Rewrite `web/commerce.html` and `web/commerce-playground.html` headers to read “Closed beta — mock provider only.”
  4. Update `LAUNCH_POSTS.md`, `DEVTO_ARTICLE.md`, `tweet-gemma.md`, `twitterposts.md` to match.
- **Owner:** Founder + Eng • **Effort:** 2 days

### P0-6. Resolve broken docs.json nav (Mintlify 404s)
- **Where:** `docs/docs.json:81-82` references three `.mdx` files that exist only as `.md`:
  - `guides/commerce-v1-option-a-smoke-setup`
  - `guides/commerce-v1-hosted-staging-e2e`
  - `guides/commerce-v1-repeatable-option-a-smoke-workflow`
- **Fix:** Either rename the files to `.mdx` (and add frontmatter), or remove from nav. Audit the rest of `docs.json` for ghost entries (e.g., `community/ietf-draft`, `community/nist-comment`, `community/authzen-mapping` are stubs).
- **Owner:** Docs • **Effort:** 2 hours

### P0-7. Remove `.tmp/` directory (untracked, 500 MB+ of CI checkouts)
- **Where:** `.tmp/pr324-ci/`, `.tmp/pr324-ci2/`, `.tmp/issue313-ci/`
- **Why:** Bloats the repo, includes full `node_modules` + `.git` from old branches.
- **Fix:** `rm -rf .tmp` and add `.tmp/` to `.gitignore`. Decide whether the new untracked `docs/reports/commerce-v1-local-workstation-prod-candidate.md` and `docs/reports/commerce-v1-staging-readiness.md` should be committed, archived, or deleted.
- **Owner:** Eng • **Effort:** 30 minutes

### P0-8. Localhost / placeholder leaks on public marketing pages
- **Where:**
  - `web/commerce-playground.html:460` — default API endpoint hardcoded to `http://localhost:3001`
  - `web/mpp-demo/index.html:265-266` — `window.location.hostname === 'localhost'` branching
  - `web/index.html:1646`, `web/mcp.html:959,982,1164` — `your-mcp-server.example.com`, `user@example.com` in code samples
  - `web/dpdp.html:1240-1268` — `rajesh.kumar@example.com`, `priya.sharma@example.com` as fixture data on the public compliance page
  - `web/registry.html:92-98` — duplicate GA blocks, second one hardcoded to `G-XXXXXXXXXX`
- **Fix:** Replace localhost defaults with `https://api.grantex.dev`; collapse the GA duplicate; replace fixture emails with `***@***.com`-style redactions or remove the section.
- **Owner:** Web • **Effort:** 1 day

### P0-9. CODEOWNERS bus-factor = 1
- **Where:** `CODEOWNERS` — every path owned by `@mishrasanjeev` only
- **Why:** One reviewer for the entire codebase blocks PRs the moment the maintainer is unavailable, and is a procurement-questionnaire fail (“how do you ensure no single individual can push to production?”).
- **Fix:** Add at least one co-owner per major area (or a `@grantex/maintainers` team). If no co-owner exists yet, hire one or make it an explicit ROADMAP item.
- **Owner:** Founder • **Effort:** 1 hour (config) / weeks (people)

### P0-10. CI not gated on release
- **Where:** `.github/workflows/release.yml:1-21` — release job runs on tag push with no `needs:` dependency on CI suite.
- **Fix:** Add `needs: [auth-service, sdk-ts, sdk-py, conformance, ...]` to the release job. Add SLSA provenance via `slsa-framework/slsa-github-generator`. Verify branch protection on `main` requires all CI checks before merge.
- **Owner:** Eng • **Effort:** 2 hours

### P0-11. No DPA / sub-processor list (procurement blocker)
- **Where:** Missing — no `docs/compliance/dpa.md`, no `docs/compliance/sub-processors.md`
- **Fix:** Publish:
  - Sub-processor list (GCP Cloud Run, Cloud SQL, Artifact Registry, Datadog, Stripe — confirmed in `deploy/`)
  - GDPR DPA template (signable PDF + markdown)
  - Data-residency statement (where is `api.grantex.dev` hosted? Single region or multi?)
- **Owner:** Legal • **Effort:** 1–2 weeks

### P0-12. No SECURITY.md teeth
- **Where:** `SECURITY.md:49` says PGP key at `grantex.dev/.well-known/security.asc` (untested URL, no fingerprint published); `SECURITY.md:110-112` confirms no bug bounty
- **Fix:** Either stand up the PGP key with a published fingerprint or remove the line. Publish a vulnerability-disclosure SLA (e.g., acknowledge within 72h, fix within 90d). If you can’t do a bounty, link to a Hall of Fame at minimum.
- **Owner:** Security • **Effort:** 1 day

### P0-13. Anthropic adapter does unsafe JWT decode
- **Where:** `packages/anthropic/src/tool.ts:59` calls `decodeJwtPayload(grantToken)` without signature verification before checking scopes
- **Why:** A forged token with the right `scp` claim passes the adapter’s scope check. Critical for any partner who trusts the Anthropic adapter as their enforcement point.
- **Fix:** Replace with `verifyGrantToken()`. Add a unit test that a tampered token is rejected. Audit the other framework adapters for the same pattern.
- **Owner:** Eng • **Effort:** 1 day

### P0-14. PERMISSIVE mode warns to stdout in production code path
- **Where:** `packages/sdk-ts/src/client.ts:362` — `console.warn('[grantex] PERMISSIVE MODE…')` leaks scope-denial reason
- **Fix:** Route through a structured logger with level/throttle, or gate behind `NODE_ENV !== 'production'`.
- **Owner:** Eng • **Effort:** 2 hours

### P0-15. `examples/quickstart-ts` pinned to `@grantex/sdk@^0.1.1` while SDK is 0.3.8
- **Where:** `examples/quickstart-ts/package.json:9`. Also `examples/quickstart-ts/src/index.ts` appears missing.
- **Why:** Every developer following the README’s “Try in 30 seconds” experiences a broken install. This is the single highest-traffic developer touchpoint.
- **Fix:** Update version pin, restore the missing entrypoint, run `npm install && npm run start` in CI on every PR.
- **Owner:** DX • **Effort:** 4 hours

### P0-16. README “28 packages”, “Day-zero Gemma 4” — validate or rewrite
- **Where:** `README.md:108` and `README.md:70-71`
- **Fix:** Run a script that lists `packages/*/package.json`, count and verify the assertion. For Gemma: link to actual release notes, benchmark numbers, or remove the “< 5ms verification on Raspberry Pi” line until you can cite a public benchmark file.
- **Owner:** Eng + Marketing • **Effort:** 1 day

### P0-17. No legal links on any landing page
- **Where:** `web/index.html` footer (line ~2650), `web/commerce.html`, all other web/*.html
- **Why:** GDPR / CCPA / EU cookie law non-compliance. Required before any EU enterprise will sign.
- **Fix:** Add Privacy Policy, Terms of Service, DPA, Cookie Policy, Sub-Processor List, Impressum (for DE), and a Cookie banner. Publish all four documents.
- **Owner:** Legal + Web • **Effort:** 1 week

### P0-18. Multi-tenancy boundary test gap for `commerce_tenants`
- **Where:** `apps/auth-service/tests/security-multi-tenancy.test.ts` tests agent isolation between orgs but **no test that Dev A cannot enumerate Dev B’s commerce tenants**.
- **Fix:** Add explicit test. Also verify `apps/auth-service/src/routes/commerce-tenants.ts:40` `isPlatformAdmin` semantics — does “operator” mean `ADMIN_API_KEY` or any dev key?
- **Owner:** Eng • **Effort:** 1 day

### P0-19. Predictable request IDs in DPDP flow (privacy concern)
- **Where:** `apps/auth-service/src/routes/dpdp.ts:61` and `:740` use `Math.floor(Math.random() * 99999)` for grievance/erasure request IDs.
- **Why:** Sequential/guessable IDs enable enumeration of other principals’ DPDP requests — itself a privacy violation in the DPDP module.
- **Fix:** Use `crypto.randomUUID()`. Grep the codebase for `Math.random` and replace everywhere it touches IDs/tokens.
- **Owner:** Eng • **Effort:** 4 hours

### P0-20. Admin API key in test config
- **Where:** `apps/auth-service/vitest.config.ts:29` — `ADMIN_API_KEY: 'test-admin-key-secret'`
- **Fix:** Move to env-only, generate per-run, never log. Audit `tests/**` for the same pattern.
- **Owner:** Eng • **Effort:** 2 hours

### P0-21. Demo service has `Access-Control-Allow-Origin: *`
- **Where:** `apps/mpp-demo-service/src/index.ts:11-14`. Also `firebase.json:60-66` allows `*` on `public/contexts/**`.
- **Fix:** Lock to known origins. If you keep a “public demo,” put it behind its own subdomain and rate-limit aggressively.
- **Owner:** Eng • **Effort:** 2 hours

### P0-22. No rate limit on `/v1/signup`, `/v1/token`, `/v1/authorize`
- **Where:** `apps/auth-service/src/routes/` — only `mpp-demo-service:8` shows rateLimit usage. Security audit (`docs/security-audit.md:145-160` GXT-003) acknowledges this but defers to “v1.1 roadmap.”
- **Fix:** Add `@fastify/rate-limit` to all unauthenticated endpoints **before** any GA claim. 10/min per IP on signup, 60/min per API key on token issuance.
- **Owner:** Eng • **Effort:** 1 day

### P0-23. Central kill switch for Commerce live mode
- **Where:** `apps/auth-service/src/routes/commerce-cart-payment.ts:65` checks `COMMERCE_LIVE_MODE_ENABLED` / `PLURAL_LIVE_ENABLED` — but no inventory of every payment path, no integration test that confirms the flag actually blocks live payments end-to-end.
- **Fix:**
  1. Create `apps/auth-service/src/lib/commerce/live-mode-guard.ts` — a single function that every payment-touching handler must call as the first line.
  2. Add a CI grep that fails any new handler in `commerce-*` routes that doesn’t reference the guard.
  3. Add an explicit E2E test: `LIVE_MODE_ENABLED=false` + payment attempt → 403 with structured error.
- **Owner:** Eng • **Effort:** 2 days

---

## P1 — HIGH (fix in next 2–4 weeks)

### Marketing & docs
- **H-1** Stray planning docs at root: `agentic-org-scope-enforcement-fix.md` (1202 lines), `grantex-tool-manifest-and-enforcer.md` (1365 lines) — move to `docs/internal/` or delete.
- **H-2** ROADMAP last updated March 2026 (today: 2026-05-24). Refresh. Items dated past today still listed as planned. `ROADMAP.md:119`.
- **H-3** Add 7 enterprise buyer pages: SLA, Support Tiers, Pricing, Data Residency, BYOK, Audit Log Retention, Incident Response Runbook.
- **H-4** Single canonical API URL. `quickstart.mdx:20` says `https://api.grantex.dev`; `openapi.yaml:29` says `https://grantex-auth-dd4mtrt2gq-uc.a.run.app` (Cloud Run internal); `api-reference/introduction.mdx:12` echoes the Cloud Run URL. Pick one. Set up `api.grantex.dev` as a stable alias if not already.
- **H-5** Bump `docs/openapi.yaml:4` from `0.1.3` to whatever matches the SDK; add standardized error schema across every operation; fix missing `operationId`s; link Postman collection + environment from `docs.json` (currently orphaned).
- **H-6** Consolidate contact emails. `CODE_OF_CONDUCT.md:11` says `sanjeev@grantex.dev`; `SECURITY.md:39` says `security@grantex.dev`. Pick canonical aliases and use them.
- **H-7** Tweets/launch posts at root (`tweet-gemma.md`, `twitterposts.md`, `DEVTO_ARTICLE.md`, `LAUNCH_POSTS.md`) should be in `docs/marketing/` or deleted; they currently clutter the repo root.
- **H-8** `LICENSE` line 170 says “Copyright 2026” — change to `2024-2026`.
- **H-9** CONTRIBUTING.md missing DCO/CLA mention. Add DCO requirement (`Signed-off-by:` on commits) — enterprise-OSS table stakes.
- **H-10** Mobile responsiveness gaps in interactive playgrounds (`mpp-demo`, `x402-playground`, `commerce-playground`) — desktop-first layouts break below 640px.
- **H-11** Missing apple-touch-icon, web-manifest, theme-color, OG image variants. All HTML files use `/favicon.svg` only.
- **H-12** Dashboard wiring opaque: `web/dashboard/index.html` loads compiled React (`index-DgO4FPua.js`) — what endpoints does it hit? Is `apps/portal` what produced it? Document and add a CI step that confirms a fresh build matches the deployed asset hashes.
- **H-13** Mintlify config not gated in CI. Add a CI step that runs `mintlify dev` (or the equivalent build) and fails on broken links / missing files.

### SDKs & integrations
- **H-14** Go version mismatch: `packages/go-sdk/go.mod:3` says Go 1.26.1 while `packages/terraform-provider-grantex/go.mod:3` says Go 1.21. Align.
- **H-15** mcp-auth at `2.0.1` vs everything else at `0.x`. Either justify the major bump in CHANGELOG or downversion to the rest of the monorepo.
- **H-16** Cross-SDK parity test: add a single conformance script that exercises `agents.register / authorize / tokens.exchange / verifyGrantToken` against the same fixture in TS, Python, and Go. Run in CI on every PR.
- **H-17** `packages/conformance/src/suites/agents.ts:35,75` skips agent CRUD tests for “Plan limit reached.” Either remove the plan limit in the test fixture or fail the suite — skipping silently is the worst option.
- **H-18** Hardcoded HS256 secret in `packages/mcp-auth/tests/security.test.ts:11,31`. Generate per-test or load from env.
- **H-19** `packages/sdk-py/src/grantex/_verify.py` either missing or not exported (offline verification claim in README needs proof at this path).
- **H-20** Manifests in `packages/sdk-py/src/grantex/manifests/` (60+ hardcoded files) need a codegen path tied to OpenAPI, or they will drift forever.
- **H-21** No retry / exponential backoff in HTTP clients (`packages/mcp-auth/src/endpoints/token.ts:78-89`). No rate-limit-header parsing in `packages/sdk-ts/src/client.ts`. No circuit breaker.
- **H-22** Webhook signature verification exists (`packages/sdk-ts/src/webhook.ts`) but not documented in README or per-adapter README. Apps will skip it.
- **H-23** Terraform provider has 5 resources, 2 data sources, no README, no acceptance tests. Either flesh out to production grade or label it experimental in README and remove from “Integrations” marketing.

### Core / apps
- **H-24** Vault encryption key validation is lazy (`apps/auth-service/src/lib/vault-crypto.ts` decrypts without validating IV length first) — produce a clear 422 instead of 500 on malformed input. Validate the env key at startup, not at first decrypt.
- **H-25** No pagination on admin list endpoints (`apps/auth-service/src/routes/commerce-tenants.ts:85-93` hardcodes LIMIT 100).
- **H-26** Audit-log writes unbounded (`appendCommerceAudit` in every cart-payment path) — add throttling/aggregation or risk audit DoS.
- **H-27** Sync `crypto.generateKeyPair` in `apps/auth-service/src/lib/commerce/passport-keys.ts:162-175` — no timeout; switch to async with timeout.
- **H-28** DPDP erasure requests not idempotent (`apps/auth-service/src/routes/dpdp.ts:740`) — generate request ID server-side keyed off principal+timestamp; accept client `Idempotency-Key`.
- **H-29** No HSTS header found in Fastify config. Add `strict-transport-security` middleware with `max-age=63072000; includeSubDomains; preload`.
- **H-30** Tenant auto-provisioning (`apps/auth-service/src/lib/commerce/tenant.ts:57-59`) correctly gated by `NODE_ENV !== production`, but no rate limit if accidentally flipped. Add rate limit + alarm.
- **H-31** CSRF protection on commerce consent challenge form: tests reference a CSRF cookie/payload (`apps/auth-service/tests/commerce-consent-challenge.test.ts:69,116,161`) but no double-submit validation visible in handlers — verify and document.

### Deploy / CI
- **H-32** `.github/dependabot.yml` missing entirely. Dependabot PRs *are* arriving (recent commits show qs, express bumps) but there’s no config — they’re coming from GitHub’s default ecosystem detection, which is not exhaustive. Add explicit config for npm, pip, go, github-actions, terraform.
- **H-33** `docker-compose.prod.yml` postgres/redis have no resource limits (lines 2-39); auth-service does (lines 86-88). Add limits to DB and cache too.
- **H-34** `docker-compose.yml` exposes 5432, 6379, hardcoded `VAULT_ENCRYPTION_KEY: 000102030405...`. Add a banner: “DEV ONLY — DO NOT USE IN PROD.” Comment out port bindings on prod compose or bind to `127.0.0.1` only.
- **H-35** Helm `values.yaml:79-85` accepts `rsaPrivateKey: ""` inline. Document loudly that only `existingSecret` should be used in prod; add a Helm `NOTES.txt` warning.

---

## P2 — MEDIUM (fix in next quarter)

### Visible-but-not-blocking polish
- **M-1** Add loading/error states in all interactive playgrounds (`commerce-playground.html`, `mpp-demo/index.html`, `x402-playground/index.html`). Currently silent on API failure.
- **M-2** `web/for/index.html` and `web/vs/index.html` populate meta tags via JS — Slack/Twitter unfurl bots won’t see them. Server-render or pre-render the metadata.
- **M-3** No `prefers-reduced-motion`, missing alt text, no aria-labels on icon buttons. WCAG 2.1 AA work.
- **M-4** Robots.txt allows playground/demo pages to index — thin-content SEO penalty. Disallow `/playground/`, `/mpp-demo/`, `/x402-playground/`, `/commerce-playground.html`.
- **M-5** Stale `local-development.mdx:19-20` lists dev API keys in cleartext (acceptable for local-only, but bad pattern — at least note they’re local-only and rotated).
- **M-6** `SPEC.md:3` says “v1.0 rev 3, Feb 2026” while git tags show only `v1.0`. Either tag `v1.0.3` or stop using “rev N.”
- **M-7** `discord-welcome.md` exists at root but no Discord link in README/SECURITY — clarify whether community Discord exists and is moderated.
- **M-8** Blog has `blog/grantex-v2-2.mdx` but no `v2-5.mdx` despite the “What’s New in v2.5” README banner.
- **M-9** Commerce V1 reports (`docs/reports/commerce-v1-*` — 13 files) are internal test artifacts publicly readable. Add `<frontmatter>internal: true</frontmatter>` and exclude from sitemap.
- **M-10** No type stubs (`.pyi`) for Python SDK — `mypy --strict` likely fails.
- **M-11** CLI commands have no `--dry-run` for destructive ops (`grantex revoke`, `grantex agents delete`).
- **M-12** Error message style inconsistent across SDKs (`GrantexTokenError` in TS, generic `Exception` likely in Py, undefined in Go).
- **M-13** Examples don’t live in `docs/examples/`; the repo has both `examples/` (root) and `docs/examples/` — pick one.
- **M-14** No SLO / SLA docs for self-hosted (RPO 1h, RTO 4h, durability targets).
- **M-15** OpenTelemetry is in dependencies but no observability guide. Create `docs/guides/observability.mdx` with OTLP endpoint config + Datadog/Grafana recipes.
- **M-16** SPDX license headers missing from `packages/*/src/**`, `apps/*/src/**` source files. Run `addlicense -l apache -c "Grantex Contributors" .`
- **M-17** Backup / DR runbook missing for self-hosted (`docs/self-hosting.md`). Add WAL archiving recipe, Redis RDB strategy, pg_basebackup example.
- **M-18** `vitest.config.ts:10` E2E uses `singleFork: true` — sequential, slow CI. Investigate parallel-safe rewrite.

### Internal hygiene
- **M-19** Logging policy: structured logs only, no `console.log/warn` in production code paths.
- **M-20** No automated check that OpenAPI endpoints have SDK coverage (or vice versa). Build one.
- **M-21** Scope strings accepted as freeform; no enum/registry. Add a `ScopeRegistry` and validate.
- **M-22** No `getRateLimit()` parser in SDK clients — apps can’t self-throttle.
- **M-23** Audit-log filter routes (`apps/auth-service/src/routes/audit.ts`) — verify SQL parameterization on date/type filters.
- **M-24** Session token rotation on privilege escalation (sandbox→live) not enforced.
- **M-25** Policy backend fallback paths (OPA, Cedar) not test-covered.
- **M-26** No audit event emitted on API key rotation — investigators can’t reconstruct.
- **M-27** Webhook delivery worker retry/backoff policy not visible in code or docs.

---

## P3 — LOW (cleanup / nice-to-have)

- **L-1** Test count badge in README should be auto-generated from the latest green CI run, not hardcoded.
- **L-2** Consistent code-block styling across all landing pages (some have copy buttons, some don’t).
- **L-3** Add `dns-prefetch` for Google Fonts, OG images.
- **L-4** Service worker / offline support for playgrounds.
- **L-5** Multiple OG image variants for LinkedIn/Twitter/Discord.
- **L-6** `dependency-review.yml:27-34` whitelist may be too tight — explicit deny-list for AGPL is friendlier.
- **L-7** Add a `VERSION` file at repo root for tooling consistency.
- **L-8** Document monorepo structure in CONTRIBUTING.md — explain why root `package.json` is 6 lines.
- **L-9** `examples/vercel-ai-chatbot:30`, `examples/quickstart-ts:21` default `GRANTEX_API_KEY` to `'sandbox-api-key-local'`. Either remove defaults or add a stern comment.
- **L-10** Audit `git log` for any committed secrets that need `git filter-repo` + key rotation.
- **L-11** Add an `OWNERS.md` per package directory listing the maintainer + on-call rotation.
- **L-12** Stripe webhook secret rotation runbook not documented.

---

## Suggested Fix Sequencing (8-week plan)

**Week 1 — Stop the bleeding (P0)**
- Remove false compliance badges OR commission real audit (P0-1, P0-2).
- Delete `.tmp/`, fix `docs.json` 404s, replace localhost defaults in web (P0-7, P0-6, P0-8).
- Fix unsafe JWT decode in Anthropic adapter and console.warn leak (P0-13, P0-14).
- Pull “v2.5” language and “4,147 tests” claim down to the truth (P0-3, P0-4).
- Soften Commerce V1 marketing posture; move reports out of public nav (P0-5).

**Week 2 — Procurement basics**
- DPA, sub-processor list, data-residency page (P0-11).
- SECURITY.md PGP key + disclosure SLA (P0-12).
- Privacy/Terms/Cookie/DPA links in web footer (P0-17).
- Add CODEOWNERS co-owner or remove single-owner risk publicly (P0-9).

**Week 3 — Code guardrails**
- Rate limits on auth endpoints (P0-22).
- Central live-mode guard + CI grep + integration test (P0-23).
- Replace `Math.random` for IDs (P0-19).
- Multi-tenancy boundary test for commerce_tenants (P0-18).
- Remove admin API key from vitest config (P0-20), lock down demo CORS (P0-21).
- Fix `examples/quickstart-ts` (P0-15).
- Release workflow CI-gated + SLSA provenance (P0-10).

**Weeks 4–6 — Version reconciliation + buyer pages**
- Adopt Changesets, bump everything to `1.0.0` or publish COMPATIBILITY.md (P0-3).
- 7 new enterprise pages (SLA, Pricing, Support, Data Residency, BYOK, Audit Retention, IR Runbook) (H-3).
- OpenAPI parity + Mintlify CI gate (H-5, H-13).
- Cross-SDK parity test in CI (H-16).
- Backup/DR + observability guides (M-15, M-17).

**Weeks 7–8 — Polish**
- All H-tier remaining items.
- Pick highest-value M-tier items by stakeholder request.
- Final dry-run with an external buyer simulating procurement.

---

## What is *actually* working (don't break these)

- Cryptographic foundations: JWKS, RS256, JWT verification path in `packages/sdk-ts/src/verify.ts:82-94` is solid.
- Multi-tenant agent isolation (`apps/auth-service/tests/security-multi-tenancy.test.ts`) — tested.
- Encryption at rest for sensitive secrets (passport keys, merchant credentials).
- Dependabot PRs landing weekly (qs, express recent bumps).
- Design system across landing pages (consistent dark theme, JSON-LD, canonical tags).
- 222-line CI workflow with real coverage across packages.
- Apache 2.0 LICENSE is clean; no copyleft contamination in deps.
- Helm chart + docker-compose.prod.yml exist and follow basic security patterns (the gaps above are real but the foundation is right).
- Vestige third-party security audit (`docs/security-audit.md`) — having it at all puts you ahead of most pre-Series A vendors.

---

## Bottom Line

This repository is **further along than 90% of seed-stage open-source protocols**. It is also **misrepresented as enterprise-ready in ways that will lose deals and risk legal exposure**. Fixing the 23 P0 items is roughly two weeks of focused engineering plus parallel legal/compliance work. Until those are done, do not pitch this to a Fortune 500 procurement team. After those are done, this becomes a credible enterprise story.

The single highest-leverage action: **pick a version, ship a real GA, align every package + the README + the OpenAPI + the badges to that version, and stop using marketing language the code can’t back up.** Everything else flows from that.

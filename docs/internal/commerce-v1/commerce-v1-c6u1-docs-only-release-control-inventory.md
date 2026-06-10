# Commerce V1 C6U1 Docs-Only Release Control Inventory

Status: internal release-control inventory and guard policy.

Data cutoff: 2026-06-09.

Baseline:

- C6U roadmap merged in Grantex PR #545 at `d463e141cecc13419fd9c985ea6c438c577e6572`.
- This C6U1 slice audits GitHub workflow behavior and documents docs-only release controls.

This document and the companion simulation script do not deploy, create cloud resources, change production config, touch secrets, turn on public discovery, turn on Commerce V1, turn on checkout/payment, turn on live payments, turn on live Plural, call payment providers, call merchant private APIs, alter production allowlists, publish protocol materials, submit protocol materials externally, or approve production readiness, public-launch readiness, certification, compliance, conformance, standardization, merchant approval, or real merchant launch.

## Executive Summary

Grantex already has the two most important deploy guards in place:

- `.github/workflows/deploy.yml` runs on `push` to `main` only when `apps/auth-service/**` or `.github/workflows/deploy.yml` changes, or when manually dispatched.
- `.github/workflows/deploy-portal.yml` runs on `push` to `main` only when `apps/portal/**`, `web/**`, `firebase.json`, `.firebaserc`, or `.github/workflows/deploy-portal.yml` changes, or when manually dispatched.

That means a docs-only planning change under `docs/**`, `README.md`, or root Markdown files does not automatically run Google Cloud auth, Docker build/push, Cloud Run deploy, Firebase deploy, production smoke tests, MPP production E2E, release artifact creation, or search-engine indexing/ping steps.

The remaining work in this slice is to record the workflow inventory and add deterministic docs-only classification validation. No workflow file required a functional change in this pass.

## Docs-Only Classification Rules

A change is docs-only only when every changed path is in this allowlist:

| Path class | Examples | Docs-only |
| --- | --- | --- |
| `docs/**` | `docs/internal/commerce-v1/file.md`, `docs/route_inventory.json` | yes |
| `README.md` | repository root README | yes |
| root-level `*.md` | `GRANTEX_COMMERCE_PRD.md`, `GRANTEX_COMMERCE_V1_BUILD_SPEC.md` | yes |

Everything else is non-docs-only. The classifier fails closed when uncertain.

Explicit non-docs-only paths include:

| Path class | Reason |
| --- | --- |
| `.github/workflows/**` | workflow behavior can change deploy, release, or secret handling. |
| `apps/**` | runtime application behavior can change. |
| `packages/**` | SDK/package behavior can change. |
| `scripts/**` | repository tooling can affect release gates. |
| `deploy/**` | deployment tooling can change cloud behavior. |
| `web/**` | public web assets can trigger portal deploy and public copy changes. |
| migration paths | schema/runtime state can change. |
| `Dockerfile*` | build/runtime image behavior can change. |
| `firebase.json`, `.firebaserc` | Firebase hosting/deploy behavior can change. |
| `package.json`, `package-lock.json`, lockfiles, `pyproject.toml` | dependency and build behavior can change. |
| config files | runtime or build config can change. |
| unknown paths | fail closed. |

The simulation script is `scripts/commerce-c6u1-release-control-simulate.mjs`.

## Current Workflow Inventory

| Workflow | Triggers | Deploy-adjacent surface | Current path filters or gate | Docs-only behavior | Runtime/workflow behavior |
| --- | --- | --- | --- | --- | --- |
| `ci.yml` | `pull_request` to `main`; `push` to `main` | Builds/tests auth service, packages, SDKs, portal; no cloud auth or deploy. | No path filter. | Runs. This is acceptable because it is local CI and includes Commerce Preview Conformance. | Runs for runtime, dependency, workflow, docs, and mixed changes. |
| `codeql.yml` | `push` to `main`; `pull_request` to `main`; weekly schedule | CodeQL security analysis; no deploy. | No path filter. | Runs. This is an appropriate security gate. | Runs for all PR/push changes and scheduled security analysis. |
| `dependency-review.yml` | `pull_request` to `main` | Dependency review only; no deploy. | No path filter. | Runs. Safe and useful on docs-only PRs. | Runs for dependency and mixed PRs. |
| `security-scan.yml` | `push` to `main`; `pull_request`; weekly schedule | Baseline scan starts local auth service with local Postgres/Redis. Full scan touches a production URL only on schedule. | Full scan has `if: github.event_name == 'schedule'`. | Baseline runs locally; full production URL scan does not run for docs-only PR/push. | Baseline runs on runtime/docs PR and push; scheduled full scan is independent of docs-only merges. |
| `deploy.yml` | `push` to `main` with paths; `workflow_dispatch` | Google Cloud auth, gcloud, Docker build/push, Artifact Registry, Cloud Run deploy. | Push paths are `apps/auth-service/**` and `.github/workflows/deploy.yml`. | Skips automatically for docs-only changes. | Auth-service changes and deploy workflow changes trigger deploy on `main`; manual dispatch remains human-controlled. |
| `deploy-portal.yml` | `push` to `main` with paths; `workflow_dispatch` | Firebase deploy, public site smoke tests against `grantex.dev`. | Push paths are `apps/portal/**`, `web/**`, `firebase.json`, `.firebaserc`, `.github/workflows/deploy-portal.yml`. | Skips automatically for docs-only changes. | Portal/web/Firebase config and portal deploy workflow changes trigger portal deploy on `main`; manual dispatch remains human-controlled. |
| `e2e.yml` | `workflow_dispatch` only | Production-like E2E against Cloud Run URL and Firebase rewrite URL; uses metrics secret. | Manual only. | Skips automatically because docs-only changes do not trigger it. | Runs only when explicitly dispatched by a human. |
| `e2e-mpp.yml` | `workflow_run` after `Deploy to Cloud Run`; `workflow_dispatch` | MPP production E2E against `https://api.grantex.dev`; uses E2E API key. | Job runs only on manual dispatch or successful `Deploy to Cloud Run` workflow run. | Skips automatically because docs-only changes do not trigger `Deploy to Cloud Run`. | Runs after a successful auth-service deploy or manual dispatch. |
| `monitor-mentions.yml` | daily schedule; `workflow_dispatch` | External GitHub/API/search/npm/PyPI checks and issue update. No deploy. | Schedule/manual only. | Skips automatically for docs-only PR/push. | Scheduled monitoring continues independently; manual dispatch remains human-controlled. |
| `release.yml` | tag push `v*` | Release preflight, release artifact, GitHub Release, id-token permission for release job. | Tag-only trigger. | Skips for docs-only branch or PR changes unless a tag is pushed. | Any tag push is release-adjacent and must be separately controlled. |
| `seo-ping.yml` | weekly schedule; `workflow_dispatch` | External Google/Bing/IndexNow pings. | Schedule/manual only. | Skips automatically for docs-only PR/push. | Scheduled pings continue independently; manual dispatch remains human-controlled. |

## Deploy-Adjacent Job List

Deploy-adjacent jobs are the ones that can touch cloud, public endpoints, release artifacts, production smoke URLs, external pings, or secrets:

| Workflow/job | Why deploy-adjacent | Docs-only automatic behavior |
| --- | --- | --- |
| `deploy.yml` / `deploy` | Google Cloud auth, Docker build/push, Artifact Registry, Cloud Run deploy. | Skips through push path filter. |
| `deploy-portal.yml` / `deploy` | Firebase deploy and public smoke tests. | Skips through push path filter. |
| `e2e-mpp.yml` / `e2e` | Production E2E and E2E API key after Cloud Run deploy. | Skips because Cloud Run deploy does not run for docs-only changes. |
| `e2e.yml` / `e2e` | Manual production-like E2E and metrics secret. | Manual only. |
| `release.yml` / `release` | GitHub Release and release artifact publication. | Tag-only. |
| `seo-ping.yml` / `ping` | External search/indexing pings. | Schedule/manual only. |
| `monitor-mentions.yml` / `monitor` | External API/search checks and issue mutation. | Schedule/manual only. |
| `security-scan.yml` / `zap-full` | Production URL full scan. | Schedule-only. |

## Jobs That Should Keep Running For Docs-Only Changes

These jobs should continue to run on docs-only PRs or main pushes because they are validation or local security gates, not deployment:

- `CI / Commerce Preview Conformance`
- `CI` package and service jobs
- `CodeQL Analysis`
- `Dependency Review`
- `Security Scan / OWASP ZAP Baseline Scan`
- external docs validation checks such as Mintlify, when GitHub Apps run them

Broad CI may be heavier than a reduced docs path, but it is intentionally retained here because the repository does not yet have a proven reduced-docs CI profile. C6U1 does not skip security gates.

## Jobs That Must Skip For Docs-Only Changes

These jobs must not be automatically triggered by docs-only changes:

- Google Cloud auth.
- Cloud Run deploy.
- Docker build/push.
- Artifact Registry push.
- Firebase deploy.
- production smoke tests after deploy.
- MPP production E2E.
- manual production E2E.
- release artifact and GitHub Release creation.
- external SEO/indexing pings caused by a docs-only merge.

The current automatic trigger behavior satisfies this for docs-only PR and push changes.

## Runtime-Change Behavior

Runtime changes must not be hidden by the docs-only policy:

| Change type | Expected behavior |
| --- | --- |
| `apps/auth-service/**` | Runs normal CI and triggers `Deploy to Cloud Run` on `main` push. |
| `apps/portal/**` | Runs normal CI and triggers `Deploy Portal` on `main` push. |
| `web/**` | Triggers `Deploy Portal` on `main` push. |
| `firebase.json` or `.firebaserc` | Triggers `Deploy Portal` on `main` push. |
| `packages/**` | Runs CI/package gates; no deploy unless a deploy path also changes. |
| dependency manifests or lockfiles | Runs CI/security/dependency gates; no deploy unless a deploy path also changes. |
| `scripts/**` | Non-docs-only; runs CI/security gates; no deploy unless a deploy path also changes. |
| unknown path | Non-docs-only; fail closed for classification. |

## Workflow-Change Behavior

Workflow changes are never docs-only.

- `.github/workflows/deploy.yml` changes intentionally trigger Cloud Run deploy on `main` because the workflow itself controls cloud deployment.
- `.github/workflows/deploy-portal.yml` changes intentionally trigger Firebase deploy on `main` because the workflow itself controls portal deployment.
- Other workflow changes are non-docs-only and require careful review even if they do not currently trigger deploy workflows.

## Tag And Release Behavior

`release.yml` runs only for tag pushes matching `v*`. A docs-only PR merge does not create a tag and therefore does not run release jobs. Any future tag push is a separate release event and must pass release preflight before a GitHub Release is created.

## Manual `workflow_dispatch` Behavior

Manual workflows remain manual:

- `deploy.yml`
- `deploy-portal.yml`
- `e2e.yml`
- `e2e-mpp.yml`
- `monitor-mentions.yml`
- `seo-ping.yml`

C6U1 does not change manual dispatch triggers. Manual dispatch is a human-controlled action and must not be used as a substitute for PR merge approval or docs-only classification.

## One-Time Merge Caveat

This C6U1 PR adds a script under `scripts/**`, so the classifier intentionally treats this PR as non-docs-only even though it does not change runtime Commerce behavior. It should still not trigger Cloud Run or Firebase deploy because neither deploy workflow includes `scripts/**` in its push paths.

No workflow file is changed in this C6U1 PR. If a future PR changes `.github/workflows/deploy.yml` or `.github/workflows/deploy-portal.yml`, that merge is intentionally deploy-adjacent and should be handled as a controlled workflow-change merge.

## Validation Matrix

The simulation script asserts this matrix:

| Scenario | Example paths | Expected docs-only |
| --- | --- | --- |
| Internal Commerce doc | `docs/internal/commerce-v1/example.md` | true |
| Root Markdown | `README.md`, `GRANTEX_COMMERCE_PRD.md` | true |
| Docs route inventory | `docs/route_inventory.json` | true |
| Runtime app | `apps/auth-service/src/index.ts` | false |
| Workflow | `.github/workflows/deploy.yml` | false |
| Script/tooling | `scripts/commerce-c6u1-release-control-simulate.mjs` | false |
| Dependency manifest | `package.json` | false |
| Mixed docs and runtime | `docs/internal/...`, `apps/auth-service/src/index.ts` | false |
| Dockerfile | `apps/auth-service/Dockerfile` | false |
| Firebase config | `firebase.json` | false |
| Unknown path | `notes/internal-plan.txt` | false |
| Empty change set | no paths | false |

Validation command:

```bash
node scripts/commerce-c6u1-release-control-simulate.mjs
```

## Stop Conditions

Stop and do not merge a future release-control change if any condition is true:

- Docs-only changes can trigger Google Cloud auth, Docker build/push, Artifact Registry push, Cloud Run deploy, Firebase deploy, production smoke tests, MPP production E2E, release artifact creation, or external indexing/ping steps.
- The classifier treats `.github/workflows/**`, `apps/**`, `packages/**`, `scripts/**`, `deploy/**`, `web/**`, dependency manifests, lockfiles, Dockerfiles, Firebase config, migrations, config files, or unknown paths as docs-only.
- A workflow change weakens the existing `deploy.yml` or `deploy-portal.yml` path filters without an explicit controlled rollout decision.
- A `workflow_run` chain can execute production E2E after a docs-only merge.
- A manual `workflow_dispatch` run is presented as automatic docs-only validation.
- A docs-only PR claims production readiness, public-launch readiness, certification, compliance, conformance, standardization, merchant approval, public discovery approval, checkout/payment approval, live provider approval, or live Plural approval.

## Explicit Non-Approval

This C6U1 release-control inventory does not approve production launch, public discovery, production Commerce V1, checkout/payment creation, live payments, live Plural, cloud deployment, production config, secrets, provider calls, merchant private API calls, production allowlists, protocol publication, external standards submission, certification, compliance, conformance, standardization, public-launch readiness, merchant approval, or production readiness. It documents and validates release-control behavior only.

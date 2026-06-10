# Commerce V1 C6Od Preview Conformance Status Page

Status: planned implementation as local internal status rendering.

Base:

- Grantex main: `80c16122f9d390f8982225fffb1bc418f3d5d145`
- C6Oc report generator:
  `scripts/commerce-c6oa-preview-conformance-validate.mjs`

C6Od adds a local docs/test-only renderer for the C6Oc JSON conformance report.
It produces internal-only status artifacts on request. It does not add runtime
APIs, routes, migrations, portal UI, production configuration, public discovery,
checkout or payment behavior, provider calls, merchant private API calls,
published protocol materials, or certification claims.

The status page is internal preview evidence only. It is not public protocol
publication, not a certification artifact, and does not enable public discovery,
production Commerce V1, checkout or payment creation, live payments, provider
calls, merchant private API calls, production allowlists, secrets, credentials,
or runtime connector execution.

## Generate A Source Report

Create a C6Oc report in a review or temporary directory:

```bash
node scripts/commerce-c6oa-preview-conformance-validate.mjs \
  --write-report \
  --json-report <temp-or-review-path>/report.json \
  --markdown-report <temp-or-review-path>/report.md
```

## Render Internal Status

Render internal status artifacts from the JSON report:

```bash
node scripts/commerce-c6od-preview-status-render.mjs \
  --report <temp-or-review-path>/report.json \
  --json-status <temp-or-review-path>/status.json \
  --markdown-status <temp-or-review-path>/status.md
```

If `--json-status` and `--markdown-status` are omitted, the renderer validates
the report and prints a summary without writing status files. This prevents
timestamp churn during normal local validation.

## Status Contents

The JSON and Markdown status artifacts include:

- internal preview status
- internal preview conformance badge label, message, and color
- fixture count
- surface count
- scan count
- per-surface status
- blocker summary
- forbidden-claim scan summary
- non-enabling control summary
- safety posture summary
- explicit internal preview, non-publication, and non-certification language

The required surfaces are:

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata preview

Passing reports render `internal preview conformance: passing`. Failed reports
render `internal preview conformance: failing`; a failed source report must not
produce a passing badge.

## Stop Conditions

Stop the slice if the renderer, generated status artifacts, or docs:

- publish public protocol materials or public badge/status pages
- enable public discovery or production Commerce V1
- enable checkout, payment creation, public checkout, or live payment paths
- enable live-provider behavior, provider calls, or provider credential use
- allow AgenticOrg direct execution against merchant systems
- include secrets, credentials, DB URLs, raw payloads, provider metadata,
  concrete private IDs, or concrete allowlist values
- write production configuration or production allowlists
- claim UCP, ACP, AP2, schema.org, MPP, A2A, provider, or live-payment
  certification
- treat sandbox, demo, synthetic, or test output as production readiness
  approval

## Validation

C6Od validation should include:

- `node scripts/commerce-c6oa-preview-conformance-validate.mjs --write-report --json-report <temp>/report.json --markdown-report <temp>/report.md`
- `node scripts/commerce-c6od-preview-status-render.mjs --report <temp>/report.json --json-status <temp>/status.json --markdown-status <temp>/status.md`
- `npm --prefix apps/auth-service test -- commerce-c6oc-conformance-report.test.ts commerce-c6od-conformance-status.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  provider credentials, overclaims, direct provider calls, direct merchant
  private API calls, and AgenticOrg direct execution enablement

## Rollback

This slice is local status rendering only. To roll it back, remove:

- `scripts/commerce-c6od-preview-status-render.mjs`
- `apps/auth-service/tests/commerce-c6od-conformance-status.test.ts`
- `docs/internal/commerce-v1/commerce-v1-c6od-preview-conformance-status-page.md`
- any generated review status artifacts if a reviewer created them locally

No runtime flags, production configuration, provider credentials, connector
credentials, public discovery settings, checkout/payment behavior, live-provider
behavior, cloud resources, or deployment workflow changes are created by this
slice.

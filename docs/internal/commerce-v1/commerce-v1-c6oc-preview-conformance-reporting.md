# Commerce V1 C6Oc Preview Conformance Reporting

Status: implemented as local report generation for release review.

Base:

- Grantex main: `45cc43080bc87bd961d8bd9a9c0033335f0fb926`
- C6Oa fixture corpus: `docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/`
- C6Ob validator: `scripts/commerce-c6oa-preview-conformance-validate.mjs`

C6Oc extends the local C6Ob validator with optional conformance report
generation. The default validator command remains validation-only and does not
write files. Reports are generated only when a reviewer passes `--write-report`.

The report is internal preview evidence only. It is not public protocol
publication, not a certification artifact, and does not enable public discovery,
production Commerce V1, checkout or payment creation, live payments, provider
calls, merchant private API calls, production allowlists, secrets, credentials,
or runtime connector execution.

## Validation-Only Command

Run from the repository root:

```bash
node scripts/commerce-c6oa-preview-conformance-validate.mjs
```

Expected success output:

```text
commerce C6Oa preview conformance validation passed
{
  "status": "passed",
  "fixtures_checked": 10,
  "surfaces_checked": 5,
  "scans_checked": 104,
  "manifest": "docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/manifest.json"
}
```

This mode must not create JSON or Markdown report files.

## Report Generation Command

For release review, write reports explicitly:

```bash
node scripts/commerce-c6oa-preview-conformance-validate.mjs \
  --write-report \
  --json-report docs/internal/commerce-v1/reports/open-protocol-preview-conformance.report.json \
  --markdown-report docs/internal/commerce-v1/reports/open-protocol-preview-conformance.report.md
```

If report timestamps would create unnecessary churn, generate reports during the
review workflow and do not commit the generated files unless a release reviewer
requests a pinned artifact for that review. Tests use temporary report paths and
do not depend on committed timestamps.

## Report Contents

The JSON and Markdown reports include:

- `generated_at`
- source manifest path
- fixture corpus version
- fixture count
- surface count
- scan count
- per-surface results
- per-fixture results
- blocker summary
- forbidden-claim scan summary
- non-enabling control summary
- safety posture summary
- explicit internal preview, non-publication, and non-certification statement

The required surfaces are:

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata preview

## Failure Behavior

If validation fails and `--write-report` is present, the script writes reports
with `status: failed`, includes failure details, and exits non-zero. This lets a
release reviewer inspect the failed report without treating it as passing
evidence.

Failure reports are still internal preview artifacts. They must not be used to
publish public protocol materials, claim certification, enable public discovery,
enable checkout/payment creation, or enable live provider paths.

## Stop Conditions

Stop report generation and fix the fixture, validator, or docs if a report or
validator run shows any of the following:

- public discovery or production Commerce V1 enablement
- checkout, payment creation, public checkout, or live payment enablement
- live-provider enablement, provider credential exposure, or provider calls
- merchant private API calls or AgenticOrg direct execution against merchant
  systems
- secrets, credentials, DB URLs, raw payloads, provider metadata, private IDs, or
  concrete allowlist values
- production configuration assignment or production allowlist assignment
- UCP, ACP, AP2, schema.org, MPP, A2A, provider, or live-payment certification
  claim
- sandbox, demo, synthetic, or test data treated as production readiness
  evidence

## Validation

C6Oc validation should include:

- `node scripts/commerce-c6oa-preview-conformance-validate.mjs`
- `node scripts/commerce-c6oa-preview-conformance-validate.mjs --write-report --json-report <temp-or-review-path> --markdown-report <temp-or-review-path>`
- `npm --prefix apps/auth-service test -- commerce-c6oa-preview-fixtures.test.ts commerce-c6ob-preview-validator.test.ts commerce-c6oc-conformance-report.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  provider credentials, overclaims, direct provider calls, direct merchant
  private API calls, and AgenticOrg direct execution enablement

## Rollback

This slice is local reporting only. To roll it back, remove:

- C6Oc report-generation changes from
  `scripts/commerce-c6oa-preview-conformance-validate.mjs`
- `apps/auth-service/tests/commerce-c6oc-conformance-report.test.ts`
- `docs/internal/commerce-v1/commerce-v1-c6oc-preview-conformance-reporting.md`
- any generated review reports under `docs/internal/commerce-v1/reports/` if
  they were created during review

No runtime APIs, migrations, production configuration, provider credentials,
connector credentials, public discovery settings, checkout/payment behavior,
live-provider behavior, cloud resources, or deployment workflow changes are
created by this slice.

# Commerce V1 C6Oe Preview Conformance CI Release Gate

Status: implemented as local CI and release-review validation.

Base:

- Grantex main: `4cd9987ef0c72c075755ef3bafe74926e7297ae8`
- C6Oa fixtures:
  `docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/`
- C6Ob validator:
  `scripts/commerce-c6oa-preview-conformance-validate.mjs`
- C6Oc report generator:
  `scripts/commerce-c6oa-preview-conformance-validate.mjs --write-report`
- C6Od status renderer:
  `scripts/commerce-c6od-preview-status-render.mjs`

C6Oe adds a deterministic local gate that composes the C6Oa-C6Od chain. It is
validation only. It does not add runtime APIs, routes, migrations, portal UI,
production configuration, public discovery, checkout or payment behavior, live
payment behavior, provider calls, merchant private API calls, public protocol
publication, or certification claims.

The gate is internal preview evidence only. It is not public protocol
publication, not a certification artifact, and does not enable public discovery,
production Commerce V1, checkout or payment creation, live payments, provider
calls, merchant private API calls, production allowlists, secrets, credentials,
or runtime connector execution.

Public publication remains blocked: this is not public protocol publication and
not a certification artifact.

## PR CI Behavior

PR CI runs the deterministic gate:

```bash
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr
```

This mode:

- runs C6Ob fixture validation
- generates C6Oc JSON and Markdown reports in a temporary directory
- renders C6Od JSON and Markdown status artifacts in the same temporary
  directory
- parses the generated JSON artifacts
- asserts fixture, surface, and scan counts
- asserts all five preview surfaces are present
- asserts report and status posture agree
- asserts failed reports cannot produce passing status
- asserts blocked fixtures include blocker evidence
- asserts available fixtures preserve synthetic, sandbox-only, preview-only,
  non-live, non-enabling, non-publication, and non-certifying posture
- removes temporary artifacts before exiting

The CI workflow job is named `Commerce Preview Conformance`. It does not
authenticate to cloud, build or push Docker images, deploy, call providers, call
merchant private APIs, use secrets, or create cloud resources.

## Release-Review Behavior

Release reviewers can generate local review artifacts explicitly:

```bash
node scripts/commerce-c6oe-preview-conformance-gate.mjs \
  --mode release-review \
  --work-dir <temp-or-review-dir>
```

This mode writes the following files inside the requested work directory only:

- `open-protocol-preview-conformance.report.json`
- `open-protocol-preview-conformance.report.md`
- `open-protocol-preview-conformance.status.json`
- `open-protocol-preview-conformance.status.md`

The work directory is required, must be a directory, must not be the repository
root, must not be a filesystem root, and must not be inside `.git`.

Generated artifacts are local review evidence. Do not commit timestamped report
or status artifacts unless a later approved release-packaging task explicitly
requests a pinned artifact.

## Required Surfaces

The gate requires all five C6O preview surfaces:

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata preview

## Failure Behavior

The gate exits nonzero if:

- fixture validation fails
- report JSON or status JSON does not parse
- fixture, surface, or scan counts differ from the expected corpus
- any required surface is missing
- report status and rendered status disagree
- a failed report produces a passing status or badge
- blocked fixture blocker evidence is missing
- available fixtures lose non-production posture
- internal preview, non-publication, non-certification, or non-enabling posture
  is missing
- generated artifacts contain secret markers, private commerce IDs, provider
  metadata, raw payloads, concrete allowlist values, provider credential
  markers, public discovery enablement, checkout/payment enablement, live
  payment enablement, provider-call enablement, merchant private API enablement,
  or certification/publication overclaims

## Stop Conditions

Stop and fix the fixture, validator, report, status renderer, gate, or docs if
any output:

- publishes public protocol materials or public status pages
- enables Grantex or AgenticOrg public discovery
- enables production Commerce V1
- enables checkout, payment creation, public checkout, or live payments
- enables live Plural or any live provider path
- enables provider calls or merchant private API calls
- includes secrets, credentials, DB URLs, raw payloads, provider metadata,
  concrete private IDs, or concrete allowlist values
- writes production configuration or production allowlists
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, protocol-publication, or
  live-payment certification
- treats sandbox, demo, synthetic, or test output as production approval

## Validation

C6Oe validation should include:

- `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr`
- `node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode release-review --work-dir <temp>`
- `npm --prefix apps/auth-service test -- commerce-c6oc-conformance-report.test.ts commerce-c6od-conformance-status.test.ts commerce-c6oe-preview-gate.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check origin/main...HEAD`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live payment and
  provider credentials, overclaims, direct provider calls, direct merchant
  private API calls, and AgenticOrg direct execution enablement

## Rollback

This slice is local validation and CI gating only. To roll it back, remove:

- `scripts/commerce-c6oe-preview-conformance-gate.mjs`
- `apps/auth-service/tests/commerce-c6oe-preview-gate.test.ts`
- `docs/internal/commerce-v1/commerce-v1-c6oe-preview-conformance-ci-release-gate.md`
- the `Commerce Preview Conformance` job from `.github/workflows/ci.yml`
- any local release-review artifacts generated under a reviewer-provided
  directory

No runtime flags, production configuration, provider credentials, connector
credentials, public discovery settings, checkout/payment behavior, live-provider
behavior, cloud resources, or deployment workflow changes are created by this
slice.

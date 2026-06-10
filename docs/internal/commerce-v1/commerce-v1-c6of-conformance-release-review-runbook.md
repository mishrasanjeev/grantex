# Commerce V1 C6Of Conformance Release Review Runbook

Status: implemented as an internal release-review runbook and first gated
release rehearsal.

Base:

- Grantex main: `c72a16e523cd2545c234fd144835aeca350ef36d`
- C6Oa fixtures:
  `docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/`
- C6Ob validator:
  `scripts/commerce-c6oa-preview-conformance-validate.mjs`
- C6Oc report generator:
  `scripts/commerce-c6oa-preview-conformance-validate.mjs --write-report`
- C6Od status renderer:
  `scripts/commerce-c6od-preview-status-render.mjs`
- C6Oe gate:
  `scripts/commerce-c6oe-preview-conformance-gate.mjs`

C6Of defines the human release-review process for the C6Oa-C6Oe conformance
chain. The process is internal preview evidence only. It is sandbox-only,
non-live, non-enabling, not public protocol publication, and not a certification
artifact. It does not enable public discovery, production Commerce V1, checkout
or payment creation, live payments, live Plural, provider calls, merchant
private API calls, production allowlists, secrets, credentials, or runtime
connector execution.

The result is not a certification artifact.

Evidence status: not public publication and not certification.

## First Gated Release Rehearsal

Run the rehearsal from a clean local checkout:

```bash
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode release-review --work-dir <local-review-dir>
```

Use an explicit local work directory such as:

```bash
node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode release-review --work-dir .tmp/commerce-c6of-release-review
```

The work directory is local reviewer evidence. Do not use the repository root, a
filesystem root, `.git`, or a shared/public publishing directory. Do not commit
generated timestamped report or status artifacts unless a later approved
release-packaging task explicitly requests a pinned artifact.

Expected artifacts written under `<local-review-dir>`:

- `open-protocol-preview-conformance.report.json`
- `open-protocol-preview-conformance.report.md`
- `open-protocol-preview-conformance.status.json`
- `open-protocol-preview-conformance.status.md`

## Reviewer Checklist

- Confirm the reviewed branch or release candidate is based on the intended
  Grantex main commit.
- Confirm no manual deploy, deploy workflow trigger, cloud command, cloud
  resource creation, production config write, secret access, provider call, or
  merchant private API call is part of the review.
- Run the release-review command with an explicit local work directory.
- Confirm the command exits zero and prints `commerce C6Oe preview conformance
  gate passed`.
- Parse `open-protocol-preview-conformance.report.json` and
  `open-protocol-preview-conformance.status.json`.
- Confirm the report says `status: passed` and the status output says
  `status: passing`.
- Confirm the expected counts remain `fixtures_checked: 10`,
  `surfaces_checked: 5`, and `scans_checked: 104`.
- Confirm all five surfaces are present:
  schema.org JSON-LD preview, UCP-style capability profile preview, ACP-style
  checkout shape preview, AP2-style evidence preview, and connector registry
  metadata preview.
- Confirm blocked fixtures include blocker and remediation evidence.
- Confirm available fixtures preserve synthetic, sandbox-only, preview-only,
  non-live, non-enabling, non-publication, and non-certifying posture.
- Confirm the Markdown report and Markdown status page include blocker summary,
  forbidden-claim scan summary, non-enabling controls, safety posture, and
  preview/internal-only language.
- Confirm generated artifacts stay under the explicit local work directory and
  no generated report or status files are staged for commit.
- Run the focused guardrail scans listed below before approving release-review
  evidence.

## Required Surface Labels

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata preview

## Pass Criteria

The rehearsal passes only when all of the following are true:

- the C6Oe gate exits zero in `--mode release-review`
- exactly the four expected report and status artifacts are present under the
  explicit work directory
- report and status JSON parse successfully
- report and status agree on passing posture
- fixture count is 10, surface count is 5, and scan count is 104
- all five preview surfaces are present
- blocked fixtures include blocker and remediation evidence
- available fixtures preserve non-production posture
- public discovery, checkout/payment creation, live payments, live Plural,
  provider calls, merchant private API calls, production allowlists, production
  config writes, secrets, provider credentials, raw payloads, private commerce
  IDs, and certification/publication overclaims are absent
- the evidence is retained as local/internal review material only

## Fail Criteria

The rehearsal fails if any of the following occur:

- the C6Oe gate exits nonzero
- an expected artifact is missing or an unexpected generated artifact appears in
  the repository tree
- report or status JSON fails to parse
- report and rendered status disagree
- a failed report produces a passing status or passing badge
- fixture, surface, or scan counts differ from the expected corpus
- any required preview surface is missing
- blocked fixture blocker evidence is missing
- available fixtures lose synthetic, sandbox-only, preview-only, non-live,
  non-enabling, non-publication, or non-certifying posture
- any output enables or implies public discovery, checkout/payment creation,
  live payment, live Plural, provider calls, merchant private API calls,
  production allowlists, production config writes, secrets, credentials, raw
  payloads, private IDs, public publication approval, production approval, or
  certification approval

## Stop Conditions

Stop the release review and fix the underlying fixture, validator, report,
status renderer, gate, docs, or tests if any evidence:

- publishes public protocol materials or public status pages
- enables Grantex public discovery or AgenticOrg public commerce discovery
- enables production Commerce V1
- enables checkout, payment creation, public checkout, live payments, or live
  Plural
- calls or enables payment providers, provider APIs, or merchant private APIs
- stores or exposes secrets, credentials, DB URLs, raw payloads, provider
  metadata, private commerce IDs, or concrete allowlist values
- writes production configuration or production allowlists
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, protocol-publication, or
  live-payment certification
- treats sandbox, demo, synthetic, or test data as production approval
- requires cloud commands, cloud resources, manual deploys, or manual deploy
  workflow triggers

## Evidence Retention

Release-review artifacts are local/internal evidence only. Retain them in the
explicit local work directory for the reviewer session, or move them to an
approved internal evidence store only after a separate review policy allows it.

Do not commit generated timestamped report or status artifacts. Do not publish
the generated Markdown status page or JSON report as public protocol material.
Do not attach artifacts containing secrets, private merchant data, provider
metadata, raw payloads, production config, provider credentials, concrete
allowlists, or private commerce IDs.

If the review needs a durable reference, record the reviewed commit, command,
work-directory name, report status, status badge, fixture count, surface count,
scan count, reviewer, and review date in the internal review tracker. Keep that
tracker entry explicit that the result is preview/internal evidence only, not
public publication and not certification.

## Focused Guardrail Scans

Run or confirm focused scans for:

- secrets and private details
- production config and allowlist assignments
- public discovery enablement
- checkout/payment enablement
- live payment, live Plural, and provider credential enablement
- overclaims, public protocol publication claims, and certification claims
- direct provider calls
- direct merchant private API calls
- generated report or status artifacts staged for commit

Expected scan hits in tests or scripts should be limited to denylist regex
literals, negative assertions, or explicit stop-condition text.

## Rollback

C6Of is docs and tests only. To roll it back, remove:

- `docs/internal/commerce-v1/commerce-v1-c6of-conformance-release-review-runbook.md`
- `apps/auth-service/tests/commerce-c6of-release-review-runbook.test.ts`

Delete any local `<local-review-dir>` generated during rehearsal. There are no
runtime flags, production config changes, provider credentials, connector
credentials, public discovery settings, checkout/payment behavior, live-provider
behavior, cloud resources, migrations, routes, portal UI changes, or deployment
workflow changes to roll back.

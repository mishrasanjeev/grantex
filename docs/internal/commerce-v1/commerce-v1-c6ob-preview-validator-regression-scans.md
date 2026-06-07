# Commerce V1 C6Ob Preview Validator Regression Scans

Status: implemented as local validator automation.

Base:

- Grantex main: `036aa21cc26926d0f4aadbe65d0553d5b6949e30`
- C6Oa fixture corpus: `docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/`

C6Ob adds a local validator for the C6Oa preview conformance fixture corpus. It
is docs/test automation only. It does not add runtime APIs, migrations,
connector execution, provider calls, cloud actions, production configuration,
secrets, public discovery, checkout or payment creation, live payments, or
certification claims.

## Validator Command

Run from the repository root:

```bash
node scripts/commerce-c6oa-preview-conformance-validate.mjs
```

Expected success output starts with:

```text
commerce C6Oa preview conformance validation passed
```

The command validates:

- fixture manifest kind, version, status, and global controls
- checked-in fixture existence and exact manifest coverage
- required surfaces and both preview-available and blocked/refusal scenarios
- sandbox-only, preview-only, non-live, non-enabling, non-publication, and
  non-certifying posture
- empty certification claim arrays and `none` certification-claim fields
- no public discovery, production Commerce V1, checkout/payment, live-provider,
  provider-call, merchant-private-API, AgenticOrg direct-execution, allowlist,
  publication, or certification enablement
- surface-specific schema expectations for schema.org JSON-LD, UCP-style,
  ACP-style, AP2-style, and connector registry previews

## Regression Scans

The validator scans the C6Oa fixture corpus and C6Oa docs for:

- secrets, tokens, private keys, DB URLs, bearer tokens, and credential markers
- concrete private commerce identifiers
- production configuration and allowlist assignments
- public discovery enablement
- checkout/payment enablement
- live-provider or provider credential enablement
- certification or production approval overclaims
- direct provider calls, merchant private API calls, and AgenticOrg direct
  execution enablement
- checkout URLs, provider payment references, provider metadata objects, and raw
  payload objects

The scans are intentionally local and deterministic. They do not call external
services and do not create cloud resources.

## Stop Conditions

Stop the slice if any validator failure shows that a fixture or doc:

- enables public discovery or production Commerce V1
- enables checkout, payment creation, public checkout, or live payments
- enables provider calls or merchant private API execution
- allows AgenticOrg direct execution against merchant systems
- includes secrets, credentials, raw payloads, provider metadata, or concrete
  private IDs
- writes production allowlists or production configuration values
- claims UCP, ACP, AP2, schema.org, MPP, A2A, provider, or live-payment
  certification
- treats sandbox, demo, synthetic, or test data as production approval

## Validation

C6Ob validation should include:

- `node scripts/commerce-c6oa-preview-conformance-validate.mjs`
- `npm --prefix apps/auth-service test -- commerce-no-plural-leak.test.ts commerce-openapi.test.ts commerce-c6oa-preview-fixtures.test.ts commerce-c6ob-preview-validator.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check`
- focused guardrail scans for secrets/private details, production config and
  allowlists, public discovery, checkout/payment enablement, live provider and
  provider credentials, overclaims, direct provider calls, direct merchant
  private API calls, and AgenticOrg direct execution enablement

## Rollback

This slice is local validation only. To roll it back, remove:

- `scripts/commerce-c6oa-preview-conformance-validate.mjs`
- `apps/auth-service/tests/commerce-c6ob-preview-validator.test.ts`
- `docs/internal/commerce-v1/commerce-v1-c6ob-preview-validator-regression-scans.md`

No runtime flags, production configuration, provider credentials, connector
credentials, public discovery settings, checkout/payment behavior, live-provider
behavior, cloud resources, or deployment workflow changes are created by this
slice.

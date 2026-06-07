# Commerce V1 C6Oa Preview Conformance Fixtures

Status: implemented as internal synthetic fixture corpus.

Base:

- Grantex main: `80def0d6a6ccd61a5418d8a0628ffc533b08def0`
- AgenticOrg C6I merge: `d02657be67c4be256cd1f0b3d52d46e20c5de891`

C6Oa adds checked-in synthetic fixtures for the accepted C6I-C6N open-protocol
preview surfaces. The fixtures are used by tests to prove that preview payloads
remain sandbox-only, preview-only, non-live, non-publication, non-certifying,
and non-enabling.

Fixture directory:

`docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/`

Covered surfaces:

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata/source precedence preview

Each surface has a preview-available example and a blocked/refusal example. The
fixtures use a shared conformance envelope so tests can enforce the same safety
posture across all preview formats.

## Guardrails

The fixtures are internal test artifacts only. They do not publish protocol
metadata, enable public discovery, enable production Commerce V1, create
checkout or payment objects, enable live payments, call providers, call merchant
systems, store credentials, write production allowlists, or claim certification.

The fixture tests reject:

- secrets, tokens, private keys, DB URLs, raw payloads, raw signatures, and
  credentials
- private tenant, merchant, catalog, cart, payment, consent, passport, audit, or
  connector identifiers
- checkout URLs and provider payment references
- provider metadata values
- public discovery, production, checkout, payment, live-provider, provider-call,
  merchant-private-API, AgenticOrg direct-execution, allowlist, publication, or
  certification enablement

## Validation

C6Oa validation should include:

- `node scripts/commerce-c6oa-preview-conformance-validate.mjs`
- `npm --prefix apps/auth-service test -- commerce-no-plural-leak.test.ts commerce-openapi.test.ts commerce-c6oa-preview-fixtures.test.ts`
- `npm --prefix apps/auth-service run typecheck`
- `git diff --check`
- focused scans for secrets/private details, production config/allowlists,
  public discovery, checkout/payment enablement, live payment/provider
  credentials, overclaims/certification claims, direct provider calls, and
  direct merchant private API calls

## Rollback

This slice is docs and tests only. To roll back C6Oa, remove the fixture
directory, this document, and `apps/auth-service/tests/commerce-c6oa-preview-fixtures.test.ts`.
No runtime flags, provider configuration, production configuration, secrets, or
cloud resources are created by this slice.

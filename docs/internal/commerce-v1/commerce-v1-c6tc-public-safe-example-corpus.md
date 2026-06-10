# Commerce V1 C6Tc - Public-Safe Standards Example Corpus

Status: internal draft-preparation note only.

Created: 2026-06-09.

C6Tc creates an internal public-safe example corpus for future Agentic Commerce
IETF and NIST draft preparation. The examples are generic, synthetic,
non-live, non-enabling, and stripped of private implementation identifiers,
real merchant data, provider details, production configuration, and
certification claims.

This package is not an IETF submission, not a NIST submission, not public
protocol publication, not public guidance, not certification, not conformance,
not compliance, not production authorization, not public discovery
authorization, not checkout/payment authorization, not provider authorization,
and not live-payment authorization.

This package does not deploy, merge, create cloud resources, change production
configuration, touch secrets, enable public discovery, enable production
Commerce V1, enable checkout or payment creation, enable live payments, enable
live Plural, call payment providers, call merchant private APIs, set production
allowlists, or claim certification.

## Scope

C6Tc adds a docs-only and fixture-only corpus under:

- `docs/internal/commerce-v1/standards/examples/`;
- `docs/internal/commerce-v1/commerce-v1-c6tc-public-safe-example-corpus.md`.

No runtime files, routes, migrations, portal UI, workflows, jobs, provider
adapters, production configuration, cloud resources, public documentation
publication, public discovery settings, checkout/payment behavior,
live-provider behavior, merchant private API behavior, production allowlists, or
external submissions are added.

## Why Public-Safe Examples Are Needed

The C6T standards-preparation plan identified a gap: future IETF and NIST
drafts need examples that explain agentic commerce concepts without carrying
private implementation state. Internal preview fixtures are useful evidence,
but they may contain product-specific names, repo-specific states, or
implementation labels that should not become public draft examples.

C6Tc provides a small sanitized corpus that reviewers can use to reason about:

- read-only discovery success;
- checkout/payment refusal;
- capability profiles;
- consent and evidence envelopes;
- connector source metadata and source precedence;
- schema.org-style public-safe product and offer previews;
- ACP-style blocked checkout shapes;
- AP2-style unsigned evidence previews.

These examples are for internal draft preparation only. Future public use
requires separate public-safe review, legal review, security review, and
explicit approval to submit or publish.

## Public-Safe Transformation Rules

The corpus is derived from internal preview fixture concepts, not copied from
private payloads. C6Tc applies these transformations:

| Source concern | Public-safe transformation |
| --- | --- |
| Real merchant data | Replaced with `Example Home Goods Merchant`. |
| Private merchant, tenant, product, session, payment, and evidence IDs | Replaced with synthetic IDs such as `mer_example_home_001`, `item_example_lamp_001`, `variant_example_lamp_warm_001`, `buyer_session_example_001`, and `evidence_example_001`. |
| Provider-specific status or metadata | Replaced with generic provider-boundary refusal or not-invoked states. |
| Private connector payloads | Replaced with source health, freshness, precedence, and redaction summaries only. |
| Production config and allowlists | Omitted; every example marks production approval and public discovery as false. |
| Certification or approval language | Omitted; every example uses empty `certification_claims`. |
| Checkout/payment behavior | Represented only as blocked or not enabled. |
| Live provider behavior | Represented only as disabled or not invoked. |

## Required Example Markers

Every JSON example includes:

- `internal_example_only: true`;
- `synthetic_data: true`;
- `public_submission_status: "not_submitted"`;
- `certification_claims: []`;
- `production_approval: false`;
- `public_discovery_enabled: false`;
- `checkout_payment_enabled: false`;
- `live_provider_enabled: false`.

The manifest also repeats these markers as global corpus controls.

## Corpus Inventory

| File | Purpose |
| --- | --- |
| `agentic-commerce-example-corpus.manifest.json` | Indexes corpus controls, files, scenarios, and required refusal coverage. |
| `buyer-session.discovery.available.json` | Shows internal read-only discovery success without public discovery or checkout enablement. |
| `buyer-session.checkout-refused.json` | Shows checkout/payment refusal with required refusal reasons. |
| `capability-profile.read-only.json` | Shows a read-only capability profile with browse-only state. |
| `capability-profile.blocked.json` | Shows blocked discovery and checkout capability state. |
| `evidence-envelope.consent-preview.json` | Shows a redacted consent/evidence preview without tokens, credentials, raw payloads, or provider metadata. |
| `connector-source-metadata.dry-run.json` | Shows connector source metadata, freshness, dry-run, and source precedence without private source payloads. |
| `schemaorg-product-offer.preview.json` | Shows schema.org-style public-safe product/offer preview fields without publication. |
| `acp-style-checkout-shape.blocked.json` | Shows ACP-style checkout shape mapping with checkout blocked. |
| `ap2-style-evidence.unsigned-preview.json` | Shows AP2-style unsigned evidence preview with no mandate, token, provider call, or payment enablement. |

## Refusal Coverage

The corpus includes blocked/refusal examples for:

- `consent_required`;
- `public_discovery_disabled`;
- `checkout_not_enabled`;
- `live_payment_not_enabled`;
- `merchant_private_api_not_allowed`;
- `provider_call_not_allowed`;
- `stale_inventory`.

Refusal details are safe for draft review and do not expose private merchant
policy, provider metadata, private URLs, credentials, raw payloads, production
configuration, or concrete allowlists.

## Future IETF and NIST Use

Future IETF or NIST drafts may reference this corpus only after:

1. public-safe review confirms no private implementation details remain;
2. legal review confirms the examples can be reused externally;
3. security review confirms no sensitive identifiers, secrets, raw payloads, or
   production configuration are present;
4. product review confirms the examples do not imply production approval,
   certification, conformance, compliance, provider approval, or live-payment
   readiness;
5. separate explicit approval authorizes external submission or publication.

C6Tc itself does not grant any of those approvals.

## Stop Conditions

Stop and require a new explicitly authorized work item if any follow-up:

- submits material to IETF;
- submits material to NIST;
- submits a NIST public comment, project description, collaborator request, or
  NCCoE package;
- publishes public protocol materials or public guidance;
- claims IETF submission, RFC status, NIST approval, NCCoE acceptance, UCP
  certification, ACP certification, AP2 certification, schema.org
  certification, MPP approval, A2A approval, provider certification,
  conformance, compliance, or live-payment certification;
- includes real merchant names, real addresses, real phone numbers, real
  emails, PAN, GST, tax IDs, production IDs, provider credentials, tokens,
  JWTs, passports, idempotency keys, webhook secrets, DB/Redis URLs, private
  keys, raw payload dumps, production config values, concrete allowlists, real
  provider references, or platform-private tenant/merchant IDs;
- enables public discovery, production Commerce V1, checkout/payment creation,
  live payments, live Plural, provider calls, merchant private API calls, cloud
  resources, production config, routes, migrations, portal UI, workflows, or
  production allowlists;
- treats synthetic, sandbox, preview, dry-run, remediation, triage, or rehearsal
  output as production approval.

## Validation

C6Tc validation must include:

```bash
git diff --check origin/main...HEAD
```

Every JSON example must parse. Focused scans must cover:

- secrets, credentials, tokens, private URLs, raw payloads, provider metadata,
  real merchant details, production identifiers, and production config values;
- production config, production allowlists, public discovery,
  checkout/payment, live provider, live Plural, provider calls, and merchant
  private API enablement;
- IETF, NIST, RFC, NCCoE, certification, conformance, compliance, provider,
  public guidance, public-comment, public publication, or live-payment
  overclaims;
- real merchant names, private data, private URLs, provider credentials, raw
  payloads, concrete allowlists, and production identifiers;
- Grantex-private IDs and provider-specific references.

## Rollback

C6Tc is docs/fixture-only. Roll back by removing:

- `docs/internal/commerce-v1/commerce-v1-c6tc-public-safe-example-corpus.md`;
- `docs/internal/commerce-v1/standards/examples/agentic-commerce-example-corpus.manifest.json`;
- `docs/internal/commerce-v1/standards/examples/buyer-session.discovery.available.json`;
- `docs/internal/commerce-v1/standards/examples/buyer-session.checkout-refused.json`;
- `docs/internal/commerce-v1/standards/examples/capability-profile.read-only.json`;
- `docs/internal/commerce-v1/standards/examples/capability-profile.blocked.json`;
- `docs/internal/commerce-v1/standards/examples/evidence-envelope.consent-preview.json`;
- `docs/internal/commerce-v1/standards/examples/connector-source-metadata.dry-run.json`;
- `docs/internal/commerce-v1/standards/examples/schemaorg-product-offer.preview.json`;
- `docs/internal/commerce-v1/standards/examples/acp-style-checkout-shape.blocked.json`;
- `docs/internal/commerce-v1/standards/examples/ap2-style-evidence.unsigned-preview.json`.

No cloud action, deployment action, secret rotation, migration, route removal,
production configuration change, public discovery change, checkout/payment
change, live-provider change, merchant private API change, production allowlist
change, external submission, public publication, certification action, or
NIST/NCCoE engagement action is required.

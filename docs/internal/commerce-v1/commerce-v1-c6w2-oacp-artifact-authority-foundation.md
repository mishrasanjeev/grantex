# Commerce V1 C6W2 - OACP Artifact Authority Foundation

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W2 adds pure internal helper behavior for Grantex-owned OACP trust artifacts.

This slice adds:

- Internal artifact issue helper for public-safe canonical JSON payloads.
- Canonical JSON payload hash calculation.
- Detached JWS signature requirement for issued envelopes.
- Internal verify and status helper for payload hash, signature shape, issuer key metadata, TTL, revocation, and all-four scope checks.
- Focused tests for valid and fail-closed artifact status decisions.

No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live provider, merchant private API, allowlist, cloud, or protocol publication behavior is added.

## Internal Issue Helper

Grantex remains the trust, protocol, policy, and canonical-artifact authority.

The C6W2 issue helper:

- Accepts only public-safe payloads.
- Rejects private, raw connector, raw provider, credential, secret, token, enablement, and allowlist fields.
- Computes a canonical JSON payload hash.
- Builds an OACP internal envelope with issuer, issuer key ID, policy version, revocation status URL, TTL, freshness, and safety metadata.
- Requires an active issuer key metadata record.
- Requires a detached JWS signature before the envelope is considered issued.
- Refuses issuance when the artifact TTL exceeds the pinned default for its type.

The helper does not own raw signing keys in this slice. Signing is supplied by an internal callback so tests can prove the envelope contract without introducing secrets or key custody.

## Internal Verify And Status Helper

The C6W2 verify/status helper checks:

- Payload has no private or enabling fields.
- Safety metadata is public-safe and not private.
- `issued_at`, `not_before`, and `expires_at` are valid.
- Effective TTL is no longer than the pinned default for the artifact type.
- Signature algorithm is ES256.
- Signature is a detached JWS, not the C6W1 placeholder.
- Canonical JSON payload hash matches the envelope hash.
- Issuer key metadata is trusted, active, and valid for the current time.
- Artifact scope matches tenant, merchant, seller agent, and buyer agent when expected.
- Artifact ID or subject ID is not revoked.
- Detached JWS verification succeeds through an injected internal verifier callback.

The status helper returns a fail-closed refusal code for invalid, stale, revoked, untrusted, out-of-scope, or unverifiable artifacts.

## What This Does Not Enable

C6W2 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider use.
- Live Plural use.
- Provider calls.
- Merchant private API calls.
- Connector credential storage in Grantex.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, or live-provider readiness claims.

## Stop Conditions

Stop later implementation if:

- Raw credentials, tokens, private provider payloads, raw JWTs, bank details, card details, private customer identifiers, or merchant private API values enter OACP artifacts.
- Grantex becomes a synchronous dependency for every browse, comparison, recommendation, or non-binding message.
- Internal issuer-key tests are replaced with real secrets in repo code.
- Artifact verification permits placeholder signatures.
- TTLs or offline caps are raised without explicit approval.
- Public discovery, checkout/payment, live provider, live Plural, production allowlists, or external protocol publication are enabled before approved gates.

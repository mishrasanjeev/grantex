# C6Oa Preview Conformance Fixtures

Status: internal fixture corpus only.

These files provide synthetic examples for Agentic Commerce open-protocol
preview conformance checks. They are not public protocol publication, not
schema.org publication, not UCP certification, not ACP certification, not AP2
certification, not provider certification, not production approval, not public
discovery approval, and not checkout or payment approval.

The corpus covers both preview-available and blocked/refusal examples for:

- schema.org JSON-LD preview
- UCP-style capability profile preview
- ACP-style checkout shape preview
- AP2-style evidence preview
- connector registry metadata/source precedence preview

Every fixture must remain synthetic, sandbox-only, preview-only, non-live,
non-enabling, non-publication, and non-certifying. Fixtures must not include
private tenant IDs, private merchant IDs, internal product or payment IDs,
secrets, credentials, provider metadata, raw payloads, allowlists, production
configuration, checkout URLs, provider payment references, live-provider
settings, or certification claims.

## Stop Conditions

Stop and remove the fixture from review if a future change:

- enables public discovery
- enables production Commerce V1
- enables checkout or payment creation
- enables public checkout
- enables live payments or live provider execution
- stores or displays credentials, tokens, private keys, raw payloads, or raw
  signatures
- introduces production allowlists or production configuration values
- calls a provider or merchant private API
- allows AgenticOrg direct execution against merchant systems
- claims protocol, provider, public-discovery, or live-payment certification
- treats sandbox, demo, synthetic, or test data as production approval

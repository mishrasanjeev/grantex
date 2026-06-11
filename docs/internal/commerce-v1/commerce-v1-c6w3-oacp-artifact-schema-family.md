# Commerce V1 C6W3 - OACP Artifact Schema Family

Status: implementation foundation, internal-only, non-enabling.

## Scope

C6W3 makes the internal OACP artifact family explicit and testable before protocol adapters, seller cards, offline commitment execution, or hosted agent bridges are built.

This slice adds:

- Internal schema descriptors for every C6W1 artifact type.
- Synthetic valid fixture and blocked fixture per artifact family.
- Pure helper validation for envelope fields, safety fields, required payload fields, TTL posture, detached JWS metadata, and family-specific guardrails.
- Focused tests for valid fixtures, blocked fixtures, unknown types, missing safety, private/raw/enabling fields, stale time windows, protocol adapter TTL, mandate provider verification, public discovery offline refusal, and commitment evidence execution claims.

No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live provider, merchant private API, allowlist, cloud, deploy, or protocol publication behavior is added.

## Artifact Families

All artifact families require the C6W1/C6W2 envelope baseline:

| Envelope field group | Required fields |
| --- | --- |
| Identity | artifact_id, artifact_type, schema_version, issuer, issuer_key_id, subject_type, subject_id |
| Scope | tenant_id, merchant_id, seller_agent_id, buyer_agent_id where applicable |
| Time and freshness | issued_at, expires_at, source_observed_at where applicable, freshness_class |
| Trust status | revocation_status_url, policy_version, evidence_refs |
| Signature metadata | payload_hash, signature_alg, detached JWS signature |
| Safety | public_safe, contains_private_data, allowed_agent_uses, forbidden_agent_uses, commitment_allowed, offline_commitment_allowed, requires_online_confirmation, requires_provider_direct_verification, requires_merchant_system_confirmation, stale_behavior, refusal_code_if_invalid |

| Artifact family | Required payload fields | Scope posture |
| --- | --- | --- |
| merchant_capability | merchant_display_name, merchant_category, supported_countries, supported_currencies, commerce_status, public_discovery_state, source_evidence_refs | tenant and merchant |
| seller_agent_capability | seller_agent_id, merchant_id, agent_runtime, supported_channels, supported_tasks, forbidden_tasks, public_claim_limits | tenant, merchant, seller agent |
| catalog_snapshot | catalog_snapshot_id, product_refs, category_refs, source_system_refs, private_field_redaction_status, sample_count | tenant, merchant, seller agent |
| offer | offer_id, product_id, variant_id, currency, offer_valid_from, offer_valid_until, price_lock_allowed | tenant, merchant, seller agent, buyer agent |
| price | product_id, variant_id, amount_minor_units, currency, price_source, price_valid_until | tenant, merchant, seller agent, buyer agent |
| inventory | product_id, variant_id, availability_state, quantity_bucket, hold_allowed, stale_inventory_refusal | tenant, merchant, seller agent, buyer agent |
| policy | return_policy_summary, warranty_policy_summary, fulfillment_policy_summary, cancellation_policy_summary, support_policy_summary, jurisdiction_scope | tenant, merchant, seller agent |
| public_discovery | discovery_state, allowed_surfaces, blocked_surfaces, display_name, public_description, allowed_protocol_adapters, publish_offline_allowed | tenant, merchant, seller agent |
| mandate_capability | provider_key, rail_type, jurisdiction, mandate_capability_ref, buyer_agent_id, merchant_scope, max_amount, currency, verification_mode, provider_direct_verification_required | tenant, merchant, seller agent, buyer agent |
| commitment_evidence | commitment_id, commitment_type, buyer_agent_id, seller_agent_id, merchant_id, artifact_refs_used, policy_decision, offline_commitment_mode, forbidden_execution_claims | tenant, merchant, seller agent, buyer agent |
| revocation | revocation_list_id, revoked_artifact_ids, revoked_subject_ids, reason_codes, effective_at, emergency_disable | tenant |
| protocol_adapter | adapter_type, adapter_version, referenced_artifact_ids, referenced_artifact_expires_at, generated_from_artifact_hashes, public_claim_limits | tenant, merchant, seller agent |

## Fixture Corpus

The C6W3 fixture corpus is synthetic and public-safe.

Valid fixtures:

- Use fake tenant, merchant, seller-agent, buyer-agent, subject, evidence, and artifact IDs.
- Use canonical JSON payload hashes.
- Use detached JWS-shaped placeholder signatures that are not real credentials.
- Use disabled public discovery state.
- Use non-sensitive provider reference strings only for mandate capability.
- Avoid real merchant names, raw connector payloads, raw provider payloads, credentials, secrets, raw JWTs, production allowlists, and live payment/provider flags.

Blocked fixtures:

- One fixture per artifact family omits a required payload field and must fail closed.
- Additional tests mutate fixtures to prove private fields, missing safety, unknown artifact types, stale time windows, protocol adapter TTL violations, mandate verification gaps, public discovery offline changes, and forbidden commitment execution claims are refused.

## Future Adapter Consumption

Future schema.org, UCP-style, ACP-style, AP2-style, A2A, and MCP adapters must consume these artifacts as signed internal inputs.

Adapter rules:

- Adapter output must be derived from Grantex-signed canonical artifacts.
- Protocol adapter artifacts cannot outlive the shortest referenced artifact.
- Adapter previews are internal until a separate publication gate exists.
- Adapter output cannot invent merchant facts, payment authority, mandate authority, public discovery approval, merchant approval, or production readiness.
- AgenticOrg may render or route adapter-derived facts, but Grantex remains the canonical artifact authority.

## What This Does Not Enable

C6W3 does not enable:

- Public discovery.
- Production Commerce V1.
- Checkout/payment creation.
- Payment capture or debit.
- Live payments.
- Live provider use.
- Live Plural use.
- Provider calls.
- Carrier or shipping provider calls.
- Merchant private API calls.
- Connector credential storage in Grantex.
- Production allowlists.
- Public OACP publication.
- External protocol submission.
- Certification, compliance, conformance, standardization, production readiness, public-launch readiness, merchant approval, checkout approval, payment approval, live provider readiness, or OACP public readiness claims.

## Stop Conditions

Stop later implementation if:

- Raw credentials, tokens, private provider payloads, raw JWTs, bank details, card details, private customer identifiers, raw connector payloads, or merchant private API values enter artifacts.
- Public discovery publish or unpublish becomes possible from an offline artifact.
- Mandate capability is treated as provider-owned execution authority instead of non-sensitive evidence requiring direct provider verification at commitment time.
- Commitment evidence implies payment capture, refund execution, settlement, payout, fulfillment start, or merchant approval.
- Protocol adapters outlive referenced artifacts or make external publication claims.
- Grantex becomes a synchronous dependency for every browse, comparison, recommendation, or non-binding message.
- TTLs, caps, or revocation windows are raised without explicit approval.
- Public discovery, checkout/payment, live provider, live Plural, production allowlists, or external protocol publication are enabled before approved gates.

## Next Slices

Recommended next slices:

- C6W4: AgenticOrg commitment-boundary resolver over cached signed artifacts.
- C6W5: Offline Commitment Mode evidence and reconciliation contract, docs/tests first.
- C6W6: Plural P3P capability evidence design using approved sandbox or non-production access only.
- C6W7: Seller Commerce Agent onboarding packet and Grantex intake validation.
- C6W8: Merchant connector evidence path from dry-run source snapshots to Grantex canonical facts.
- C6W9: Internal protocol adapter previews from signed artifacts only.

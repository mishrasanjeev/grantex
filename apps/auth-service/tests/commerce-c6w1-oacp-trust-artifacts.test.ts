import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_ARTIFACT_SIGNATURE_PROFILE,
  OACP_ARTIFACT_TTLS_SECONDS,
  OACP_CONNECTOR_CREDENTIAL_CUSTODY,
  OACP_FIRST_E2E_BRIDGES,
  OACP_FIRST_RELEASE_RISK_CAPS,
  OACP_REVOCATION_SLA_TARGETS_SECONDS,
  OACP_REVOCATION_SNAPSHOT_MAX_AGE_SECONDS,
  assertNoForbiddenOacpArtifactFields,
  buildOacpArtifactCacheKey,
  buildUnsignedOacpArtifactEnvelope,
  canonicalizeOacpPayload,
  evaluateOacpOfflineCommitment,
  hashOacpPayload,
  riskTierForOacpOfflineAction,
  type OacpOfflineCommitmentInput,
} from '../src/lib/commerce/oacp-trust-artifacts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w1-oacp-trust-artifact-foundation.md',
);
const PRD_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6w-oacp-trust-artifact-implementation-prd.md',
);

const BASE_OFFLINE_INPUT: OacpOfflineCommitmentInput = {
  action: 'price_lock',
  amount_minor_units: 99900,
  currency: 'INR',
  total_quantity: 1,
  max_quantity_per_sku: 1,
  artifacts_valid: true,
  artifacts_scoped_to_all_four: true,
  artifacts_allow_offline_commitment: true,
  effective_artifact_age_seconds: 30,
  effective_artifact_ttl_seconds: 300,
  revocation_snapshot_age_seconds: 30,
  merchant_confirmation: true,
  provider_verification: false,
};

describe('C6W1 OACP trust artifact foundation', () => {
  it('pins canonical JSON plus detached JWS as the first internal artifact format', () => {
    expect(OACP_ARTIFACT_SIGNATURE_PROFILE).toMatchObject({
      payload_format: 'canonical_json',
      signature_format: 'detached_jws',
      first_algorithm: 'ES256',
      artifact_container: 'json_object',
      jwt_container_allowed: false,
      cose_first_version: false,
      ad_hoc_signed_json_allowed: false,
    });

    const a = canonicalizeOacpPayload({ z: 1, a: { b: 2, a: 1 } });
    const b = canonicalizeOacpPayload({ a: { a: 1, b: 2 }, z: 1 });
    expect(a).toBe(b);
    expect(hashOacpPayload({ z: 1, a: 2 })).toBe(hashOacpPayload({ a: 2, z: 1 }));
  });

  it('pins first-release caps, quantity limits, and revocation age windows', () => {
    expect(OACP_FIRST_RELEASE_RISK_CAPS.low.currency_caps).toMatchObject({
      INR: 2500000,
      USD: 30000,
    });
    expect(OACP_FIRST_RELEASE_RISK_CAPS.medium.currency_caps).toMatchObject({
      INR: 1000000,
      USD: 12500,
    });
    expect(OACP_FIRST_RELEASE_RISK_CAPS.high.currency_caps).toMatchObject({
      INR: 500000,
      USD: 6000,
    });
    expect(OACP_FIRST_RELEASE_RISK_CAPS.critical.offline_allowed).toBe(false);
    expect(OACP_FIRST_RELEASE_RISK_CAPS.medium.total_quantity_cap).toBe(5);
    expect(OACP_FIRST_RELEASE_RISK_CAPS.high.per_sku_quantity_cap).toBe(1);

    expect(OACP_REVOCATION_SNAPSHOT_MAX_AGE_SECONDS).toMatchObject({
      informational: 86400,
      low: 21600,
      medium: 900,
      high: 120,
      critical: null,
    });
  });

  it('pins artifact TTLs and revocation propagation SLA ownership targets', () => {
    expect(OACP_ARTIFACT_TTLS_SECONDS).toMatchObject({
      merchant_capability: 86400,
      seller_agent_capability: 21600,
      policy: 21600,
      catalog_snapshot: 21600,
      offer: 900,
      price: 300,
      inventory: 60,
      public_discovery: 900,
      mandate_capability: 120,
      protocol_adapter: 86400,
    });
    expect(OACP_REVOCATION_SLA_TARGETS_SECONDS).toEqual({
      provider_high_risk: 30,
      merchant_inventory_price: 60,
      merchant_emergency_disable: 30,
      merchant_other_operational: 300,
      agenticorg_high_critical_cache_purge: 30,
      agenticorg_medium_refresh: 120,
      grantex_revocation_visible: 30,
      channel_active_transaction_update: 30,
    });
  });

  it('keeps connector credential custody outside Grantex raw storage and exposes bridge defaults', () => {
    expect(OACP_CONNECTOR_CREDENTIAL_CUSTODY).toMatchObject({
      preferred: 'merchant_owned_connector_platform',
      second_choice: 'merchant_selected_external_integration_provider_vault',
      fallback: 'agenticorg_encrypted_connector_vault_with_explicit_authorization',
      grantex_raw_connector_credentials_allowed: false,
      buyer_agent_credential_access_allowed: false,
    });
    expect(OACP_FIRST_E2E_BRIDGES).toMatchObject({
      chatgpt_style: 'hosted_openapi_tool_action_bridge',
      claude_code_style: 'mcp_streamable_http_bridge',
      gemini_style: 'a2a_task_bridge_with_openapi_fallback',
      perplexity_style: 'hosted_answer_search_bridge_with_openapi_read_and_commit_preflight',
    });
  });

  it('builds all-four-scope artifact cache keys and unsigned internal envelopes without private fields', () => {
    const cacheKey = buildOacpArtifactCacheKey({
      tenant_id: 'cten_C6W1',
      merchant_id: 'mch_C6W1',
      seller_agent_id: 'seller_C6W1',
      buyer_agent_id: 'buyer_C6W1',
      artifact_type: 'price',
      artifact_id: 'oacp_price_C6W1',
      schema_version: 'oacp.internal.v1',
      policy_version: 'policy_C6W1',
    });
    expect(cacheKey).toBe(
      'cten_C6W1:mch_C6W1:seller_C6W1:buyer_C6W1:price:oacp_price_C6W1:oacp.internal.v1:policy_C6W1',
    );

    const envelope = buildUnsignedOacpArtifactEnvelope({
      artifact_id: 'oacp_price_C6W1',
      artifact_type: 'price',
      issuer: 'grantex',
      issuer_key_id: 'kid_C6W1',
      subject_type: 'merchant_offer',
      subject_id: 'offer_C6W1',
      tenant_id: 'cten_C6W1',
      merchant_id: 'mch_C6W1',
      buyer_agent_id: 'buyer_C6W1',
      seller_agent_id: 'seller_C6W1',
      issued_at: '2026-06-11T00:00:00.000Z',
      expires_at: '2026-06-11T00:05:00.000Z',
      source_observed_at: '2026-06-11T00:00:00.000Z',
      policy_version: 'policy_C6W1',
      revocation_status_url: 'https://grantex.example.invalid/oacp/revocations/oacp_price_C6W1',
      payload: {
        display_name: 'Demo public item',
        amount_minor_units: 99900,
        currency: 'INR',
      },
      safety: {
        public_safe: true,
        contains_private_data: false,
        allowed_agent_uses: ['quote_preview'],
        forbidden_agent_uses: ['payment_capture'],
        commitment_allowed: true,
        offline_commitment_allowed: true,
        requires_online_confirmation: false,
        requires_provider_direct_verification: false,
        requires_merchant_system_confirmation: true,
        stale_behavior: 'refuse_final_commitment',
        refusal_code_if_invalid: 'artifact_invalid',
      },
    });

    expect(envelope).toMatchObject({
      schema_version: 'oacp.internal.v1',
      signature_alg: 'ES256',
      signature: 'detached_jws_required_before_publication',
      payload_hash: hashOacpPayload({
        display_name: 'Demo public item',
        amount_minor_units: 99900,
        currency: 'INR',
      }),
    });
  });

  it('rejects private, credential, raw payload, and enablement fields recursively', () => {
    for (const sample of [
      { apiKey: 'secret' },
      { rawProviderPayload: { private: true } },
      { publicDiscoveryEnabled: true },
      { livePaymentEnabled: true },
      { nested: { merchantPrivateApiUrl: 'https://merchant-private.example.invalid' } },
      { rawJwt: 'jwt.private.value' },
      { webhookSecret: 'secret' },
    ]) {
      expect(() => assertNoForbiddenOacpArtifactFields(sample)).toThrow(/OACP artifact cannot contain/);
    }
  });

  it('allows only bounded offline commitments and refuses stale, unscoped, over-cap, and unconfirmed actions', () => {
    expect(evaluateOacpOfflineCommitment(BASE_OFFLINE_INPUT)).toMatchObject({
      allowed: true,
      tier: 'medium',
      evidence_required: ['merchant_confirmation', 'grantex_reconciliation'],
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      action: 'payment_intent',
      amount_minor_units: 490000,
      total_quantity: 1,
      provider_verification: true,
      merchant_confirmation: false,
      revocation_snapshot_age_seconds: 60,
    })).toMatchObject({
      allowed: true,
      tier: 'high',
      evidence_required: ['provider_verification', 'grantex_reconciliation'],
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      action: 'public_discovery_publish',
    })).toMatchObject({
      allowed: false,
      refusal_code: 'critical_action_offline_refused',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      artifacts_scoped_to_all_four: false,
    })).toMatchObject({
      allowed: false,
      refusal_code: 'artifact_scope_mismatch',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      effective_artifact_age_seconds: 301,
      effective_artifact_ttl_seconds: 300,
    })).toMatchObject({
      allowed: false,
      refusal_code: 'artifact_expired_or_stale',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      amount_minor_units: 1000001,
    })).toMatchObject({
      allowed: false,
      refusal_code: 'risk_cap_exceeded',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      currency: 'EUR',
    })).toMatchObject({
      allowed: false,
      refusal_code: 'currency_cap_unavailable',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      merchant_confirmation: false,
    })).toMatchObject({
      allowed: false,
      refusal_code: 'merchant_confirmation_required',
    });

    expect(evaluateOacpOfflineCommitment({
      ...BASE_OFFLINE_INPUT,
      action: 'payment_intent',
      amount_minor_units: 490000,
      provider_verification: false,
      merchant_confirmation: false,
    })).toMatchObject({
      allowed: false,
      refusal_code: 'provider_verification_required',
    });
  });

  it('documents C6W1 scope, defaults, and non-enablement posture', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const prd = readFileSync(PRD_PATH, 'utf8');

    for (const heading of [
      'Scope',
      'First Internal Artifact Format',
      'First-Release Offline Commitment Caps',
      'Artifact TTL Defaults',
      'Connector Credential Custody',
      'Revocation Propagation SLA',
      'First Agent-Surface Bridges',
      'What This Does Not Enable',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    expect(doc).toContain('canonical JSON with detached JWS signatures');
    expect(doc).toContain('INR 25,000');
    expect(doc).toContain('merchant-owned connector platform');
    expect(doc).toContain('No endpoint, migration, workflow, provider adapter, public discovery, checkout/payment, live payment, live provider, merchant private API, or protocol publication is added');
    expect(prd).toContain('First release monetary and quantity caps');
    expect(prd).toContain('Default Artifact TTLs');
    expect(prd).toContain('Connector Credential Custody');
  });

  it('maps expected action risk tiers', () => {
    expect(riskTierForOacpOfflineAction('browse')).toBe('informational');
    expect(riskTierForOacpOfflineAction('draft_cart')).toBe('low');
    expect(riskTierForOacpOfflineAction('price_lock')).toBe('medium');
    expect(riskTierForOacpOfflineAction('payment_intent')).toBe('high');
    expect(riskTierForOacpOfflineAction('emergency_disable')).toBe('critical');
  });
});

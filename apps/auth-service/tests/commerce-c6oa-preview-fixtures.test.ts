import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);
const manifestPath = join(fixtureDir, 'manifest.json');

const expectedSurfaces = new Set([
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
]);

const forbiddenStringPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /\bpostgres(?:ql)?:\/\//i,
  /\bredis:\/\//i,
  /\bsk_live_[a-z0-9]/i,
  /\bpk_live_[a-z0-9]/i,
  /\bwhsec_[a-z0-9]/i,
  /\bbearer\s+[a-z0-9._-]+/i,
  /\bclient_secret\s*=/i,
  /\baccess_token\s*=/i,
  /\bapi[_-]?key\s*=/i,
  /\bpassword\s*=/i,
  /\bCOMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true\b/i,
  /\bCOMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=/i,
  /\bproduction\s+approved\b/i,
  /\bcertified\s+(?:ucp|acp|ap2|schema\.org|provider|payment)\b/i,
  /\blive\s+payment\s+approved\b/i,
];

const privateIdPatterns = [
  /\bten_[A-Z0-9][A-Za-z0-9]*/,
  /\bmch_[A-Z0-9][A-Za-z0-9]*/,
  /\bcprd_[A-Z0-9][A-Za-z0-9]*/,
  /\bcvar_[A-Z0-9][A-Za-z0-9]*/,
  /\bcart_[A-Z0-9][A-Za-z0-9]*/,
  /\bcpi_[A-Z0-9][A-Za-z0-9]*/,
  /\bcconn_[A-Z0-9][A-Za-z0-9]*/,
  /\bcaud_[A-Z0-9][A-Za-z0-9]*/,
  /\bjti_[A-Z0-9][A-Za-z0-9]*/,
];

const dangerousBooleanKey =
  /(public_discovery|production|checkout|payment|live|provider|credential|secret|allowlist|publication|certification|certified|merchant_private_api|agenticorg_direct_execution|outbound_sync|signed_production|mandate_created|signing_enabled)/i;

const allowedTrueKeys = new Set([
  'synthetic',
  'sandbox_only',
  'preview_only',
  'non_live',
  'non_enabling',
  'non_publication',
  'non_certifying',
  'tenant_scoped',
  'auth_required',
  'read_only',
  'public_safe',
  'deterministic',
  'deterministic_unsigned_preview',
  'idempotency_supported',
  'complete_required_evidence',
  'passport_present',
  'consent_granted',
  'active_policy_present',
  'policy_decision_present',
  'cart_hash_present',
  'amount_cap_present',
  'merchant_state_present',
  'agent_identity_present',
  'audit_reference_present',
  'idempotency_evidence_present',
  'present',
  'required_checkout_scopes_present',
  'policy_version_present',
  'not_before_present',
  'expires_at_present',
  'not_expired',
  'approved_required_checkout_scopes_present',
  'presented_payload_hash_present',
  'approved_at_present',
  'decision_reference_present',
  'idempotency_key_hash_present',
  'cart_idempotency_key_hash_present',
  'payment_intent_idempotency_key_hash_present',
  'audit_idempotency_key_hash_present',
  'within_amount_cap',
  'created_at_present',
  'snapshot_hash_present',
  'passport_bound',
  'policy_decision_present',
  'latest_payment_intent_present',
  'agentic_commerce_requested',
  'runtime_implemented',
]);

function parseJsonFile(path: string): JsonObject {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixtureFileNames(): string[] {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

function walk(value: JsonValue, visitor: (key: string | null, value: JsonValue, path: string) => void, path = '$'): void {
  visitor(path.split('.').at(-1) ?? null, value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${path}[${index}]`));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, visitor, `${path}.${key}`);
    }
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function expectFixturePosture(fileName: string, fixture: JsonObject): void {
  expect(fixture.fixture_kind, fileName).toBe('agentic_commerce_c6oa_preview_conformance_fixture');
  expect(fixture.synthetic, fileName).toBe(true);
  expect(fixture.sandbox_only, fileName).toBe(true);
  expect(fixture.preview_only, fileName).toBe(true);
  expect(fixture.non_live, fileName).toBe(true);
  expect(fixture.non_enabling, fileName).toBe(true);
  expect(fixture.non_publication, fileName).toBe(true);
  expect(fixture.non_certifying, fileName).toBe(true);
  expect(fixture.publication_status, fileName).toBe('not_published');
  expect(fixture.certification_claims, fileName).toEqual([]);
  expect(expectedSurfaces.has(String(fixture.surface)), fileName).toBe(true);
  expect(['preview_available', 'blocked_refusal'].includes(String(fixture.scenario)), fileName).toBe(true);

  const payload = fixture.payload;
  expect(isObject(payload), `${fileName} payload`).toBe(true);
  if (isObject(payload)) {
    expect(payload.preview_only, `${fileName} payload.preview_only`).toBe(true);
    if ('certification_claims' in payload) {
      expect(payload.certification_claims, `${fileName} payload.certification_claims`).toEqual([]);
    }
  }
}

function expectNoForbiddenContent(fileName: string, fixture: JsonObject): void {
  walk(fixture, (key, value, path) => {
    if (typeof value === 'string') {
      for (const pattern of forbiddenStringPatterns) {
        expect(value, `${fileName} ${path} matched ${pattern}`).not.toMatch(pattern);
      }
      for (const pattern of privateIdPatterns) {
        expect(value, `${fileName} ${path} contains private/internal id`).not.toMatch(pattern);
      }
    }

    if (
      key
      && typeof value === 'boolean'
      && value === true
      && !key.startsWith('requires_')
      && dangerousBooleanKey.test(key)
    ) {
      expect(allowedTrueKeys.has(key), `${fileName} ${path} must not enable guarded capability`).toBe(true);
    }

    if (key === 'certification_claims') {
      expect(value, `${fileName} ${path}`).toEqual([]);
    }
    if (key && key.endsWith('_certification_claim')) {
      expect(value, `${fileName} ${path}`).toBe('none');
    }
    if (key && (key.endsWith('_exposed') || key.endsWith('_included') || key.endsWith('_stored'))) {
      if (/(secret|token|credential|raw|provider|checkout_url|passport_jti|agent_api_key|user_principal)/i.test(key)) {
        expect(value, `${fileName} ${path}`).toBe(false);
      }
    }
  });
}

function expectConnectorControls(fileName: string, fixture: JsonObject): void {
  if (fixture.surface !== 'connector_registry_metadata_preview') return;
  const payload = fixture.payload;
  expect(isObject(payload), `${fileName} connector payload`).toBe(true);
  if (!isObject(payload)) return;
  const controls = payload.controls;
  expect(controls).toMatchObject({
    metadata_only_registry: true,
    credentials_stored_by_registry: false,
    outbound_sync_enabled_by_registry: false,
    agenticorg_direct_execution_allowed: false,
    provider_call_enabled_by_registry: false,
    checkout_payment_enabled_by_registry: false,
    live_payment_enabled_by_registry: false,
    public_discovery_enabled_by_registry: false,
    production_config_written_by_registry: false,
  });
}

describe('C6Oa open-protocol preview conformance fixtures', () => {
  it('manifest lists every checked-in fixture exactly once', () => {
    const manifest = parseJsonFile(manifestPath);
    expect(manifest.synthetic).toBe(true);
    expect(manifest.sandbox_only).toBe(true);
    expect(manifest.preview_only).toBe(true);
    expect(manifest.non_live).toBe(true);
    expect(manifest.non_enabling).toBe(true);
    expect(manifest.non_publication).toBe(true);
    expect(manifest.non_certifying).toBe(true);
    expect(manifest.certification_claims).toEqual([]);

    const manifestFixtures = manifest.fixtures;
    expect(Array.isArray(manifestFixtures)).toBe(true);
    const manifestPaths = (manifestFixtures as JsonObject[]).map((entry) => String(entry.path)).sort();
    expect(arraysEqual(manifestPaths, fixtureFileNames())).toBe(true);
  });

  it('covers every preview surface with preview-available and blocked/refusal examples', () => {
    const seen = new Map<string, Set<string>>();
    for (const fileName of fixtureFileNames()) {
      const fixture = parseJsonFile(join(fixtureDir, fileName));
      const surface = String(fixture.surface);
      const scenario = String(fixture.scenario);
      if (!seen.has(surface)) seen.set(surface, new Set());
      seen.get(surface)!.add(scenario);
    }

    expect(new Set(seen.keys())).toEqual(expectedSurfaces);
    for (const [surface, scenarios] of seen) {
      expect(scenarios, surface).toContain('preview_available');
      expect(scenarios, surface).toContain('blocked_refusal');
    }
  });

  it('keeps every fixture sandbox-only, preview-only, non-live, and non-enabling', () => {
    for (const fileName of fixtureFileNames()) {
      const fixture = parseJsonFile(join(fixtureDir, fileName));
      expectFixturePosture(fileName, fixture);
      expectNoForbiddenContent(fileName, fixture);
      expectConnectorControls(fileName, fixture);
    }
  });
});

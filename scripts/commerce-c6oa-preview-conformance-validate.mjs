import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');
const fixtureDir = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);
const manifestPath = join(fixtureDir, 'manifest.json');
const c6oaDocPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6oa-preview-conformance-fixtures.md',
);
const c6obDocPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6ob-preview-validator-regression-scans.md',
);
const readmePath = join(fixtureDir, 'README.md');

const expectedSurfaces = new Set([
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
]);

const expectedScenarios = new Set(['preview_available', 'blocked_refusal']);

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
  'latest_payment_intent_present',
  'agentic_commerce_requested',
  'runtime_implemented',
]);

const forbiddenStringScans = [
  {
    name: 'secret or credential marker',
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_live_|pk_live_|whsec_|postgres:\/\/|postgresql:\/\/|redis:\/\/|bearer\s+[A-Za-z0-9._-]{20,}|client_secret\s*=|access_token\s*=|refresh_token\s*=|password\s*=|api[_-]?key\s*=/i,
  },
  {
    name: 'private commerce identifier',
    pattern: /\b(?:ten|mch|cprd|cvar|cart|cpi|cconn|caud|jti)_[A-Z0-9][A-Za-z0-9]*/,
  },
  {
    name: 'public discovery or production allowlist enablement',
    pattern: /COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true|COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=|"production_allowlist[^"]*"\s*:\s*true|"(?:public_discovery_enabled|commerce_public_discovery_enabled|agenticorg_public_discovery_enabled|production_commerce_v1_enabled)"\s*:\s*true/i,
  },
  {
    name: 'checkout or payment enablement',
    pattern: /"(?:checkout|payment)[^"]*(?:enabled|creation|created|published)"\s*:\s*true|"enabled_by_preview"\s*:\s*true|"provider_call_enabled"\s*:\s*true|"provider_called"\s*:\s*true|"payment_enabled"\s*:\s*true/i,
  },
  {
    name: 'live provider or provider credential enablement',
    pattern: /"live_[^"]*"\s*:\s*true|live_plural|plural_enabled|"provider_credentials[^"]*"\s*:\s*true|"credentials_stored[^"]*"\s*:\s*true/i,
  },
  {
    name: 'certification or production approval overclaim',
    pattern: /\b(?:certified|certification approved|production approved|public protocol publication approved|live payment approved|schema\.org certified|ucp certified|acp certified|ap2 certified|provider certified)\b/i,
  },
  {
    name: 'direct provider or merchant private API execution',
    pattern: /fetch\(|axios\.|got\(|undici|provider_call_enabled[^:]*:\s*true|agenticorg_direct_execution_allowed[^:]*:\s*true|merchant_private_api_call_enabled[^:]*:\s*true|outbound_sync_enabled[^:]*:\s*true/i,
  },
  {
    name: 'raw provider or checkout reference exposure',
    pattern: /"(?:provider_payment_id|provider_order_id|checkout_url)"\s*:\s*"[^"{]|"provider_metadata"\s*:\s*\{|"raw_payload"\s*:\s*\{/i,
  },
];

function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function fixtureFileNames() {
  return readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

function walk(value, visitor, path = '$') {
  const key = path.split('.').at(-1) ?? null;
  visitor(key, value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${path}[${index}]`));
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      walk(child, visitor, `${path}.${childKey}`);
    }
  }
}

function assertEmptyArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.equal(value.length, 0, `${label} must be empty`);
}

function assertFalse(value, label) {
  assert.equal(value, false, `${label} must be false`);
}

function assertPosture(object, label) {
  assert.equal(object.synthetic, true, `${label}.synthetic must be true`);
  assert.equal(object.sandbox_only, true, `${label}.sandbox_only must be true`);
  assert.equal(object.preview_only, true, `${label}.preview_only must be true`);
  assert.equal(object.non_live, true, `${label}.non_live must be true`);
  assert.equal(object.non_enabling, true, `${label}.non_enabling must be true`);
  assert.equal(object.non_publication, true, `${label}.non_publication must be true`);
  assert.equal(object.non_certifying, true, `${label}.non_certifying must be true`);
  assert.equal(object.publication_status, 'not_published', `${label}.publication_status must be not_published`);
  assertEmptyArray(object.certification_claims, `${label}.certification_claims`);
}

function assertControls(controls, label) {
  assert.ok(isRecord(controls), `${label} controls must be an object`);
  for (const [key, value] of Object.entries(controls)) {
    if (key.endsWith('_certification_claim')) {
      assert.equal(value, 'none', `${label}.${key} must be none`);
      continue;
    }
    if (key === 'metadata_only_registry') {
      assert.equal(value, true, `${label}.${key} must be true`);
      continue;
    }
    if (
      dangerousBooleanKey.test(key)
      && typeof value === 'boolean'
      && value === true
      && !allowedTrueKeys.has(key)
      && !key.startsWith('requires_')
    ) {
      assert.fail(`${label}.${key} must not enable guarded capability`);
    }
  }
}

function assertNoForbiddenValues(fixture, fileName) {
  walk(fixture, (key, value, path) => {
    if (typeof value === 'string') {
      for (const scan of forbiddenStringScans) {
        assert.equal(
          scan.pattern.test(value),
          false,
          `${fileName} ${path} matched ${scan.name}`,
        );
      }
    }
    if (key === 'certification_claims') {
      assertEmptyArray(value, `${fileName} ${path}`);
    }
    if (key && key.endsWith('_certification_claim')) {
      assert.equal(value, 'none', `${fileName} ${path} must be none`);
    }
    if (
      key
      && typeof value === 'boolean'
      && value === true
      && !key.startsWith('requires_')
      && dangerousBooleanKey.test(key)
      && !allowedTrueKeys.has(key)
    ) {
      assert.fail(`${fileName} ${path} must not enable guarded capability`);
    }
  });
}

function collectStringArrayValues(value, keyName) {
  const values = new Set();
  walk(value, (key, child) => {
    if (key !== keyName || !Array.isArray(child)) return;
    for (const item of child) {
      if (typeof item === 'string' && item.length > 0) values.add(item);
    }
  });
  return values;
}

function assertBlockedFixtureEvidence(fixture, fileName) {
  if (fixture.scenario !== 'blocked_refusal') return;
  const payload = fixture.payload;
  assert.ok(isRecord(payload), `${fileName} blocked payload must be object`);
  assert.equal(payload.status, 'blocked', `${fileName} blocked payload status`);
  if ('message' in payload) {
    assert.equal(typeof payload.message, 'string', `${fileName} blocked payload message must be text`);
    assert.match(payload.message, /blocked|missing|not enabled/i, `${fileName} message must explain blocked posture`);
  }

  const expectedBlockers = asArray(fixture.expected_blockers, `${fileName}.expected_blockers`);
  const payloadBlockers = collectStringArrayValues(payload, 'blockers');
  assert.ok(payloadBlockers.size > 0, `${fileName} must include payload blocker evidence`);
  for (const blocker of expectedBlockers) {
    assert.equal(
      payloadBlockers.has(blocker),
      true,
      `${fileName} expected blocker ${blocker} must appear in payload blocker evidence`,
    );
  }
}

function assertSurfaceFixture(fixture, fileName) {
  const payload = fixture.payload;
  assert.ok(isRecord(payload), `${fileName} payload must be an object`);
  assert.equal(payload.preview_only, true, `${fileName} payload.preview_only must be true`);
  if ('certification_claims' in payload) {
    assertEmptyArray(payload.certification_claims, `${fileName} payload.certification_claims`);
  }

  switch (fixture.surface) {
    case 'schemaorg_jsonld_preview': {
      assertFalse(payload.schemaorg_publication_enabled, `${fileName}.schemaorg_publication_enabled`);
      assertFalse(payload.public_discovery_enabled, `${fileName}.public_discovery_enabled`);
      assert.ok(isRecord(payload.jsonld), `${fileName} jsonld must be an object`);
      assert.equal(payload.jsonld['@context'], 'https://schema.org', `${fileName} schema.org context`);
      assert.ok(Array.isArray(payload.jsonld['@graph']), `${fileName} schema.org graph`);
      break;
    }
    case 'ucp_style_capability_profile_preview': {
      assert.equal(payload.namespace, 'dev.grantex.commerce.discovery.preview', `${fileName} namespace`);
      assert.equal(payload.ucp_certification_claim, 'none', `${fileName} UCP claim`);
      assertFalse(payload.ucp_publication_enabled, `${fileName}.ucp_publication_enabled`);
      assert.equal(JSON.stringify(payload).includes('dev.ucp.'), false, `${fileName} must not use certified UCP namespace`);
      assertControls(payload.controls, `${fileName}.payload`);
      break;
    }
    case 'acp_style_checkout_shape_preview': {
      assert.equal(payload.acp_certification_claim, 'none', `${fileName} ACP claim`);
      assertFalse(payload.payment_intent_creation_enabled, `${fileName}.payment_intent_creation_enabled`);
      assertFalse(payload.checkout_link_creation_enabled, `${fileName}.checkout_link_creation_enabled`);
      assertControls(payload.controls, `${fileName}.payload`);
      break;
    }
    case 'ap2_style_evidence_preview': {
      assert.equal(payload.ap2_certification_claim, 'none', `${fileName} AP2 claim`);
      assert.equal(payload.signature_status, 'unsigned_preview', `${fileName} signature status`);
      assertFalse(payload.ap2_signed_mandate_created, `${fileName}.ap2_signed_mandate_created`);
      assertFalse(payload.signed_production_mandate_created, `${fileName}.signed_production_mandate_created`);
      assertFalse(payload.payment_network_submission_enabled, `${fileName}.payment_network_submission_enabled`);
      assertControls(payload.controls, `${fileName}.payload`);
      break;
    }
    case 'connector_registry_metadata_preview': {
      assertControls(payload.controls, `${fileName}.payload`);
      assert.equal(payload.controls.metadata_only_registry, true, `${fileName} metadata-only registry`);
      assertFalse(payload.controls.credentials_stored_by_registry, `${fileName}.credentials_stored_by_registry`);
      assertFalse(payload.controls.outbound_sync_enabled_by_registry, `${fileName}.outbound_sync_enabled_by_registry`);
      assertFalse(payload.controls.agenticorg_direct_execution_allowed, `${fileName}.agenticorg_direct_execution_allowed`);
      assertFalse(payload.controls.provider_call_enabled_by_registry, `${fileName}.provider_call_enabled_by_registry`);
      assert.ok(Array.isArray(payload.items), `${fileName} connector items`);
      assert.ok(Array.isArray(payload.source_precedence), `${fileName} source precedence`);
      break;
    }
    default:
      assert.fail(`${fileName} has unsupported surface ${fixture.surface}`);
  }
}

function validateManifest(manifest, names) {
  assert.equal(manifest.manifest_kind, 'agentic_commerce_c6oa_preview_conformance_fixture_manifest');
  assert.equal(manifest.manifest_version, 'c6oa-preview-1');
  assert.equal(manifest.status, 'internal_conformance_fixture_corpus');
  assertPosture(manifest, 'manifest');
  assertControls(manifest.global_controls, 'manifest.global_controls');

  const fixtures = asArray(manifest.fixtures, 'manifest.fixtures');
  const manifestNames = fixtures.map((entry) => {
    assert.ok(isRecord(entry), 'manifest fixture entry must be an object');
    assert.ok(expectedSurfaces.has(entry.surface), `manifest surface ${entry.surface} must be expected`);
    assert.ok(expectedScenarios.has(entry.scenario), `manifest scenario ${entry.scenario} must be expected`);
    assert.equal(typeof entry.path, 'string', 'manifest fixture path must be a string');
    return entry.path;
  }).sort();
  assert.deepEqual(manifestNames, names, 'manifest paths must match checked-in fixture files');

  const coverage = new Map();
  for (const entry of fixtures) {
    const scenarios = coverage.get(entry.surface) ?? new Set();
    scenarios.add(entry.scenario);
    coverage.set(entry.surface, scenarios);
  }
  assert.deepEqual(new Set(coverage.keys()), expectedSurfaces, 'manifest must cover every expected surface');
  for (const surface of expectedSurfaces) {
    assert.deepEqual(coverage.get(surface), expectedScenarios, `${surface} must include both scenarios`);
  }
}

function validateFixture(fileName) {
  const fixture = parseJsonFile(join(fixtureDir, fileName));
  assert.equal(fixture.fixture_kind, 'agentic_commerce_c6oa_preview_conformance_fixture');
  assert.equal(fixture.fixture_version, 'c6oa-preview-1');
  assert.ok(expectedSurfaces.has(fixture.surface), `${fileName} surface must be expected`);
  assert.ok(expectedScenarios.has(fixture.scenario), `${fileName} scenario must be expected`);
  assertPosture(fixture, fileName);
  assert.ok(Array.isArray(fixture.expected_blockers), `${fileName} expected_blockers must be an array`);
  assert.ok(fixture.expected_blockers.length > 0, `${fileName} expected_blockers must be non-empty`);

  const payload = fixture.payload;
  assert.ok(isRecord(payload), `${fileName} payload must be object`);
  assert.equal(
    payload.status,
    fixture.scenario === 'blocked_refusal' ? 'blocked' : 'preview_only',
    `${fileName} payload status must match scenario`,
  );
  assertBlockedFixtureEvidence(fixture, fileName);
  assertSurfaceFixture(fixture, fileName);
  assertNoForbiddenValues(fixture, fileName);
  return fixture;
}

function validateTextScans(paths) {
  let scansChecked = 0;
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    for (const scan of forbiddenStringScans) {
      scansChecked += 1;
      assert.equal(
        scan.pattern.test(text),
        false,
        `${relative(repoRoot, path)} matched ${scan.name}`,
      );
    }
  }
  return scansChecked;
}

const manifest = parseJsonFile(manifestPath);
const fixtureNames = fixtureFileNames();
validateManifest(manifest, fixtureNames);
const fixtures = fixtureNames.map(validateFixture);
const scanTargets = [c6oaDocPath, c6obDocPath, readmePath, ...fixtureNames.map((name) => join(fixtureDir, name))];
const scansChecked = validateTextScans(scanTargets);

const summary = {
  status: 'passed',
  fixtures_checked: fixtures.length,
  surfaces_checked: expectedSurfaces.size,
  scans_checked: scansChecked,
  manifest: relative(repoRoot, manifestPath).replace(/\\/g, '/'),
};

console.log('commerce C6Oa preview conformance validation passed');
console.log(JSON.stringify(summary, null, 2));

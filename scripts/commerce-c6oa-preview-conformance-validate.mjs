import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');
const defaultFixtureDir = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);
const defaultReportDir = join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports');
const defaultJsonReportPath = join(defaultReportDir, 'open-protocol-preview-conformance.report.json');
const defaultMarkdownReportPath = join(defaultReportDir, 'open-protocol-preview-conformance.report.md');
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
const previewInternalOnlyStatement =
  'Internal preview conformance report only. This is not public protocol publication, not a certification artifact, and does not enable public discovery, production checkout or payment creation, live payments, provider calls, or merchant private API calls.';

const expectedSurfaceNames = [
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
];

const expectedSurfaces = new Set(expectedSurfaceNames);

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

function fixtureFileNames(currentFixtureDir) {
  return readdirSync(currentFixtureDir)
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

function validateFixture(fileName, currentFixtureDir) {
  const fixture = parseJsonFile(join(currentFixtureDir, fileName));
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
  const failures = [];
  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    for (const scan of forbiddenStringScans) {
      scansChecked += 1;
      if (scan.pattern.test(text)) {
        failures.push({
          path: formatPath(path),
          scan: scan.name,
        });
      }
    }
  }
  return { failures, scansChecked };
}

function formatPath(path) {
  const relativePath = relative(repoRoot, path).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..')) return relativePath;
  return path.replace(/\\/g, '/');
}

function requireOptionValue(args, index, option) {
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), `${option} requires a path value`);
  return value;
}

function parseArgs(args) {
  const options = {
    fixtureDir: defaultFixtureDir,
    generatedAt: new Date().toISOString(),
    jsonReportPath: defaultJsonReportPath,
    markdownReportPath: defaultMarkdownReportPath,
    writeReport: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--write-report':
        options.writeReport = true;
        break;
      case '--json-report':
        options.jsonReportPath = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--markdown-report':
        options.markdownReportPath = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--fixture-dir':
        options.fixtureDir = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--generated-at':
        options.generatedAt = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case '--help':
        console.log([
          'Usage: node scripts/commerce-c6oa-preview-conformance-validate.mjs [options]',
          '',
          'Options:',
          '  --write-report                 Write JSON and Markdown conformance reports.',
          '  --json-report <path>           JSON report path. Default: docs/internal/commerce-v1/reports/open-protocol-preview-conformance.report.json',
          '  --markdown-report <path>       Markdown report path. Default: docs/internal/commerce-v1/reports/open-protocol-preview-conformance.report.md',
          '  --fixture-dir <path>           Fixture corpus directory. Default: docs/internal/commerce-v1/fixtures/c6oa-preview-conformance',
          '  --generated-at <iso-string>    Override report timestamp for deterministic local checks.',
        ].join('\n'));
        process.exit(0);
        break;
      default:
        assert.fail(`Unknown option ${arg}`);
    }
  }

  return options;
}

function messageForError(error) {
  return error instanceof Error ? error.message : String(error);
}

function fixtureResult(fileName, fixture, status, failure) {
  const result = {
    path: fileName,
    surface: isRecord(fixture) && typeof fixture.surface === 'string' ? fixture.surface : 'unknown',
    scenario: isRecord(fixture) && typeof fixture.scenario === 'string' ? fixture.scenario : 'unknown',
    status,
    expected_blockers: isRecord(fixture) && Array.isArray(fixture.expected_blockers)
      ? fixture.expected_blockers
      : [],
    blocker_evidence_count: isRecord(fixture?.payload)
      ? collectStringArrayValues(fixture.payload, 'blockers').size
      : 0,
  };
  if (failure) result.failure = failure;
  return result;
}

function buildSurfaceResults(fixtureResults) {
  return expectedSurfaceNames.map((surface) => {
    const results = fixtureResults.filter((fixture) => fixture.surface === surface);
    const scenariosPresent = [...new Set(results.map((fixture) => fixture.scenario))].sort();
    const missingScenarios = [...expectedScenarios]
      .filter((scenario) => !scenariosPresent.includes(scenario))
      .sort();
    const failedFixtures = results
      .filter((fixture) => fixture.status !== 'passed')
      .map((fixture) => fixture.path);

    return {
      surface,
      status: missingScenarios.length === 0 && failedFixtures.length === 0 ? 'passed' : 'failed',
      fixture_count: results.length,
      scenarios_present: scenariosPresent,
      missing_scenarios: missingScenarios,
      failed_fixtures: failedFixtures,
    };
  });
}

function buildBlockerSummary(fixtureResults) {
  const blockedFixtures = fixtureResults.filter((fixture) => fixture.scenario === 'blocked_refusal');
  const bySurface = expectedSurfaceNames.map((surface) => {
    const surfaceFixtures = blockedFixtures.filter((fixture) => fixture.surface === surface);
    const blockers = [...new Set(surfaceFixtures.flatMap((fixture) => fixture.expected_blockers))].sort();
    return {
      surface,
      blocked_fixture_count: surfaceFixtures.length,
      expected_blocker_count: blockers.length,
      expected_blockers: blockers,
    };
  });

  return {
    blocked_fixture_count: blockedFixtures.length,
    expected_blocker_count: blockedFixtures.reduce(
      (count, fixture) => count + fixture.expected_blockers.length,
      0,
    ),
    by_surface: bySurface,
  };
}

function buildNonEnablingControlSummary(manifest) {
  const globalControls = isRecord(manifest?.global_controls) ? manifest.global_controls : {};
  const enabledGuardedControls = Object.entries(globalControls)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .sort();

  return {
    status: enabledGuardedControls.length === 0 && isRecord(manifest) ? 'passed' : 'failed',
    all_guarded_controls_disabled: enabledGuardedControls.length === 0,
    enabled_guarded_controls: enabledGuardedControls,
    posture: {
      synthetic: manifest?.synthetic === true,
      sandbox_only: manifest?.sandbox_only === true,
      preview_only: manifest?.preview_only === true,
      non_live: manifest?.non_live === true,
      non_enabling: manifest?.non_enabling === true,
      non_publication: manifest?.non_publication === true,
      non_certifying: manifest?.non_certifying === true,
      publication_status: manifest?.publication_status ?? 'unknown',
      certification_claim_count: Array.isArray(manifest?.certification_claims)
        ? manifest.certification_claims.length
        : 'unknown',
    },
    controls: globalControls,
  };
}

function buildSafetyPostureSummary(manifest) {
  return {
    statement: previewInternalOnlyStatement,
    preview_internal_only: true,
    sandbox_only: manifest?.sandbox_only === true,
    non_live: manifest?.non_live === true,
    non_enabling: manifest?.non_enabling === true,
    non_publication: manifest?.non_publication === true,
    non_certifying: manifest?.non_certifying === true,
    public_discovery_enabled: false,
    production_checkout_payment_creation_enabled: false,
    live_payment_enabled: false,
    provider_calls_enabled: false,
    merchant_private_api_calls_enabled: false,
  };
}

function buildReport({
  failures,
  fixtureResults,
  generatedAt,
  manifest,
  manifestPath,
  scanFailures,
  scansChecked,
}) {
  const status = failures.length === 0 ? 'passed' : 'failed';
  const surfaceResults = buildSurfaceResults(fixtureResults);

  return {
    report_kind: 'agentic_commerce_open_protocol_preview_conformance_report',
    report_version: 'c6oc-preview-1',
    status,
    generated_at: generatedAt,
    source_manifest_path: formatPath(manifestPath),
    fixture_corpus_version: manifest?.manifest_version ?? 'unknown',
    fixture_count: fixtureResults.length,
    surface_count: expectedSurfaceNames.length,
    scan_count: scansChecked,
    per_surface_results: surfaceResults,
    per_fixture_results: fixtureResults,
    blocker_summary: buildBlockerSummary(fixtureResults),
    forbidden_claim_scan_summary: {
      status: scanFailures.length === 0 ? 'passed' : 'failed',
      scans_checked: scansChecked,
      scan_names: forbiddenStringScans.map((scan) => scan.name),
      failures: scanFailures,
    },
    non_enabling_control_summary: buildNonEnablingControlSummary(manifest),
    safety_posture_summary: buildSafetyPostureSummary(manifest),
    failures,
  };
}

function markdownList(items) {
  if (items.length === 0) return '- None';
  return items.map((item) => `- ${item}`).join('\n');
}

function renderMarkdownReport(report) {
  const surfaceRows = report.per_surface_results
    .map((surface) => (
      `| ${surface.surface} | ${surface.status} | ${surface.fixture_count} | ${surface.scenarios_present.join(', ')} | ${surface.missing_scenarios.join(', ') || 'none'} |`
    ))
    .join('\n');
  const fixtureRows = report.per_fixture_results
    .map((fixture) => (
      `| ${fixture.path} | ${fixture.surface} | ${fixture.scenario} | ${fixture.status} | ${fixture.expected_blockers.length} | ${fixture.blocker_evidence_count} |`
    ))
    .join('\n');
  const blockerRows = report.blocker_summary.by_surface
    .map((surface) => (
      `| ${surface.surface} | ${surface.blocked_fixture_count} | ${surface.expected_blocker_count} | ${surface.expected_blockers.join(', ') || 'none'} |`
    ))
    .join('\n');
  const controlRows = Object.entries(report.non_enabling_control_summary.controls)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `| ${key} | ${String(value)} |`)
    .join('\n');

  return `${[
    '# Open Protocol Preview Conformance Report',
    '',
    report.safety_posture_summary.statement,
    '',
    '## Summary',
    '',
    `- Status: ${report.status}`,
    `- Generated at: ${report.generated_at}`,
    `- Source manifest: ${report.source_manifest_path}`,
    `- Fixture corpus version: ${report.fixture_corpus_version}`,
    `- Fixture count: ${report.fixture_count}`,
    `- Surface count: ${report.surface_count}`,
    `- Scan count: ${report.scan_count}`,
    '',
    '## Safety Posture',
    '',
    `- Preview/internal only: ${report.safety_posture_summary.preview_internal_only}`,
    `- Sandbox only: ${report.safety_posture_summary.sandbox_only}`,
    `- Non-live: ${report.safety_posture_summary.non_live}`,
    `- Non-enabling: ${report.safety_posture_summary.non_enabling}`,
    `- Non-publication: ${report.safety_posture_summary.non_publication}`,
    `- Non-certifying: ${report.safety_posture_summary.non_certifying}`,
    `- Public discovery enabled: ${report.safety_posture_summary.public_discovery_enabled}`,
    `- Production checkout/payment creation enabled: ${report.safety_posture_summary.production_checkout_payment_creation_enabled}`,
    `- Live payment enabled: ${report.safety_posture_summary.live_payment_enabled}`,
    `- Provider calls enabled: ${report.safety_posture_summary.provider_calls_enabled}`,
    `- Merchant private API calls enabled: ${report.safety_posture_summary.merchant_private_api_calls_enabled}`,
    '',
    '## Surface Results',
    '',
    '| Surface | Status | Fixtures | Scenarios present | Missing scenarios |',
    '|---|---:|---:|---|---|',
    surfaceRows,
    '',
    '## Fixture Results',
    '',
    '| Fixture | Surface | Scenario | Status | Expected blockers | Blocker evidence count |',
    '|---|---|---|---:|---:|---:|',
    fixtureRows,
    '',
    '## Blocker Summary',
    '',
    `- Blocked fixture count: ${report.blocker_summary.blocked_fixture_count}`,
    `- Expected blocker count: ${report.blocker_summary.expected_blocker_count}`,
    '',
    '| Surface | Blocked fixtures | Expected blockers | Blockers |',
    '|---|---:|---:|---|',
    blockerRows,
    '',
    '## Forbidden-Claim Scan Summary',
    '',
    `- Status: ${report.forbidden_claim_scan_summary.status}`,
    `- Scans checked: ${report.forbidden_claim_scan_summary.scans_checked}`,
    `- Scan names: ${report.forbidden_claim_scan_summary.scan_names.join(', ')}`,
    '',
    '## Non-Enabling Controls',
    '',
    `- Status: ${report.non_enabling_control_summary.status}`,
    `- All guarded controls disabled: ${report.non_enabling_control_summary.all_guarded_controls_disabled}`,
    '',
    '| Control | Value |',
    '|---|---:|',
    controlRows,
    '',
    '## Failures',
    '',
    markdownList(report.failures.map((failure) => `${failure.scope}: ${failure.message}`)),
  ].join('\n')}\n`;
}

function writeReports(report, options) {
  if (!options.writeReport) return;
  mkdirSync(dirname(options.jsonReportPath), { recursive: true });
  mkdirSync(dirname(options.markdownReportPath), { recursive: true });
  writeFileSync(options.jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(options.markdownReportPath, renderMarkdownReport(report));
}

function runValidation(options) {
  const currentFixtureDir = options.fixtureDir;
  const currentManifestPath = join(currentFixtureDir, 'manifest.json');
  const currentReadmePath = join(currentFixtureDir, 'README.md');
  const failures = [];
  const fixtureResults = [];
  let manifest = null;
  let fixtureNames = [];
  let scansChecked = 0;
  let scanFailures = [];

  try {
    manifest = parseJsonFile(currentManifestPath);
  } catch (error) {
    failures.push({ scope: 'manifest_parse', message: messageForError(error) });
  }

  try {
    fixtureNames = fixtureFileNames(currentFixtureDir);
  } catch (error) {
    failures.push({ scope: 'fixture_listing', message: messageForError(error) });
  }

  if (manifest) {
    try {
      validateManifest(manifest, fixtureNames);
    } catch (error) {
      failures.push({ scope: 'manifest_validation', message: messageForError(error) });
    }
  }

  for (const fileName of fixtureNames) {
    let fixture = null;
    let failure = null;
    try {
      fixture = validateFixture(fileName, currentFixtureDir);
    } catch (error) {
      failure = messageForError(error);
      failures.push({ scope: `fixture:${fileName}`, message: failure });
      try {
        fixture = parseJsonFile(join(currentFixtureDir, fileName));
      } catch {
        fixture = null;
      }
    }
    fixtureResults.push(fixtureResult(fileName, fixture, failure ? 'failed' : 'passed', failure));
  }

  try {
    const scanTargets = [
      c6oaDocPath,
      c6obDocPath,
      currentReadmePath,
      ...fixtureNames.map((name) => join(currentFixtureDir, name)),
    ];
    const scanResult = validateTextScans(scanTargets);
    scansChecked = scanResult.scansChecked;
    scanFailures = scanResult.failures;
    for (const failure of scanFailures) {
      failures.push({
        scope: `forbidden_scan:${failure.path}`,
        message: `matched ${failure.scan}`,
      });
    }
  } catch (error) {
    failures.push({ scope: 'forbidden_scans', message: messageForError(error) });
  }

  const report = buildReport({
    failures,
    fixtureResults,
    generatedAt: options.generatedAt,
    manifest,
    manifestPath: currentManifestPath,
    scanFailures,
    scansChecked,
  });

  const summary = {
    status: report.status,
    fixtures_checked: fixtureResults.length,
    surfaces_checked: expectedSurfaces.size,
    scans_checked: scansChecked,
    manifest: formatPath(currentManifestPath),
  };

  if (options.writeReport) {
    summary.reports = {
      json: formatPath(options.jsonReportPath),
      markdown: formatPath(options.markdownReportPath),
    };
  }

  return { report, summary };
}

const options = parseArgs(process.argv.slice(2));
const { report, summary } = runValidation(options);
writeReports(report, options);

if (report.status === 'passed') {
  console.log('commerce C6Oa preview conformance validation passed');
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error('commerce C6Oa preview conformance validation failed');
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
}

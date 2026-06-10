import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const validatorPath = join(repoRoot, 'scripts', 'commerce-c6oa-preview-conformance-validate.mjs');
const statusRendererPath = join(repoRoot, 'scripts', 'commerce-c6od-preview-status-render.mjs');
const defaultFixtureDir = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);

const expectedSurfaces = [
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
];

const expectedCounts = {
  fixtures: 10,
  surfaces: 5,
  scans: 104,
};

const deterministicGeneratedAt = '2026-06-07T00:00:00.000Z';

const forbiddenArtifactScans = [
  {
    name: 'secret or credential marker',
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_live_|pk_live_|whsec_|postgres:\/\/|postgresql:\/\/|redis:\/\/|bearer\s+[A-Za-z0-9._-]{20,}|client_secret\s*=|access_token\s*=|refresh_token\s*=|password\s*=|api[_-]?key\s*=/i,
  },
  {
    name: 'private commerce identifier',
    pattern: /\b(?:ten|mch|cprd|cvar|cart|cpi|cconn|caud|jti)_[A-Z0-9][A-Za-z0-9]*/,
  },
  {
    name: 'raw payload or provider metadata',
    pattern: /"provider_metadata"\s*:\s*\{|"raw_payload"\s*:\s*\{/i,
  },
  {
    name: 'public discovery or production config enablement',
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
    name: 'certification or publication overclaim',
    pattern: /\b(?:certified|certification approved|production approved|public protocol publication approved|live payment approved|schema\.org certified|ucp certified|acp certified|ap2 certified|provider certified|protocol-publication certified)\b/i,
  },
  {
    name: 'direct provider or merchant private API execution',
    pattern: /fetch\(|axios\.|got\(|undici|provider_call_enabled[^:]*:\s*true|agenticorg_direct_execution_allowed[^:]*:\s*true|merchant_private_api_call_enabled[^:]*:\s*true|outbound_sync_enabled[^:]*:\s*true/i,
  },
  {
    name: 'provider or checkout reference exposure',
    pattern: /"(?:provider_payment_id|provider_order_id|checkout_url)"\s*:\s*"[^"{]/i,
  },
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPath(path) {
  const relativePath = relative(repoRoot, path).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..')) return relativePath;
  return path.replace(/\\/g, '/');
}

function requireOptionValue(args, index, option) {
  const value = args[index + 1];
  assert.ok(value && !value.startsWith('--'), `${option} requires a value`);
  return value;
}

function parseArgs(args) {
  const options = {
    fixtureDir: defaultFixtureDir,
    generatedAt: deterministicGeneratedAt,
    mode: null,
    workDir: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--mode':
        options.mode = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case '--work-dir':
        options.workDir = resolve(repoRoot, requireOptionValue(args, index, arg));
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
          'Usage: node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode <pr|release-review> [options]',
          '',
          'Options:',
          '  --mode pr                       Run deterministic PR gate with temporary artifacts.',
          '  --mode release-review           Generate review artifacts in an explicit work directory.',
          '  --work-dir <path>               Required with --mode release-review.',
          '  --fixture-dir <path>            Optional fixture corpus override for local negative tests.',
          '  --generated-at <iso-string>     Override deterministic generated_at value.',
          '',
          'The gate is local validation only. It does not publish artifacts, deploy, call providers, or enable runtime commerce behavior.',
        ].join('\n'));
        process.exit(0);
        break;
      default:
        assert.fail(`Unknown option ${arg}`);
    }
  }

  assert.ok(options.mode, '--mode is required');
  assert.ok(['pr', 'release-review'].includes(options.mode), '--mode must be pr or release-review');
  return options;
}

function assertSafeReleaseWorkDir(workDir) {
  assert.ok(workDir, '--work-dir is required for release-review mode');
  const parsed = parse(workDir);
  assert.notEqual(workDir, parsed.root, 'work-dir must not be a filesystem root');
  assert.notEqual(workDir, repoRoot, 'work-dir must not be the repository root');
  assert.equal(
    workDir.startsWith(join(repoRoot, '.git')),
    false,
    'work-dir must not be inside .git',
  );
  if (existsSync(workDir)) {
    assert.equal(lstatSync(workDir).isDirectory(), true, 'work-dir must be a directory');
  }
}

function prepareWorkDir(options) {
  if (options.mode === 'pr') {
    return {
      cleanup: true,
      path: mkdtempSync(join(tmpdir(), 'commerce-c6oe-preview-gate-')),
    };
  }

  assertSafeReleaseWorkDir(options.workDir);
  mkdirSync(options.workDir, { recursive: true });
  return {
    cleanup: false,
    path: options.workDir,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseSummary(output, label) {
  const jsonStart = output.indexOf('{');
  assert.ok(jsonStart >= 0, `${label} output must include JSON summary`);
  return JSON.parse(output.slice(jsonStart));
}

function runNode(scriptPath, args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runValidationOnly(options) {
  const args = [];
  if (options.fixtureDir !== defaultFixtureDir) {
    args.push('--fixture-dir', options.fixtureDir);
  }
  const output = runNode(validatorPath, args);
  return parseSummary(output, 'C6Ob validation');
}

function runReportGeneration(options, paths) {
  const args = [
    '--write-report',
    '--json-report',
    paths.reportJson,
    '--markdown-report',
    paths.reportMarkdown,
    '--generated-at',
    options.generatedAt,
  ];
  if (options.fixtureDir !== defaultFixtureDir) {
    args.push('--fixture-dir', options.fixtureDir);
  }
  const output = runNode(validatorPath, args);
  return parseSummary(output, 'C6Oc report generation');
}

function runStatusRendering(options, paths) {
  const output = runNode(statusRendererPath, [
    '--report',
    paths.reportJson,
    '--json-status',
    paths.statusJson,
    '--markdown-status',
    paths.statusMarkdown,
    '--generated-at',
    options.generatedAt,
  ]);
  return parseSummary(output, 'C6Od status rendering');
}

function artifactPaths(workDir) {
  return {
    reportJson: join(workDir, 'open-protocol-preview-conformance.report.json'),
    reportMarkdown: join(workDir, 'open-protocol-preview-conformance.report.md'),
    statusJson: join(workDir, 'open-protocol-preview-conformance.status.json'),
    statusMarkdown: join(workDir, 'open-protocol-preview-conformance.status.md'),
  };
}

function assertCounts(summary, label, keyPrefix) {
  const fixtureKey = keyPrefix === 'checked' ? 'fixtures_checked' : 'fixture_count';
  const surfaceKey = keyPrefix === 'checked' ? 'surfaces_checked' : 'surface_count';
  const scanKey = keyPrefix === 'checked' ? 'scans_checked' : 'scan_count';
  assert.equal(summary[fixtureKey], expectedCounts.fixtures, `${label} fixture count`);
  assert.equal(summary[surfaceKey], expectedCounts.surfaces, `${label} surface count`);
  assert.equal(summary[scanKey], expectedCounts.scans, `${label} scan count`);
}

function assertSurfaces(results, label) {
  assert.ok(Array.isArray(results), `${label} must be an array`);
  const surfaces = new Set(results.map((result) => result.surface));
  for (const surface of expectedSurfaces) {
    assert.equal(surfaces.has(surface), true, `${label} must include ${surface}`);
  }
}

function assertNoForbiddenValues(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const scan of forbiddenArtifactScans) {
    assert.equal(scan.pattern.test(serialized), false, `${label} matched ${scan.name}`);
  }
}

function assertSafetyPosture(report, status) {
  const reportPosture = report.safety_posture_summary;
  const statusPosture = status.safety_posture_summary;
  assert.ok(isRecord(reportPosture), 'report safety posture must be present');
  assert.ok(isRecord(statusPosture), 'status safety posture must be present');

  for (const [label, posture] of [
    ['report', reportPosture],
    ['status', statusPosture],
  ]) {
    assert.equal(posture.preview_internal_only, true, `${label} preview_internal_only`);
    assert.equal(posture.non_publication, true, `${label} non_publication`);
    assert.equal(posture.non_certifying, true, `${label} non_certifying`);
    assert.equal(posture.non_enabling, true, `${label} non_enabling`);
    assert.equal(posture.public_discovery_enabled, false, `${label} public discovery`);
    assert.equal(
      posture.production_checkout_payment_creation_enabled,
      false,
      `${label} checkout/payment creation`,
    );
    assert.equal(posture.live_payment_enabled, false, `${label} live payment`);
    assert.equal(posture.provider_calls_enabled, false, `${label} provider calls`);
    assert.equal(posture.merchant_private_api_calls_enabled, false, `${label} merchant private API calls`);
    assert.match(
      posture.statement,
      /not public protocol publication/i,
      `${label} must include non-publication language`,
    );
    assert.match(
      posture.statement,
      /not a certification artifact/i,
      `${label} must include non-certification language`,
    );
  }

  const controls = status.non_enabling_control_summary;
  assert.ok(isRecord(controls), 'status non-enabling controls must be present');
  assert.equal(controls.all_guarded_controls_disabled, true, 'all guarded controls disabled');
  assert.deepEqual(controls.enabled_guarded_controls ?? [], [], 'enabled guarded controls');
  assert.equal(status.publication_status, 'not_published', 'status publication status');
  assert.deepEqual(status.certification_claims, [], 'status certification claims');
}

function assertReportStatusAgreement(report, status) {
  const expectedStatus = report.status === 'passed' ? 'passing' : 'failing';
  assert.equal(status.status, expectedStatus, 'rendered status must match report status');
  assert.equal(status.badge.message, expectedStatus, 'badge message must match report status');
  if (report.status !== 'passed') {
    assert.notEqual(status.badge.message, 'passing', 'failed report must not produce passing badge');
    assert.equal(status.badge.color, 'red', 'failed report badge must be red');
  } else {
    assert.equal(status.badge.color, 'green', 'passing report badge must be green');
  }
}

function assertBlockedFixtureEvidence(report) {
  const blockedFixtures = report.per_fixture_results.filter(
    (fixture) => fixture.scenario === 'blocked_refusal',
  );
  assert.equal(blockedFixtures.length, expectedCounts.surfaces, 'blocked fixture coverage');
  for (const fixture of blockedFixtures) {
    assert.equal(fixture.status, 'passed', `${fixture.path} status`);
    assert.ok(fixture.expected_blockers.length > 0, `${fixture.path} expected blockers`);
    assert.ok(
      fixture.blocker_evidence_count >= fixture.expected_blockers.length,
      `${fixture.path} blocker evidence`,
    );
  }
}

function assertAvailableFixturePosture(fixtureDir) {
  const manifest = readJson(join(fixtureDir, 'manifest.json'));
  const fixtures = manifest.fixtures.filter((fixture) => fixture.scenario === 'preview_available');
  assert.equal(fixtures.length, expectedCounts.surfaces, 'available fixture coverage');

  for (const entry of fixtures) {
    const fixture = readJson(join(fixtureDir, entry.path));
    assert.equal(fixture.synthetic, true, `${entry.path} synthetic`);
    assert.equal(fixture.sandbox_only, true, `${entry.path} sandbox_only`);
    assert.equal(fixture.preview_only, true, `${entry.path} preview_only`);
    assert.equal(fixture.non_live, true, `${entry.path} non_live`);
    assert.equal(fixture.non_enabling, true, `${entry.path} non_enabling`);
    assert.equal(fixture.non_publication, true, `${entry.path} non_publication`);
    assert.equal(fixture.non_certifying, true, `${entry.path} non_certifying`);
    assert.equal(fixture.publication_status, 'not_published', `${entry.path} publication_status`);
    assert.deepEqual(fixture.certification_claims, [], `${entry.path} certification_claims`);
    assert.equal(fixture.payload.status, 'preview_only', `${entry.path} payload status`);
    assert.equal(fixture.payload.preview_only, true, `${entry.path} payload preview_only`);
    assertNoForbiddenValues(fixture, entry.path);
  }
}

export function validateGateArtifacts({
  fixtureDir = defaultFixtureDir,
  report,
  status,
  validationSummary,
  reportSummary,
  statusSummary,
}) {
  assert.equal(validationSummary.status, 'passed', 'fixture validation summary status');
  assert.equal(reportSummary.status, 'passed', 'report generation summary status');
  assert.equal(statusSummary.status, status.status, 'status rendering summary status');

  assertCounts(validationSummary, 'validation summary', 'checked');
  assertCounts(reportSummary, 'report summary', 'checked');
  assertCounts(statusSummary, 'status summary', 'count');
  assertCounts(report, 'report artifact', 'count');
  assertCounts(status.counts, 'status artifact', 'count');

  assert.equal(report.status, 'passed', 'report artifact status');
  assertSurfaces(report.per_surface_results, 'report surfaces');
  assertSurfaces(status.per_surface_status, 'status surfaces');
  assertReportStatusAgreement(report, status);
  assertBlockedFixtureEvidence(report);
  assertAvailableFixturePosture(fixtureDir);
  assertSafetyPosture(report, status);
  assertNoForbiddenValues(report, 'report artifact');
  assertNoForbiddenValues(status, 'status artifact');
}

function runGate(options) {
  const work = prepareWorkDir(options);
  const paths = artifactPaths(work.path);

  try {
    const validationSummary = runValidationOnly(options);
    const reportSummary = runReportGeneration(options, paths);
    const statusSummary = runStatusRendering(options, paths);
    const report = readJson(paths.reportJson);
    const status = readJson(paths.statusJson);

    validateGateArtifacts({
      fixtureDir: options.fixtureDir,
      report,
      reportSummary,
      status,
      statusSummary,
      validationSummary,
    });

    const summary = {
      status: 'passed',
      mode: options.mode,
      fixture_validation: validationSummary,
      report: {
        path: options.mode === 'pr' ? 'temporary' : formatPath(paths.reportJson),
        status: report.status,
        fixture_count: report.fixture_count,
        surface_count: report.surface_count,
        scan_count: report.scan_count,
      },
      status_page: {
        path: options.mode === 'pr' ? 'temporary' : formatPath(paths.statusJson),
        status: status.status,
        badge: status.badge,
      },
      work_dir: options.mode === 'pr' ? 'temporary' : formatPath(work.path),
      artifacts_retained: options.mode === 'release-review',
    };

    console.log('commerce C6Oe preview conformance gate passed');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (work.cleanup) {
      rmSync(work.path, { force: true, recursive: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runGate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('commerce C6Oe preview conformance gate failed');
    console.error(message);
    process.exitCode = 1;
  }
}

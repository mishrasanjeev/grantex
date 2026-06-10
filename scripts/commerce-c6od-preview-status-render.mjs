import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const requiredSurfaces = [
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
];

const internalStatusStatement =
  'Internal preview conformance status only. This is not public protocol publication, not a certification artifact, and does not enable public discovery, production checkout or payment creation, live payments, provider calls, or merchant private API calls.';

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
  assert.ok(value && !value.startsWith('--'), `${option} requires a path value`);
  return value;
}

function parseArgs(args) {
  const options = {
    generatedAt: new Date().toISOString(),
    jsonStatusPath: null,
    markdownStatusPath: null,
    reportPath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--report':
        options.reportPath = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--json-status':
        options.jsonStatusPath = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--markdown-status':
        options.markdownStatusPath = resolve(repoRoot, requireOptionValue(args, index, arg));
        index += 1;
        break;
      case '--generated-at':
        options.generatedAt = requireOptionValue(args, index, arg);
        index += 1;
        break;
      case '--help':
        console.log([
          'Usage: node scripts/commerce-c6od-preview-status-render.mjs --report <path> [options]',
          '',
          'Options:',
          '  --report <path>            C6Oc JSON conformance report to render.',
          '  --json-status <path>       Optional JSON status summary output path.',
          '  --markdown-status <path>   Optional Markdown status page output path.',
          '  --generated-at <value>     Override status timestamp for deterministic review output.',
          '',
          'The renderer is local docs/test automation only. It does not publish status pages or enable runtime commerce behavior.',
        ].join('\n'));
        process.exit(0);
        break;
      default:
        assert.fail(`Unknown option ${arg}`);
    }
  }

  assert.ok(options.reportPath, '--report is required');
  return options;
}

function parseJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function asArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function assertReportShape(report) {
  assert.ok(isRecord(report), 'report must be an object');
  assert.equal(
    report.report_kind,
    'agentic_commerce_open_protocol_preview_conformance_report',
    'report_kind must be C6Oc preview conformance report',
  );
  assert.ok(['passed', 'failed'].includes(report.status), 'report.status must be passed or failed');
  assert.equal(typeof report.generated_at, 'string', 'report.generated_at must be a string');
  assert.equal(typeof report.source_manifest_path, 'string', 'report.source_manifest_path must be a string');
  assert.equal(typeof report.fixture_corpus_version, 'string', 'report.fixture_corpus_version must be a string');
  assert.equal(typeof report.fixture_count, 'number', 'report.fixture_count must be a number');
  assert.equal(typeof report.surface_count, 'number', 'report.surface_count must be a number');
  assert.equal(typeof report.scan_count, 'number', 'report.scan_count must be a number');
  assert.ok(isRecord(report.blocker_summary), 'report.blocker_summary must be an object');
  assert.ok(isRecord(report.forbidden_claim_scan_summary), 'report.forbidden_claim_scan_summary must be an object');
  assert.ok(isRecord(report.non_enabling_control_summary), 'report.non_enabling_control_summary must be an object');
  assert.ok(isRecord(report.safety_posture_summary), 'report.safety_posture_summary must be an object');

  const surfaces = asArray(report.per_surface_results, 'report.per_surface_results');
  const surfaceNames = new Set(surfaces.map((surface) => surface.surface));
  for (const surface of requiredSurfaces) {
    assert.equal(surfaceNames.has(surface), true, `report must include ${surface}`);
  }
}

function statusFromReport(report) {
  return report.status === 'passed' ? 'passing' : 'failing';
}

function badgeForStatus(status) {
  return {
    label: 'internal preview conformance',
    message: status,
    color: status === 'passing' ? 'green' : 'red',
    public_badge_publication_enabled: false,
  };
}

function summarizeSurfaces(report) {
  return report.per_surface_results.map((surface) => ({
    surface: surface.surface,
    status: surface.status,
    fixture_count: surface.fixture_count,
    scenarios_present: Array.isArray(surface.scenarios_present) ? surface.scenarios_present : [],
    missing_scenarios: Array.isArray(surface.missing_scenarios) ? surface.missing_scenarios : [],
    failed_fixtures: Array.isArray(surface.failed_fixtures) ? surface.failed_fixtures : [],
  }));
}

function summarizeFailures(report) {
  const failures = Array.isArray(report.failures) ? report.failures : [];
  return {
    failure_count: failures.length,
    failure_scopes: failures
      .map((failure) => (isRecord(failure) && typeof failure.scope === 'string' ? failure.scope : 'unknown'))
      .sort(),
  };
}

function buildStatus(report, options) {
  assertReportShape(report);
  const status = statusFromReport(report);
  const safetyPosture = report.safety_posture_summary;

  return {
    status_kind: 'agentic_commerce_open_protocol_preview_conformance_status',
    status_version: 'c6od-preview-1',
    generated_at: options.generatedAt,
    source_report_path: formatPath(options.reportPath),
    source_report: {
      report_kind: report.report_kind,
      report_version: report.report_version ?? 'unknown',
      generated_at: report.generated_at,
      source_manifest_path: report.source_manifest_path,
      fixture_corpus_version: report.fixture_corpus_version,
    },
    status,
    badge: badgeForStatus(status),
    counts: {
      fixture_count: report.fixture_count,
      surface_count: report.surface_count,
      scan_count: report.scan_count,
    },
    per_surface_status: summarizeSurfaces(report),
    blocker_summary: report.blocker_summary,
    forbidden_claim_scan_summary: {
      status: report.forbidden_claim_scan_summary.status,
      scans_checked: report.forbidden_claim_scan_summary.scans_checked,
      scan_names: Array.isArray(report.forbidden_claim_scan_summary.scan_names)
        ? report.forbidden_claim_scan_summary.scan_names
        : [],
      failure_count: Array.isArray(report.forbidden_claim_scan_summary.failures)
        ? report.forbidden_claim_scan_summary.failures.length
        : 0,
    },
    non_enabling_control_summary: {
      status: report.non_enabling_control_summary.status,
      all_guarded_controls_disabled: report.non_enabling_control_summary.all_guarded_controls_disabled === true,
      enabled_guarded_controls: Array.isArray(report.non_enabling_control_summary.enabled_guarded_controls)
        ? report.non_enabling_control_summary.enabled_guarded_controls
        : [],
      posture: isRecord(report.non_enabling_control_summary.posture)
        ? report.non_enabling_control_summary.posture
        : {},
      controls: isRecord(report.non_enabling_control_summary.controls)
        ? report.non_enabling_control_summary.controls
        : {},
    },
    safety_posture_summary: {
      statement: internalStatusStatement,
      source_report_statement: typeof safetyPosture.statement === 'string' ? safetyPosture.statement : '',
      preview_internal_only: true,
      sandbox_only: safetyPosture.sandbox_only === true,
      non_live: safetyPosture.non_live === true,
      non_enabling: safetyPosture.non_enabling === true,
      non_publication: safetyPosture.non_publication === true,
      non_certifying: safetyPosture.non_certifying === true,
      public_discovery_enabled: false,
      production_checkout_payment_creation_enabled: false,
      live_payment_enabled: false,
      provider_calls_enabled: false,
      merchant_private_api_calls_enabled: false,
    },
    failure_summary: summarizeFailures(report),
    publication_status: 'not_published',
    certification_claims: [],
  };
}

function markdownList(items) {
  if (items.length === 0) return '- None';
  return items.map((item) => `- ${item}`).join('\n');
}

function renderMarkdownStatus(status) {
  const surfaceRows = status.per_surface_status
    .map((surface) => (
      `| ${surface.surface} | ${surface.status} | ${surface.fixture_count} | ${surface.scenarios_present.join(', ')} | ${surface.failed_fixtures.join(', ') || 'none'} |`
    ))
    .join('\n');
  const blockerRows = status.blocker_summary.by_surface
    .map((surface) => (
      `| ${surface.surface} | ${surface.blocked_fixture_count} | ${surface.expected_blocker_count} | ${surface.expected_blockers.join(', ') || 'none'} |`
    ))
    .join('\n');
  const controlRows = Object.entries(status.non_enabling_control_summary.controls)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `| ${key} | ${String(value)} |`)
    .join('\n');

  return `${[
    '# Open Protocol Preview Conformance Status',
    '',
    status.safety_posture_summary.statement,
    '',
    '## Badge',
    '',
    `- Label: ${status.badge.label}`,
    `- Message: ${status.badge.message}`,
    `- Color: ${status.badge.color}`,
    `- Public badge publication enabled: ${status.badge.public_badge_publication_enabled}`,
    '',
    '## Summary',
    '',
    `- Status: ${status.status}`,
    `- Generated at: ${status.generated_at}`,
    `- Source report: ${status.source_report_path}`,
    `- Fixture count: ${status.counts.fixture_count}`,
    `- Surface count: ${status.counts.surface_count}`,
    `- Scan count: ${status.counts.scan_count}`,
    '',
    '## Surface Status',
    '',
    '| Surface | Status | Fixtures | Scenarios present | Failed fixtures |',
    '|---|---:|---:|---|---|',
    surfaceRows,
    '',
    '## Blocker Summary',
    '',
    `- Blocked fixture count: ${status.blocker_summary.blocked_fixture_count}`,
    `- Expected blocker count: ${status.blocker_summary.expected_blocker_count}`,
    '',
    '| Surface | Blocked fixtures | Expected blockers | Blockers |',
    '|---|---:|---:|---|',
    blockerRows,
    '',
    '## Forbidden-Claim Scan Summary',
    '',
    `- Status: ${status.forbidden_claim_scan_summary.status}`,
    `- Scans checked: ${status.forbidden_claim_scan_summary.scans_checked}`,
    `- Failure count: ${status.forbidden_claim_scan_summary.failure_count}`,
    `- Scan names: ${status.forbidden_claim_scan_summary.scan_names.join(', ')}`,
    '',
    '## Non-Enabling Controls',
    '',
    `- Status: ${status.non_enabling_control_summary.status}`,
    `- All guarded controls disabled: ${status.non_enabling_control_summary.all_guarded_controls_disabled}`,
    `- Enabled guarded controls: ${status.non_enabling_control_summary.enabled_guarded_controls.join(', ') || 'none'}`,
    '',
    '| Control | Value |',
    '|---|---:|',
    controlRows,
    '',
    '## Safety Posture',
    '',
    `- Preview/internal only: ${status.safety_posture_summary.preview_internal_only}`,
    `- Sandbox only: ${status.safety_posture_summary.sandbox_only}`,
    `- Non-live: ${status.safety_posture_summary.non_live}`,
    `- Non-enabling: ${status.safety_posture_summary.non_enabling}`,
    `- Non-publication: ${status.safety_posture_summary.non_publication}`,
    `- Non-certifying: ${status.safety_posture_summary.non_certifying}`,
    `- Public discovery enabled: ${status.safety_posture_summary.public_discovery_enabled}`,
    `- Production checkout/payment creation enabled: ${status.safety_posture_summary.production_checkout_payment_creation_enabled}`,
    `- Live payment enabled: ${status.safety_posture_summary.live_payment_enabled}`,
    `- Provider calls enabled: ${status.safety_posture_summary.provider_calls_enabled}`,
    `- Merchant private API calls enabled: ${status.safety_posture_summary.merchant_private_api_calls_enabled}`,
    `- Publication status: ${status.publication_status}`,
    `- Certification claims: ${status.certification_claims.length}`,
    '',
    '## Failure Summary',
    '',
    `- Failure count: ${status.failure_summary.failure_count}`,
    '',
    markdownList(status.failure_summary.failure_scopes),
  ].join('\n')}\n`;
}

function writeOutput(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function run(options) {
  const report = parseJsonFile(options.reportPath);
  const status = buildStatus(report, options);

  if (options.jsonStatusPath) {
    writeOutput(options.jsonStatusPath, `${JSON.stringify(status, null, 2)}\n`);
  }
  if (options.markdownStatusPath) {
    writeOutput(options.markdownStatusPath, renderMarkdownStatus(status));
  }

  const summary = {
    status: status.status,
    fixture_count: status.counts.fixture_count,
    surface_count: status.counts.surface_count,
    scan_count: status.counts.scan_count,
    source_report: status.source_report_path,
  };
  if (options.jsonStatusPath || options.markdownStatusPath) {
    summary.outputs = {};
    if (options.jsonStatusPath) summary.outputs.json_status = formatPath(options.jsonStatusPath);
    if (options.markdownStatusPath) summary.outputs.markdown_status = formatPath(options.markdownStatusPath);
  }

  console.log('commerce C6Od preview conformance status rendered');
  console.log(JSON.stringify(summary, null, 2));
}

run(parseArgs(process.argv.slice(2)));

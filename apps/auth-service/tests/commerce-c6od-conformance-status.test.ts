import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const validatorPath = join(repoRoot, 'scripts', 'commerce-c6oa-preview-conformance-validate.mjs');
const rendererPath = join(repoRoot, 'scripts', 'commerce-c6od-preview-status-render.mjs');

const expectedSurfaces = [
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
];

const forbiddenOutputPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_live_|pk_live_|whsec_|postgres:\/\/|postgresql:\/\/|redis:\/\/|bearer\s+[A-Za-z0-9._-]{20,}|client_secret\s*=|access_token\s*=|refresh_token\s*=|password\s*=|api[_-]?key\s*=/i,
  /\b(?:ten|mch|cprd|cvar|cart|cpi|cconn|caud|jti)_[A-Z0-9][A-Za-z0-9]*/,
  /"provider_metadata"\s*:\s*\{|"raw_payload"\s*:\s*\{/i,
  /\bcertified\b|certification approved|production approved|public protocol publication approved|live payment approved/i,
  /fetch\(|axios\.|got\(|undici/i,
];

const forbiddenJsonEnablementPattern =
  /"(?:public_discovery_enabled|production_checkout_payment_creation_enabled|live_payment_enabled|provider_call_enabled|merchant_private_api_call_enabled)"\s*:\s*true/i;

const forbiddenMarkdownEnablementPattern =
  /(?:Public discovery enabled|Production checkout\/payment creation enabled|Live payment enabled|Provider calls enabled|Merchant private API calls enabled): true/i;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'commerce-c6od-status-'));
}

function runNode(scriptPath: string, args: string[]) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function generateReport(dir: string) {
  const reportPath = join(dir, 'report.json');
  const reportMarkdownPath = join(dir, 'report.md');
  runNode(validatorPath, [
    '--write-report',
    '--json-report',
    reportPath,
    '--markdown-report',
    reportMarkdownPath,
    '--generated-at',
    '2026-06-07T00:00:00.000Z',
  ]);
  return reportPath;
}

function renderStatus(reportPath: string, dir: string) {
  const jsonStatusPath = join(dir, 'status.json');
  const markdownStatusPath = join(dir, 'status.md');
  const output = runNode(rendererPath, [
    '--report',
    reportPath,
    '--json-status',
    jsonStatusPath,
    '--markdown-status',
    markdownStatusPath,
    '--generated-at',
    '2026-06-07T00:00:00.000Z',
  ]);
  return { jsonStatusPath, markdownStatusPath, output };
}

function readStatus(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    status: string;
    badge: {
      label: string;
      message: string;
      color: string;
      public_badge_publication_enabled: boolean;
    };
    counts: {
      fixture_count: number;
      surface_count: number;
      scan_count: number;
    };
    per_surface_status: Array<{ surface: string; status: string }>;
    blocker_summary: { blocked_fixture_count: number; expected_blocker_count: number };
    forbidden_claim_scan_summary: { status: string; scans_checked: number; failure_count: number };
    non_enabling_control_summary: {
      status: string;
      all_guarded_controls_disabled: boolean;
      enabled_guarded_controls: string[];
    };
    safety_posture_summary: {
      statement: string;
      preview_internal_only: boolean;
      sandbox_only: boolean;
      non_live: boolean;
      non_enabling: boolean;
      non_publication: boolean;
      non_certifying: boolean;
      public_discovery_enabled: boolean;
      production_checkout_payment_creation_enabled: boolean;
      live_payment_enabled: boolean;
      provider_calls_enabled: boolean;
      merchant_private_api_calls_enabled: boolean;
    };
    failure_summary: { failure_count: number; failure_scopes: string[] };
    publication_status: string;
    certification_claims: string[];
  };
}

describe('C6Od preview conformance status renderer', () => {
  it('parses a valid C6Oc report and renders internal status artifacts', () => {
    const dir = tempDir();
    try {
      const reportPath = generateReport(dir);
      const { jsonStatusPath, markdownStatusPath, output } = renderStatus(reportPath, dir);
      const status = readStatus(jsonStatusPath);
      const markdown = readFileSync(markdownStatusPath, 'utf8');

      expect(output).toContain('commerce C6Od preview conformance status rendered');
      expect(status).toMatchObject({
        status: 'passing',
        counts: {
          fixture_count: 10,
          surface_count: 5,
          scan_count: 104,
        },
      });
      expect(status.badge).toMatchObject({
        label: 'internal preview conformance',
        message: 'passing',
        color: 'green',
        public_badge_publication_enabled: false,
      });
      expect(status.per_surface_status.map((surface) => surface.surface).sort()).toEqual(expectedSurfaces);
      expect(status.blocker_summary.blocked_fixture_count).toBe(5);
      expect(status.forbidden_claim_scan_summary.status).toBe('passed');
      expect(status.non_enabling_control_summary.status).toBe('passed');
      expect(markdown).toContain('# Open Protocol Preview Conformance Status');
      expect(markdown).toContain('not public protocol publication');
      expect(markdown).toContain('not a certification artifact');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('does not write status files unless output paths are requested', () => {
    const dir = tempDir();
    try {
      const reportPath = generateReport(dir);
      const jsonStatusPath = join(dir, 'status.json');
      const markdownStatusPath = join(dir, 'status.md');
      const output = runNode(rendererPath, ['--report', reportPath]);

      expect(output).toContain('commerce C6Od preview conformance status rendered');
      expect(existsSync(jsonStatusPath)).toBe(false);
      expect(existsSync(markdownStatusPath)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('renders failed report input as a failing badge and status', () => {
    const dir = tempDir();
    try {
      const reportPath = generateReport(dir);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        status: string;
        failures: Array<{ scope: string; message: string }>;
        per_surface_results: Array<{ status: string; failed_fixtures: string[] }>;
        forbidden_claim_scan_summary: { status: string; failures: Array<{ path: string; scan: string }> };
      };
      report.status = 'failed';
      report.failures = [{ scope: 'fixture:synthetic-preview.blocked.json', message: 'synthetic failure' }];
      report.per_surface_results[0]!.status = 'failed';
      report.per_surface_results[0]!.failed_fixtures = ['synthetic-preview.blocked.json'];
      report.forbidden_claim_scan_summary.status = 'failed';
      report.forbidden_claim_scan_summary.failures = [{ path: 'synthetic-preview.blocked.json', scan: 'synthetic scan' }];
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

      const { jsonStatusPath, markdownStatusPath } = renderStatus(reportPath, dir);
      const status = readStatus(jsonStatusPath);
      const markdown = readFileSync(markdownStatusPath, 'utf8');

      expect(status.status).toBe('failing');
      expect(status.badge).toMatchObject({
        message: 'failing',
        color: 'red',
      });
      expect(status.failure_summary).toMatchObject({
        failure_count: 1,
        failure_scopes: ['fixture:synthetic-preview.blocked.json'],
      });
      expect(status.forbidden_claim_scan_summary.failure_count).toBe(1);
      expect(markdown).toContain('- Message: failing');
      expect(markdown).not.toContain('- Message: passing');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('keeps status output private-safe and non-enabling', () => {
    const dir = tempDir();
    try {
      const reportPath = generateReport(dir);
      const { jsonStatusPath, markdownStatusPath } = renderStatus(reportPath, dir);
      const status = readStatus(jsonStatusPath);
      const markdown = readFileSync(markdownStatusPath, 'utf8');
      const combined = `${JSON.stringify(status)}\n${markdown}`;

      for (const pattern of forbiddenOutputPatterns) {
        expect(combined).not.toMatch(pattern);
      }
      expect(JSON.stringify(status)).not.toMatch(forbiddenJsonEnablementPattern);
      expect(markdown).not.toMatch(forbiddenMarkdownEnablementPattern);
      expect(status.safety_posture_summary).toMatchObject({
        preview_internal_only: true,
        sandbox_only: true,
        non_live: true,
        non_enabling: true,
        non_publication: true,
        non_certifying: true,
        public_discovery_enabled: false,
        production_checkout_payment_creation_enabled: false,
        live_payment_enabled: false,
        provider_calls_enabled: false,
        merchant_private_api_calls_enabled: false,
      });
      expect(status.non_enabling_control_summary.all_guarded_controls_disabled).toBe(true);
      expect(status.non_enabling_control_summary.enabled_guarded_controls).toEqual([]);
      expect(status.publication_status).toBe('not_published');
      expect(status.certification_claims).toEqual([]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

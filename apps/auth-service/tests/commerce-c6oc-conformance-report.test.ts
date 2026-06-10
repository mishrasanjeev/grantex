import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const validatorPath = join(repoRoot, 'scripts', 'commerce-c6oa-preview-conformance-validate.mjs');
const fixtureDir = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);

const expectedSurfaces = [
  'acp_style_checkout_shape_preview',
  'ap2_style_evidence_preview',
  'connector_registry_metadata_preview',
  'schemaorg_jsonld_preview',
  'ucp_style_capability_profile_preview',
];

const forbiddenReportPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----|sk_live_|pk_live_|whsec_|postgres:\/\/|postgresql:\/\/|redis:\/\/|bearer\s+[A-Za-z0-9._-]{20,}|client_secret\s*=|access_token\s*=|refresh_token\s*=|password\s*=|api[_-]?key\s*=/i,
  /\b(?:ten|mch|cprd|cvar|cart|cpi|cconn|caud|jti)_[A-Z0-9][A-Za-z0-9]*/,
  /\bcertified\b|certification approved|production approved|public protocol publication approved|live payment approved/i,
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'commerce-c6oc-report-'));
}

function runValidator(args: string[]) {
  return execFileSync(process.execPath, [validatorPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJsonReport(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    status: string;
    generated_at: string;
    source_manifest_path: string;
    fixture_corpus_version: string;
    fixture_count: number;
    surface_count: number;
    scan_count: number;
    per_surface_results: Array<{ surface: string; status: string }>;
    per_fixture_results: Array<{ path: string; status: string }>;
    blocker_summary: { blocked_fixture_count: number; expected_blocker_count: number };
    forbidden_claim_scan_summary: { status: string; scans_checked: number };
    non_enabling_control_summary: {
      status: string;
      all_guarded_controls_disabled: boolean;
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
    failures: Array<{ scope: string; message: string }>;
  };
}

describe('C6Oc preview conformance report generation', () => {
  it('keeps validation-only mode from writing report files', () => {
    const dir = tempDir();
    const jsonReport = join(dir, 'report.json');
    const markdownReport = join(dir, 'report.md');

    try {
      runValidator(['--json-report', jsonReport, '--markdown-report', markdownReport]);

      expect(existsSync(jsonReport)).toBe(false);
      expect(existsSync(markdownReport)).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes parseable JSON and Markdown reports on request', () => {
    const dir = tempDir();
    const jsonReport = join(dir, 'report.json');
    const markdownReport = join(dir, 'report.md');

    try {
      const output = runValidator([
        '--write-report',
        '--json-report',
        jsonReport,
        '--markdown-report',
        markdownReport,
        '--generated-at',
        '2026-06-07T00:00:00.000Z',
      ]);

      expect(output).toContain('commerce C6Oa preview conformance validation passed');
      const report = readJsonReport(jsonReport);
      const markdown = readFileSync(markdownReport, 'utf8');

      expect(report).toMatchObject({
        status: 'passed',
        generated_at: '2026-06-07T00:00:00.000Z',
        source_manifest_path: 'docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/manifest.json',
        fixture_corpus_version: 'c6oa-preview-1',
        fixture_count: 10,
        surface_count: 5,
        scan_count: 104,
      });
      expect(report.per_surface_results.map((surface) => surface.surface).sort()).toEqual(expectedSurfaces);
      expect(report.per_surface_results.every((surface) => surface.status === 'passed')).toBe(true);
      expect(report.per_fixture_results).toHaveLength(10);
      expect(report.blocker_summary.blocked_fixture_count).toBe(5);
      expect(report.forbidden_claim_scan_summary.status).toBe('passed');
      expect(report.non_enabling_control_summary.status).toBe('passed');
      expect(markdown).toContain('# Open Protocol Preview Conformance Report');
      expect(markdown).toContain('Internal preview conformance report only');
      expect(markdown).toContain('not public protocol publication');
      expect(markdown).toContain('not a certification artifact');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('keeps report output free of private values and enabling posture', () => {
    const dir = tempDir();
    const jsonReport = join(dir, 'report.json');
    const markdownReport = join(dir, 'report.md');

    try {
      runValidator(['--write-report', '--json-report', jsonReport, '--markdown-report', markdownReport]);

      const report = readJsonReport(jsonReport);
      const markdown = readFileSync(markdownReport, 'utf8');
      const combined = `${JSON.stringify(report)}\n${markdown}`;

      for (const pattern of forbiddenReportPatterns) {
        expect(combined).not.toMatch(pattern);
      }
      expect(report.safety_posture_summary).toMatchObject({
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
      expect(report.safety_posture_summary.statement).toContain('does not enable public discovery');
      expect(report.safety_posture_summary.statement).toContain('provider calls');
      expect(report.non_enabling_control_summary.all_guarded_controls_disabled).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes a failed report when fixture validation fails', () => {
    const dir = tempDir();
    const tempFixtureDir = join(dir, 'fixtures');
    const jsonReport = join(dir, 'failed-report.json');
    const markdownReport = join(dir, 'failed-report.md');

    try {
      cpSync(fixtureDir, tempFixtureDir, { recursive: true });
      const fixturePath = join(tempFixtureDir, 'schemaorg-jsonld-preview.available.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { preview_only: boolean };
      fixture.preview_only = false;
      writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

      let failed = false;
      try {
        runValidator([
          '--fixture-dir',
          tempFixtureDir,
          '--write-report',
          '--json-report',
          jsonReport,
          '--markdown-report',
          markdownReport,
        ]);
      } catch {
        failed = true;
      }

      expect(failed).toBe(true);
      expect(existsSync(jsonReport)).toBe(true);
      expect(existsSync(markdownReport)).toBe(true);

      const report = readJsonReport(jsonReport);
      expect(report.status).toBe('failed');
      expect(report.fixture_count).toBe(10);
      expect(report.failures.some((failure) => failure.message.includes('preview_only'))).toBe(true);
      expect(
        report.per_fixture_results.find(
          (fixtureResult) => fixtureResult.path === 'schemaorg-jsonld-preview.available.json',
        )?.status,
      ).toBe('failed');
      expect(readFileSync(markdownReport, 'utf8')).toContain('Status: failed');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

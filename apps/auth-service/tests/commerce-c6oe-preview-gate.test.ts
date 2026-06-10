import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const gatePath = join(repoRoot, 'scripts', 'commerce-c6oe-preview-conformance-gate.mjs');
const fixtureDir = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6oa-preview-conformance',
);
const ciWorkflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const c6oeDocPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6oe-preview-conformance-ci-release-gate.md',
);

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

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'commerce-c6oe-gate-'));
}

function runGate(args: string[]) {
  return execFileSync(process.execPath, [gatePath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseSummary(output: string) {
  const jsonStart = output.indexOf('{');
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(jsonStart)) as {
    status: string;
    mode: string;
    fixture_validation: {
      status: string;
      fixtures_checked: number;
      surfaces_checked: number;
      scans_checked: number;
    };
    report: {
      path: string;
      status: string;
      fixture_count: number;
      surface_count: number;
      scan_count: number;
    };
    status_page: {
      path: string;
      status: string;
      badge: {
        label: string;
        message: string;
        color: string;
      };
    };
    work_dir: string;
    artifacts_retained: boolean;
  };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

async function gateModule() {
  return import(pathToFileURL(gatePath).href) as Promise<{
    validateGateArtifacts: (input: {
      fixtureDir?: string;
      report: Record<string, any>;
      status: Record<string, any>;
      validationSummary: Record<string, any>;
      reportSummary: Record<string, any>;
      statusSummary: Record<string, any>;
    }) => void;
  }>;
}

function passingArtifacts() {
  const dir = tempDir();
  runGate(['--mode', 'release-review', '--work-dir', dir]);
  const report = readJson(join(dir, 'open-protocol-preview-conformance.report.json'));
  const status = readJson(join(dir, 'open-protocol-preview-conformance.status.json'));
  const validationSummary = {
    status: 'passed',
    fixtures_checked: 10,
    surfaces_checked: 5,
    scans_checked: 104,
  };
  const reportSummary = {
    status: 'passed',
    fixtures_checked: 10,
    surfaces_checked: 5,
    scans_checked: 104,
  };
  const statusSummary = {
    status: status.status,
    fixture_count: 10,
    surface_count: 5,
    scan_count: 104,
  };
  return { dir, report, reportSummary, status, statusSummary, validationSummary };
}

describe('C6Oe preview conformance gate', () => {
  it('passes in PR mode with the current C6Oa-C6Od chain', () => {
    const output = runGate(['--mode', 'pr']);
    const summary = parseSummary(output);

    expect(output).toContain('commerce C6Oe preview conformance gate passed');
    expect(summary).toMatchObject({
      status: 'passed',
      mode: 'pr',
      artifacts_retained: false,
      work_dir: 'temporary',
      fixture_validation: {
        status: 'passed',
        fixtures_checked: 10,
        surfaces_checked: 5,
        scans_checked: 104,
      },
      report: {
        status: 'passed',
        fixture_count: 10,
        surface_count: 5,
        scan_count: 104,
      },
      status_page: {
        status: 'passing',
        badge: {
          label: 'internal preview conformance',
          message: 'passing',
          color: 'green',
        },
      },
    });
  });

  it('uses temp outputs in PR mode and does not create committed report or status files', () => {
    runGate(['--mode', 'pr']);

    expect(
      existsSync(join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports', 'open-protocol-preview-conformance.report.json')),
    ).toBe(false);
    expect(
      existsSync(join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports', 'open-protocol-preview-conformance.status.json')),
    ).toBe(false);
  });

  it('writes release-review artifacts into the explicit work directory', () => {
    const dir = tempDir();
    try {
      const output = runGate(['--mode', 'release-review', '--work-dir', dir]);
      const summary = parseSummary(output);
      const reportJson = join(dir, 'open-protocol-preview-conformance.report.json');
      const reportMarkdown = join(dir, 'open-protocol-preview-conformance.report.md');
      const statusJson = join(dir, 'open-protocol-preview-conformance.status.json');
      const statusMarkdown = join(dir, 'open-protocol-preview-conformance.status.md');

      expect(summary).toMatchObject({
        status: 'passed',
        mode: 'release-review',
        artifacts_retained: true,
      });
      expect(existsSync(reportJson)).toBe(true);
      expect(existsSync(reportMarkdown)).toBe(true);
      expect(existsSync(statusJson)).toBe(true);
      expect(existsSync(statusMarkdown)).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('writes parseable release-review summaries for report and status artifacts', () => {
    const dir = tempDir();
    try {
      runGate(['--mode', 'release-review', '--work-dir', dir]);
      const report = readJson(join(dir, 'open-protocol-preview-conformance.report.json'));
      const status = readJson(join(dir, 'open-protocol-preview-conformance.status.json'));
      const reportMarkdown = readFileSync(join(dir, 'open-protocol-preview-conformance.report.md'), 'utf8');
      const statusMarkdown = readFileSync(join(dir, 'open-protocol-preview-conformance.status.md'), 'utf8');

      expect(report).toMatchObject({
        status: 'passed',
        fixture_count: 10,
        surface_count: 5,
        scan_count: 104,
      });
      expect(status).toMatchObject({
        status: 'passing',
        counts: {
          fixture_count: 10,
          surface_count: 5,
          scan_count: 104,
        },
      });
      expect(report.per_surface_results.map((surface: { surface: string }) => surface.surface).sort()).toEqual(
        expectedSurfaces,
      );
      expect(status.per_surface_status.map((surface: { surface: string }) => surface.surface).sort()).toEqual(
        expectedSurfaces,
      );
      expect(reportMarkdown).toContain('Open Protocol Preview Conformance Report');
      expect(statusMarkdown).toContain('Open Protocol Preview Conformance Status');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('detects failed report and status mismatch', async () => {
    const { dir, report, reportSummary, status, statusSummary, validationSummary } = passingArtifacts();
    try {
      const { validateGateArtifacts } = await gateModule();
      report.status = 'failed';
      status.status = 'passing';
      status.badge.message = 'passing';

      expect(() => validateGateArtifacts({
        report,
        reportSummary,
        status,
        statusSummary,
        validationSummary,
      })).toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('detects missing required surface', async () => {
    const { dir, report, reportSummary, status, statusSummary, validationSummary } = passingArtifacts();
    try {
      const { validateGateArtifacts } = await gateModule();
      report.per_surface_results = report.per_surface_results.filter(
        (surface: { surface: string }) => surface.surface !== 'schemaorg_jsonld_preview',
      );

      expect(() => validateGateArtifacts({
        report,
        reportSummary,
        status,
        statusSummary,
        validationSummary,
      })).toThrow(/schemaorg_jsonld_preview/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects unsafe publication, certification, or enabling posture', async () => {
    const { dir, report, reportSummary, status, statusSummary, validationSummary } = passingArtifacts();
    try {
      const { validateGateArtifacts } = await gateModule();
      status.safety_posture_summary.public_discovery_enabled = true;

      expect(() => validateGateArtifacts({
        report,
        reportSummary,
        status,
        statusSummary,
        validationSummary,
      })).toThrow(/public discovery/);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('keeps gate output free of secrets, private IDs, provider metadata, and raw payloads', () => {
    const dir = tempDir();
    try {
      const output = runGate(['--mode', 'release-review', '--work-dir', dir]);
      const combined = [
        output,
        readFileSync(join(dir, 'open-protocol-preview-conformance.report.json'), 'utf8'),
        readFileSync(join(dir, 'open-protocol-preview-conformance.report.md'), 'utf8'),
        readFileSync(join(dir, 'open-protocol-preview-conformance.status.json'), 'utf8'),
        readFileSync(join(dir, 'open-protocol-preview-conformance.status.md'), 'utf8'),
      ].join('\n');

      for (const pattern of forbiddenOutputPatterns) {
        expect(combined).not.toMatch(pattern);
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('exits nonzero on validation failure', () => {
    const dir = tempDir();
    const copiedFixtureDir = join(dir, 'fixtures');
    try {
      cpSync(fixtureDir, copiedFixtureDir, { recursive: true });
      const fixturePath = join(copiedFixtureDir, 'schemaorg-jsonld-preview.available.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { preview_only: boolean };
      fixture.preview_only = false;
      writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

      expect(() => runGate(['--mode', 'pr', '--fixture-dir', copiedFixtureDir])).toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('documents the deterministic CI command', () => {
    const workflow = readFileSync(ciWorkflowPath, 'utf8');
    const docs = readFileSync(c6oeDocPath, 'utf8');
    const command = 'node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode pr';

    expect(workflow).toContain(command);
    expect(docs).toContain(command);
    expect(docs).toContain('--mode release-review --work-dir');
    expect(docs).toContain('not public protocol publication');
    expect(docs).toContain('not a certification artifact');
  });
});

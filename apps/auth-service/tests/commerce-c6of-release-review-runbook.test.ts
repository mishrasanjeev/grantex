import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const runbookPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6of-conformance-release-review-runbook.md',
);
const gatePath = join(repoRoot, 'scripts', 'commerce-c6oe-preview-conformance-gate.mjs');
const reportsDir = join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports');

const releaseReviewCommand =
  'node scripts/commerce-c6oe-preview-conformance-gate.mjs --mode release-review --work-dir <local-review-dir>';

const expectedArtifacts = [
  'open-protocol-preview-conformance.report.json',
  'open-protocol-preview-conformance.report.md',
  'open-protocol-preview-conformance.status.json',
  'open-protocol-preview-conformance.status.md',
];

const expectedSurfaces = [
  'ACP-style checkout shape preview',
  'AP2-style evidence preview',
  'connector registry metadata preview',
  'schema.org JSON-LD preview',
  'UCP-style capability profile preview',
];

function readRunbook() {
  return readFileSync(runbookPath, 'utf8');
}

function parseSummary(output: string) {
  const jsonStart = output.indexOf('{');
  expect(jsonStart).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(jsonStart)) as {
    status: string;
    mode: string;
    report: {
      status: string;
      fixture_count: number;
      surface_count: number;
      scan_count: number;
    };
    status_page: {
      status: string;
      badge: {
        message: string;
        color: string;
      };
    };
    artifacts_retained: boolean;
  };
}

describe('C6Of conformance release-review runbook', () => {
  it('documents the C6Oe release-review command', () => {
    const runbook = readRunbook();

    expect(runbook).toContain(releaseReviewCommand);
    expect(runbook).toContain('--mode release-review --work-dir');
    expect(runbook).toContain('scripts/commerce-c6oe-preview-conformance-gate.mjs');
  });

  it('documents expected release-review artifacts', () => {
    const runbook = readRunbook();

    for (const artifact of expectedArtifacts) {
      expect(runbook).toContain(artifact);
    }
  });

  it('documents reviewer checklist, pass/fail criteria, stop conditions, and rollback notes', () => {
    const runbook = readRunbook();

    expect(runbook).toContain('## Reviewer Checklist');
    expect(runbook).toContain('## Pass Criteria');
    expect(runbook).toContain('## Fail Criteria');
    expect(runbook).toContain('## Stop Conditions');
    expect(runbook).toContain('## Rollback');
    expect(runbook).toContain('fixtures_checked: 10');
    expect(runbook).toContain('surfaces_checked: 5');
    expect(runbook).toContain('scans_checked: 104');

    for (const surface of expectedSurfaces) {
      expect(runbook).toContain(surface);
    }
  });

  it('keeps evidence retention local/internal with no committed timestamped artifacts', () => {
    const runbook = readRunbook();

    expect(runbook).toContain('## Evidence Retention');
    expect(runbook).toContain('local/internal evidence only');
    expect(runbook).toContain('Do not commit generated timestamped report or status artifacts');
    expect(runbook).toContain('not public publication and not certification');
  });

  it('does not include public publication, certification, or production approval claims', () => {
    const runbook = readRunbook();

    expect(runbook).toContain('not public protocol publication');
    expect(runbook).toContain('not a certification artifact');
    expect(runbook).not.toMatch(
      /\b(certified|certification approved|production approved|public protocol publication approved|live payment approved|schema\.org certified|ucp certified|acp certified|ap2 certified|provider certified|protocol-publication certified)\b/i,
    );
    expect(runbook).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true/i);
    expect(runbook).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=\s*[^<\s]/i);
  });

  it('runs the first gated release rehearsal into an explicit local work directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commerce-c6of-runbook-'));
    try {
      const output = execFileSync(
        process.execPath,
        [gatePath, '--mode', 'release-review', '--work-dir', dir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const summary = parseSummary(output);

      expect(output).toContain('commerce C6Oe preview conformance gate passed');
      expect(summary).toMatchObject({
        status: 'passed',
        mode: 'release-review',
        artifacts_retained: true,
        report: {
          status: 'passed',
          fixture_count: 10,
          surface_count: 5,
          scan_count: 104,
        },
        status_page: {
          status: 'passing',
          badge: {
            message: 'passing',
            color: 'green',
          },
        },
      });

      const actualArtifacts = readdirSync(dir).sort();
      expect(actualArtifacts).toEqual([...expectedArtifacts].sort());

      const report = JSON.parse(
        readFileSync(join(dir, 'open-protocol-preview-conformance.report.json'), 'utf8'),
      ) as {
        status: string;
        fixture_count: number;
        surface_count: number;
        scan_count: number;
      };
      const status = JSON.parse(
        readFileSync(join(dir, 'open-protocol-preview-conformance.status.json'), 'utf8'),
      ) as {
        status: string;
        counts: {
          fixture_count: number;
          surface_count: number;
          scan_count: number;
        };
      };

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
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('does not rely on committed generated report or status artifacts', () => {
    const committedArtifactPaths = expectedArtifacts.map((artifact) => join(reportsDir, artifact));

    for (const artifactPath of committedArtifactPaths) {
      expect(existsSync(artifactPath)).toBe(false);
    }
  });
});

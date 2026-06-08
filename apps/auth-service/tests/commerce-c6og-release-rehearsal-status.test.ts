import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const assessmentPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6og-release-rehearsal-status-launch-gap-assessment.md',
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

const remainingBlockers = [
  'Public protocol publication',
  'UCP/ACP/AP2/schema.org/MPP/A2A/provider/live-payment certification',
  'Grantex public discovery',
  'AgenticOrg public commerce discovery',
  'Production Commerce V1',
  'Production checkout/payment creation',
  'Live payments/live Plural/live providers',
  'Production allowlists',
];

function readAssessment() {
  return readFileSync(assessmentPath, 'utf8');
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

describe('C6Og release rehearsal status and launch gap assessment', () => {
  it('records the C6Of rehearsal command, status, and counts', () => {
    const assessment = readAssessment();

    expect(assessment).toContain(releaseReviewCommand);
    expect(assessment).toContain('| Release-review gate | passed |');
    expect(assessment).toContain('| Fixture count | 10 |');
    expect(assessment).toContain('| Surface count | 5 |');
    expect(assessment).toContain('| Scan count | 104 |');
    expect(assessment).toContain('| Rendered status | passing |');
    expect(assessment).toContain('| Badge status | passing |');
  });

  it('documents expected local report and status artifacts without committing them', () => {
    const assessment = readAssessment();

    for (const artifact of expectedArtifacts) {
      expect(assessment).toContain(artifact);
      expect(existsSync(join(reportsDir, artifact))).toBe(false);
    }
  });

  it('documents all remaining launch blockers', () => {
    const assessment = readAssessment();

    expect(assessment).toContain('## Remaining Launch Gap Matrix');
    for (const blocker of remainingBlockers) {
      expect(assessment).toContain(blocker);
    }
    expect(assessment).toContain('No-go for public or production launch');
  });

  it('keeps evidence retention internal preview only and non-enabling', () => {
    const assessment = readAssessment();

    expect(assessment).toContain('internal preview evidence only');
    expect(assessment).toContain('sandbox-only');
    expect(assessment).toContain('non-live');
    expect(assessment).toContain('non-enabling');
    expect(assessment).toContain('not public publication and not certification');
    expect(assessment).toContain('local/internal only');
    expect(assessment).toContain('must not be committed under `docs/internal/commerce-v1/reports`');
  });

  it('does not claim public publication, certification, live, checkout, provider, config, or allowlist enablement', () => {
    const assessment = readAssessment();

    expect(assessment).toContain('not public protocol publication');
    expect(assessment).toContain('not a certification artifact');
    expect(assessment).not.toMatch(
      /\b(certified|certification approved|production approved|public protocol publication approved|live payment approved|schema\.org certified|ucp certified|acp certified|ap2 certified|provider certified|protocol-publication certified)\b/i,
    );
    expect(assessment).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true/i);
    expect(assessment).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=\s*[^<\s]/i);
    expect(assessment).not.toMatch(/public_discovery_enabled\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/checkout[^.\n]*(enabled|creation|created|published)\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/payment_enabled\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/live_[A-Za-z0-9_]*\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/provider_call_enabled\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/merchant_private_api_call_enabled\s*[:=]\s*true/i);
    expect(assessment).not.toMatch(/production_allowlist[^.\n]*\s*[:=]\s*true/i);
  });

  it('verifies temp-dir rehearsal behavior and removes generated artifacts after validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'commerce-c6og-rehearsal-'));
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
      expect(readdirSync(dir).sort()).toEqual([...expectedArtifacts].sort());
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }

    expect(existsSync(dir)).toBe(false);
  });
});

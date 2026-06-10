import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const validatorPath = join(repoRoot, 'scripts', 'commerce-c6oa-preview-conformance-validate.mjs');

describe('C6Ob preview conformance validator automation', () => {
  it('validates the C6Oa manifest, fixtures, posture, and regression scans', () => {
    const output = execFileSync(process.execPath, [validatorPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(output).toContain('commerce C6Oa preview conformance validation passed');
    const jsonStart = output.indexOf('{');
    expect(jsonStart).toBeGreaterThan(-1);
    const summary = JSON.parse(output.slice(jsonStart)) as {
      status: string;
      fixtures_checked: number;
      surfaces_checked: number;
      scans_checked: number;
      manifest: string;
    };

    expect(summary).toMatchObject({
      status: 'passed',
      fixtures_checked: 10,
      surfaces_checked: 5,
      manifest: 'docs/internal/commerce-v1/fixtures/c6oa-preview-conformance/manifest.json',
    });
    expect(summary.scans_checked).toBeGreaterThanOrEqual(80);
  });
});

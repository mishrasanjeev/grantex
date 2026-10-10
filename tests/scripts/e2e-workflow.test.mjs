import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/e2e.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.e2e;

test('production principal-session tests wait out the shared token issuance window', () => {
  const index = job.steps.findIndex((step) => step.name === 'Principal sessions');
  assert.ok(index > 0);
  assert.equal(job.steps[index - 1].run, 'sleep 65');
  assert.match(job.steps[index].run, /vitest run.*tests\/e2e\/principal-sessions\.test\.ts/);
});

test('production E2E failures stay fatal and rate-limit waits fit the job deadline', () => {
  assert.ok(!job['continue-on-error']);
  for (const step of job.steps) assert.ok(!step['continue-on-error'], step.name);
  const waits = job.steps.filter((step) => /^sleep \d+$/.test(step.run ?? ''));
  const waitSeconds = waits.reduce((total, step) => total + Number(step.run.split(' ')[1]), 0);
  assert.ok(waitSeconds >= 130);
  assert.ok(job['timeout-minutes'] * 60 - waitSeconds >= 300);
  const crossFeature = job.steps.findIndex((step) => step.name === 'Cross-feature');
  assert.ok(crossFeature > 0);
  assert.equal(job.steps[crossFeature - 1].run, 'sleep 65');
});

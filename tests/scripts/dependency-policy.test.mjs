import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const yaml = (path) => parse(readFileSync(`${root}${path}`, 'utf8'));

test('CodeQL initialization, build and analysis use one pinned revision', () => {
  const workflow = yaml('.github/workflows/codeql.yml');
  const actions = Object.values(workflow.jobs).flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith('github/codeql-action/'));
  assert.equal(actions.length, 3);
  const revisions = actions.map((step) => step.uses.split('@')[1]);
  assert.ok(revisions.every((revision) => /^[a-f0-9]{40}$/.test(revision)));
  assert.equal(new Set(revisions).size, 1);
});

test('CodeQL action updates remain grouped', () => {
  const actions = yaml('.github/dependabot.yml').updates
    .find((update) => update['package-ecosystem'] === 'github-actions');
  assert.ok(actions.groups.codeql.patterns.includes('github/codeql-action/*'));
});

for (const directory of ['/', '/packages/strands-py']) {
  test(`MCP major upgrades require explicit compatibility review in ${directory}`, () => {
    const update = yaml('.github/dependabot.yml').updates.find((item) =>
      item['package-ecosystem'] === 'pip' && item.directory === directory);
    const rule = update.ignore?.find((item) => item['dependency-name'] === 'mcp');
    assert.deepEqual(rule?.['update-types'], ['version-update:semver-major']);
    assert.equal(rule.versions, undefined);
  });
}

test('dependency review admits the existing permissive Python license policy', () => {
  const workflow = yaml('.github/workflows/dependency-review.yml');
  const step = workflow.jobs['dependency-review'].steps
    .find((item) => item.uses?.startsWith('actions/dependency-review-action@'));
  const licenses = step.with['allow-licenses'].split(',').map((value) => value.trim());
  assert.ok(licenses.includes('MIT'));
  assert.ok(licenses.includes('Python-2.0'));
  assert.equal(step.with['fail-on-severity'], 'moderate');
  assert.equal(step.with['license-check'], true);
  assert.equal(step.with['allow-dependencies-licenses'], 'pkg:npm/json-schema@0.4.0');
});

test('CI executes dependency policy regressions', () => {
  const workflow = yaml('.github/workflows/ci.yml');
  assert.ok(workflow.jobs['docs-integrity'].steps
    .some((step) => step.run?.includes('tests/scripts/dependency-policy.test.mjs')));
});

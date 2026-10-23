import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import semver from 'semver';

const root = fileURLToPath(new URL('../../', import.meta.url));
const yaml = (path) => parse(readFileSync(`${root}${path}`, 'utf8'));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const json = (path) => JSON.parse(readFileSync(`${root}${path}`, 'utf8'));
const vulnerable = {
  '@vitest/mocker': '<4.1.12 || >=5.0.0 <5.0.3',
  'ip-address': '<10.7.4',
  fastify: '>=5.12.2 <5.12.6',
  next: '>=16.4.0 <16.4.1',
  sharp: '<0.35.5',
  zod: '<4.6.6',
  'body-parser': '<1.20.9 || >=2.0.0 <2.4.0',
};

test('tracked lockfiles exclude the reviewed vulnerable dependency versions', () => {
  const findings = [];
  for (const path of tracked.filter((file) => file.endsWith('package-lock.json'))) {
    for (const [location, dependency] of Object.entries(json(path).packages ?? {})) {
      const name = location.split('node_modules/').at(-1);
      if (vulnerable[name] && semver.valid(dependency.version)
        && semver.satisfies(dependency.version, vulnerable[name])) {
        findings.push(`${path}: ${name}@${dependency.version}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});

test('Vitest manifest floors cannot resolve a reviewed vulnerable mocker release', () => {
  for (const path of tracked.filter((file) => file.endsWith('package.json'))) {
    for (const [name, range] of Object.entries(json(path).devDependencies ?? {})) {
      if (name !== 'vitest' && name !== '@vitest/coverage-v8') continue;
      assert.ok(semver.validRange(range), `${path}: invalid ${name} range`);
      assert.ok(!semver.intersects(range, vulnerable['@vitest/mocker']),
        `${path}: ${name} permits vulnerable releases`);
    }
  }
});

test('reviewed Zod trees retain the patched compatibility pin', () => {
  for (const directory of [
    'apps/auth-service', 'packages/langchain', 'packages/x402',
    'examples/langchain-agent', 'examples/x402-agent-demo', 'examples/x402-weather-api',
  ]) {
    assert.equal(json(`${directory}/package.json`).overrides?.zod, '4.6.7', directory);
  }
});

test('body parser fixes remain within their reviewed major versions', () => {
  for (const [directory, version] of [
    ['apps/mpp-demo-service', '1.20.9'], ['examples/x402-weather-api', '1.20.9'],
    ['packages/mcp', '2.4.0'], ['packages/mpp', '2.4.0'],
    ['packages/express', '2.4.0'], ['packages/mcp-auth', '2.4.0'], ['packages/x402', '2.4.0'],
  ]) {
    assert.equal(json(`${directory}/package.json`).overrides?.['body-parser'], version);
  }
});

test('CI executes compressed-body liveness regressions', () => {
  assert.ok(yaml('.github/workflows/ci.yml').jobs['mcp-packages'].steps
    .some(step => step.run?.includes('node --test tests/scripts/body-parser.test.mjs')));
});

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

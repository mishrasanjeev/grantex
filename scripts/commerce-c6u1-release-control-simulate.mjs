import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';

const explicitNonDocsOnlyMatchers = [
  {
    name: 'github_workflow',
    test: (path) => path.startsWith('.github/workflows/'),
  },
  {
    name: 'runtime_app',
    test: (path) => path.startsWith('apps/'),
  },
  {
    name: 'package_source',
    test: (path) => path.startsWith('packages/'),
  },
  {
    name: 'script_or_tooling',
    test: (path) => path.startsWith('scripts/'),
  },
  {
    name: 'deploy_assets',
    test: (path) => path.startsWith('deploy/'),
  },
  {
    name: 'web_assets',
    test: (path) => path.startsWith('web/'),
  },
  {
    name: 'migration',
    test: (path) => path.includes('/migrations/') || path.startsWith('migrations/'),
  },
  {
    name: 'dockerfile',
    test: (path) => basename(path).startsWith('Dockerfile'),
  },
  {
    name: 'firebase_config',
    test: (path) => path === 'firebase.json' || path === '.firebaserc',
  },
  {
    name: 'dependency_manifest_or_lockfile',
    test: (path) =>
      path === 'package.json' ||
      path === 'package-lock.json' ||
      path.endsWith('/package.json') ||
      path.endsWith('/package-lock.json') ||
      path === 'pyproject.toml' ||
      path.endsWith('/pyproject.toml') ||
      path.endsWith('poetry.lock') ||
      path.endsWith('Pipfile.lock') ||
      path.endsWith('pnpm-lock.yaml') ||
      path.endsWith('yarn.lock'),
  },
  {
    name: 'config_file',
    test: (path) =>
      path.endsWith('.config.js') ||
      path.endsWith('.config.mjs') ||
      path.endsWith('.config.ts') ||
      path.endsWith('.toml') ||
      path.endsWith('.env') ||
      path.endsWith('.env.example'),
  },
];

function normalizeChangedPath(path) {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function isRootMarkdown(path) {
  return /^[^/]+\.md$/i.test(path);
}

function isAllowedDocsOnlyPath(path) {
  if (path === 'README.md') return true;
  if (isRootMarkdown(path)) return true;
  if (path.startsWith('docs/')) return true;
  return false;
}

export function classifyChangedFiles(changedFiles) {
  const files = changedFiles.map(normalizeChangedPath).filter(Boolean);
  if (files.length === 0) {
    return {
      docsOnly: false,
      reason: 'empty_change_set',
      nonDocsOnlyFiles: [],
    };
  }

  const nonDocsOnlyFiles = [];
  for (const path of files) {
    const explicitMatch = explicitNonDocsOnlyMatchers.find((matcher) => matcher.test(path));
    if (explicitMatch) {
      nonDocsOnlyFiles.push({ path, reason: explicitMatch.name });
      continue;
    }
    if (!isAllowedDocsOnlyPath(path)) {
      nonDocsOnlyFiles.push({ path, reason: 'unknown_or_not_allowlisted' });
    }
  }

  return {
    docsOnly: nonDocsOnlyFiles.length === 0,
    reason: nonDocsOnlyFiles.length === 0 ? 'docs_only_allowlist_match' : 'non_docs_only_path_found',
    nonDocsOnlyFiles,
  };
}

function assertClassification(name, files, expectedDocsOnly, expectedReasons = []) {
  const result = classifyChangedFiles(files);
  assert.equal(result.docsOnly, expectedDocsOnly, `${name} docsOnly mismatch`);
  for (const expectedReason of expectedReasons) {
    assert.ok(
      result.reason === expectedReason ||
        result.nonDocsOnlyFiles.some((entry) => entry.reason === expectedReason),
      `${name} expected reason ${expectedReason}`,
    );
  }
  console.log(`${name}: docs_only=${result.docsOnly} reason=${result.reason}`);
}

export function runSelfTest() {
  assertClassification('internal commerce doc', [
    'docs/internal/commerce-v1/commerce-v1-c6u-agentic-commerce-launch-readiness-roadmap.md',
  ], true);
  assertClassification('root markdown', ['README.md', 'GRANTEX_COMMERCE_PRD.md'], true);
  assertClassification('docs route inventory', ['docs/route_inventory.json'], true);
  assertClassification('runtime app change', ['apps/auth-service/src/index.ts'], false, ['runtime_app']);
  assertClassification('workflow change', ['.github/workflows/deploy.yml'], false, ['github_workflow']);
  assertClassification('script change', ['scripts/commerce-c6u1-release-control-simulate.mjs'], false, ['script_or_tooling']);
  assertClassification('package manifest change', ['package.json'], false, ['dependency_manifest_or_lockfile']);
  assertClassification('mixed docs runtime', [
    'docs/internal/commerce-v1/example.md',
    'apps/auth-service/src/index.ts',
  ], false, ['runtime_app']);
  assertClassification('dockerfile change', ['apps/auth-service/Dockerfile'], false, ['runtime_app']);
  assertClassification('firebase change', ['firebase.json'], false, ['firebase_config']);
  assertClassification('unknown path', ['notes/internal-plan.txt'], false, ['unknown_or_not_allowlisted']);
  assertClassification('empty change set', [], false, ['empty_change_set']);
}

const entryPoint = process.argv[1]
  ? fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
  : false;

if (entryPoint) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const result = classifyChangedFiles(args);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.docsOnly ? 0 : 1);
  }
  runSelfTest();
}

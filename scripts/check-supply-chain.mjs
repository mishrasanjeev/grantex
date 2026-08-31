#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const runNpmAudit = process.argv.includes('--audit-npm');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((file) => file.replaceAll('\\', '/'));

const failures = [];
const requiredTaggedReusableWorkflows = new Map([
  [
    'slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml',
    'v2.1.0',
  ],
]);

function dependencyDirectory(file) {
  const directory = posix.dirname(file);
  return directory === '.' ? '/' : `/${directory}`;
}

function expectedDirectories(ecosystem) {
  if (ecosystem === 'npm') {
    return new Set(tracked.filter((file) => posix.basename(file) === 'package.json').map(dependencyDirectory));
  }
  if (ecosystem === 'pip') {
    return new Set(tracked
      .filter((file) => posix.basename(file) === 'pyproject.toml'
        || /^requirements[^/]*\.txt$/u.test(posix.basename(file)))
      .map(dependencyDirectory));
  }
  if (ecosystem === 'gomod') {
    return new Set(tracked.filter((file) => posix.basename(file) === 'go.mod').map(dependencyDirectory));
  }
  if (ecosystem === 'terraform') {
    return new Set(tracked.filter((file) => file.endsWith('.tf')).map(dependencyDirectory));
  }
  if (ecosystem === 'docker') {
    return new Set(tracked.filter((file) => posix.basename(file) === 'Dockerfile').map(dependencyDirectory));
  }
  return new Set();
}

const dependabot = parse(readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8'));
for (const ecosystem of ['npm', 'pip', 'gomod', 'terraform', 'docker']) {
  const configured = new Set(dependabot.updates
    .filter((entry) => entry['package-ecosystem'] === ecosystem)
    .map((entry) => entry.directory));
  for (const directory of expectedDirectories(ecosystem)) {
    if (!configured.has(directory)) failures.push(`Dependabot has no ${ecosystem} entry for ${directory}`);
  }
}
if (!dependabot.updates.some((entry) => entry['package-ecosystem'] === 'github-actions' && entry.directory === '/')) {
  failures.push('Dependabot has no github-actions entry for /');
}

for (const workflow of tracked.filter((file) => file.startsWith('.github/workflows/') && file.endsWith('.yml'))) {
  const lines = readFileSync(resolve(root, workflow), 'utf8').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith('#')) continue;
    const match = /\buses:\s*([^\s#]+)@([^\s#]+)/u.exec(line);
    if (!match || match[1].startsWith('./')) continue;
    const requiredTag = requiredTaggedReusableWorkflows.get(match[1]);
    if (requiredTag !== undefined && match[2] === requiredTag) continue;
    if (!/^[a-f0-9]{40}$/u.test(match[2])) {
      failures.push(`${workflow}:${index + 1} uses mutable action reference ${match[1]}@${match[2]}`);
    }
  }
}

const imageFiles = tracked.filter((file) => file.endsWith('/Dockerfile')
  || file === 'docker-compose.yml'
  || file === 'docker-compose.prod.yml'
  || (file.startsWith('.github/workflows/') && file.endsWith('.yml'))
  || file === 'deploy/helm/grantex/values.yaml');
for (const file of imageFiles) {
  const lines = readFileSync(resolve(root, file), 'utf8').split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const dockerfileImage = /^\s*FROM\s+([^\s]+)(?:\s+AS\s+\S+)?\s*$/iu.exec(line)?.[1];
    const yamlImage = /^\s*image:\s*([^\s#]+)\s*$/u.exec(line)?.[1];
    const image = dockerfileImage ?? yamlImage;
    if (!image || image === 'scratch' || image.includes('{{')) continue;
    if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
      failures.push(`${file}:${index + 1} uses an unpinned container image ${image}`);
    }
  }
}

const allowedLicenseIds = new Set([
  '0BSD', 'AFL-2.1', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'CC-BY-4.0', 'CC0-1.0', 'ISC', 'LGPL-3.0-or-later',
  'MIT', 'MIT-0', 'MPL-2.0', 'Unlicense',
  'LicenseRef-scancode-google-patent-license-golang',
  'LicenseRef-scancode-unicode',
]);
const knownMissingLicenseMetadata = new Map([
  ['@types/node', 'MIT'],
  ['fsevents', 'MIT'],
  ['typescript', 'Apache-2.0'],
  ['undici-types', 'MIT'],
]);

function packageName(packagePath) {
  return packagePath.split('node_modules/').at(-1);
}

function licenseIds(expression) {
  return expression
    .replaceAll(/[()]/gu, '')
    .split(/\s+(?:AND|OR)\s+/u)
    .map((license) => license.trim())
    .filter(Boolean);
}

const lockfiles = tracked.filter((file) => posix.basename(file) === 'package-lock.json');
const lockDirectories = new Set(lockfiles.map(dependencyDirectory));
for (const directory of expectedDirectories('npm')) {
  if (!lockDirectories.has(directory)) {
    failures.push(`Tracked npm project has no package-lock.json in ${directory}`);
  }
}
let packageEntries = 0;
let lgplObserved = false;
let ccByObserved = false;

for (const lockfile of lockfiles) {
  const lock = JSON.parse(readFileSync(resolve(root, lockfile), 'utf8'));
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = String(entry.resolved ?? '');
    if (resolved.startsWith('file:')
        || resolved.includes('AppData/Local/Temp')
        || /^[A-Za-z]:[\\/]/.test(resolved)
        || resolved.startsWith('\\\\')) {
      failures.push(`${lockfile}: ${packagePath || '<root>'} uses non-portable resolution ${resolved}`);
    }
    if (!packagePath || !entry.version || entry.link || resolved.startsWith('file:')) continue;
    packageEntries += 1;
    const name = packageName(packagePath);
    const license = entry.license ?? knownMissingLicenseMetadata.get(name);
    if (!license) {
      failures.push(`${lockfile}: ${name}@${entry.version} has no license metadata or reviewed exception`);
      continue;
    }
    for (const id of licenseIds(license)) {
      if (!allowedLicenseIds.has(id)) failures.push(`${lockfile}: ${name}@${entry.version} uses unapproved license ${id}`);
    }
    lgplObserved ||= license.includes('LGPL-3.0-or-later');
    ccByObserved ||= license.includes('CC-BY-4.0');
  }
}

const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
if (lgplObserved && (!notices.includes('@img/sharp-libvips') || !notices.includes('LGPL-3.0-or-later'))) {
  failures.push('THIRD_PARTY_NOTICES.md does not document the observed Sharp/libvips LGPL dependency');
}
if (ccByObserved && (!notices.includes('caniuse-lite') || !notices.includes('CC-BY-4.0'))) {
  failures.push('THIRD_PARTY_NOTICES.md does not document the observed caniuse-lite CC-BY dependency');
}

if (runNpmAudit) {
  for (const lockfile of lockfiles) {
    const directory = dirname(resolve(root, lockfile));
    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm audit --package-lock-only --ignore-scripts --json']
      : ['audit', '--package-lock-only', '--ignore-scripts', '--json'];
    const result = spawnSync(executable, args, {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    let report;
    try {
      report = JSON.parse(result.stdout ?? '');
    } catch {
      const detail = result.stderr?.trim() || result.error?.message || 'unknown error';
      failures.push(`${lockfile}: npm audit did not return valid JSON (${detail})`);
      continue;
    }
    const vulnerabilities = Number(report.metadata?.vulnerabilities?.total ?? -1);
    if (vulnerabilities !== 0) failures.push(`${lockfile}: npm audit reports ${vulnerabilities} vulnerabilities`);
  }
}

if (failures.length > 0) {
  console.error(`Supply-chain policy failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Supply-chain policy PASS: ${lockfiles.length} npm lockfiles, ${packageEntries} package entries, complete Dependabot coverage${runNpmAudit ? ', npm audits clean' : ''}.`);

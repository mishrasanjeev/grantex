// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Keeps the PolyForm Noncommercial 1.0.0 relicensing consistent across the
// licence files, package metadata, headers and public statements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8').replaceAll('\r\n', '\n');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);
const packages = readdirSync(new URL('packages/', root));

// SHA-256 of the official PolyForm Noncommercial License 1.0.0 text, from
// "# PolyForm Noncommercial License 1.0.0" to the end, as published at
// https://polyformproject.org/licenses/noncommercial/1.0.0 (Markdown source in
// the polyformproject/polyform-licenses repository, tag 1.0.0).
const OFFICIAL_TEXT_SHA256 = 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';
const REQUIRED_NOTICES = [
  'Required Notice: Copyright 2026 Orchestrum Technologies LLP.',
  'Required Notice: Grantex inventor and owner: Sanjeev Kumar <sanjeev@orchestrum.in> or <mishra.sanjeev@gmail.com>.',
];

test('LICENSE is the unmodified PolyForm Noncommercial 1.0.0 text with the Required Notice lines', () => {
  const license = read('LICENSE');
  const start = license.indexOf('# PolyForm Noncommercial License 1.0.0');
  assert.ok(start > 0, 'licence heading present after the notices');
  const body = license.slice(start);
  assert.equal(createHash('sha256').update(body).digest('hex'), OFFICIAL_TEXT_SHA256);
  const notices = license.slice(0, start).split('\n').filter(Boolean);
  for (const line of REQUIRED_NOTICES) assert.ok(notices.includes(line), line);
  assert.ok(notices.every((line) => line.startsWith('Required Notice: ')));
  assert.match(notices.join('\n'), /written agreement with Orchestrum Technologies LLP/);
});

test('every package carries the same LICENSE as the repository root', () => {
  const license = read('LICENSE');
  for (const name of packages) {
    assert.equal(read(`packages/${name}/LICENSE`), license, `packages/${name}/LICENSE`);
  }
});

test('package metadata declares PolyForm-Noncommercial-1.0.0', () => {
  const manifests = tracked.filter((file) => file.endsWith('package.json')
    && (file.startsWith('packages/') || file === 'apps/auth-service/package.json')
    && file.split('/').length === 3);
  assert.ok(manifests.length >= 20);
  for (const file of manifests) {
    assert.equal(JSON.parse(read(file)).license, 'PolyForm-Noncommercial-1.0.0', file);
  }
  for (const file of tracked.filter((name) => name.endsWith('pyproject.toml'))) {
    const text = read(file);
    assert.match(text, /^license = (?:\{ text = )?"PolyForm-Noncommercial-1\.0\.0"/m, file);
    assert.doesNotMatch(text, /OSI Approved/, file);
  }
  for (const file of ['release-status.json', 'web/release-status.json']) {
    assert.equal(JSON.parse(read(file)).product.license, 'PolyForm-Noncommercial-1.0.0', file);
  }
});

test('no first-party file keeps an Apache-2.0 SPDX header', () => {
  const header = ['SPDX-License-Identifier:', 'Apache-2.0'].join(' ');
  const offenders = tracked.filter((file) => /\.(?:[cm]?[jt]sx?|py|sql|go|sh|ya?ml)$/u.test(file)
    && read(file).includes(header));
  assert.deepEqual(offenders, []);
});

test('commercial licensing, trademarks and contributions are documented', () => {
  const commercial = read('COMMERCIAL-LICENSE.md');
  assert.match(commercial, /Only self use is free/);
  assert.match(commercial, /written agreement/);
  for (const use of ['Internal use by a for-profit business', 'Hosting, SaaS', 'Resale', 'Embedding', 'Consulting']) {
    assert.ok(commercial.includes(use), use);
  }
  assert.match(commercial, /Releases published before 21 October 2026[\s\S]*remain available under the\s+Apache License 2\.0 terms they were released with/);
  assert.doesNotMatch(commercial, /revok/i, 'earlier Apache grants are not described as revoked');
  const trademarks = read('TRADEMARKS.md');
  assert.match(trademarks, /"Grantex" and "AgenticOrg", and their logos, are trademarks of Orchestrum\s+Technologies LLP/);
  assert.match(trademarks, /including use with earlier\s+versions/);
  assert.match(read('CONTRIBUTING.md'), /## Contribution licence[\s\S]*commercial licences/);
  assert.match(read('NOTICE'), /PolyForm Noncommercial\s+License 1\.0\.0/);
});

test('README states the licence near the top', () => {
  const readme = read('README.md');
  const licence = readme.indexOf('\n## Licence\n');
  assert.ok(licence > 0 && licence < readme.indexOf('\n## What is Grantex?\n'));
  assert.doesNotMatch(readme, /License-Apache|Apache 2\.0\)|fully open-source/);
  for (const name of packages) {
    const file = `packages/${name}/README.md`;
    if (!existsSync(new URL(file, root))) continue;
    assert.match(read(file), /## License\n\nPolyForm Noncommercial License 1\.0\.0/, file);
  }
});

test('the documentation site lists the Licence page', () => {
  const docs = JSON.parse(read('docs/docs.json'));
  assert.ok(JSON.stringify(docs.navigation).includes('"license"'));
  assert.match(read('docs/license.mdx'), /title: "Licence"/);
  assert.equal(existsSync(new URL('licensing/scope.json', root)), false, 'superseded draft removed');
});

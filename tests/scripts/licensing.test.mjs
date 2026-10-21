// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
// Keeps the two-licence split consistent: SDKs and client packages under
// packages/ (and examples/) are Apache-2.0; the rest of the repository (the
// Grantex platform) is under the Orchestrum Personal Use License 1.0.
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
const PLATFORM = 'LicenseRef-Orchestrum-Personal-Use-1.0';
const PREVIOUS = ['PolyForm', 'Noncommercial', '1.0.0'].join('-');
const spdx = (id) => ['SPDX-License-Identifier:', id].join(' ');
const clientSide = (file) => ['packages/', 'examples/', 'spec/examples/'].some((prefix) => file.startsWith(prefix));

// SHA-256 of the owner-approved Orchestrum Personal Use License 1.0 text, from
// "# Orchestrum Personal Use License 1.0" to the end, with LF line endings.
const APPROVED_TEXT_SHA256 = '98c1ea584a0735d4e189fca81e774f295d4225a32d2086ecb11a8d0fc75a1982';
const HEADING = '# Orchestrum Personal Use License 1.0';

test('root LICENSE is the approved Orchestrum Personal Use License 1.0 text with the notice and scope', () => {
  const license = read('LICENSE');
  const start = license.indexOf(HEADING);
  assert.ok(start > 0, 'licence heading present after the notice');
  assert.equal(createHash('sha256').update(license.slice(start)).digest('hex'), APPROVED_TEXT_SHA256);
  const body = license.slice(start);
  assert.match(body, /^Copyright \(c\) 2026 Orchestrum Technologies LLP\./m);
  assert.match(body, /requires \*\*prior written permission\*\* from Orchestrum Technologies LLP in a signed agreement/);
  const header = license.slice(0, start);
  assert.ok(header.split('\n').includes(
    'Grantex inventor and owner: Sanjeev Kumar <sanjeev@orchestrum.in> or <mishra.sanjeev@gmail.com>.',
  ));
  assert.match(header, /except the packages\/ and examples\/\s+directories, the spec\/examples\/ test vectors and the spec\/\*\.schema\.json files,\s+which are licensed under the Apache License 2\.0/);
  assert.doesNotMatch(license, /PolyForm|Noncommercial|Required Notice/i);
});

test('every package and the examples carry the Apache License 2.0', () => {
  const apache = read('packages/sdk-ts/LICENSE');
  assert.match(apache, /Apache License\s+Version 2\.0, January 2004/);
  assert.doesNotMatch(apache, /PolyForm|Personal Use License/);
  for (const name of packages) assert.equal(read(`packages/${name}/LICENSE`), apache, `packages/${name}/LICENSE`);
  assert.equal(read('examples/LICENSE'), apache);
  assert.equal(read('spec/examples/LICENSE'), apache);
});

test('package metadata declares Apache-2.0 under packages/ and the platform licence under apps/', () => {
  const manifests = tracked.filter((file) => /^packages\/[^/]+\/package\.json$/u.test(file));
  assert.ok(manifests.length >= 20);
  for (const file of manifests) assert.equal(JSON.parse(read(file)).license, 'Apache-2.0', file);
  for (const file of tracked.filter((name) => /^packages\/[^/]+\/pyproject\.toml$/u.test(name))) {
    const text = read(file);
    assert.match(text, /^license = (?:\{ text = )?"Apache-2\.0"/m, file);
    assert.match(text, /"License :: OSI Approved :: Apache Software License"/, file);
    assert.doesNotMatch(text, /PolyForm|non-commercial|Orchestrum-Personal-Use/i, file);
  }
  const apps = tracked.filter((file) => /^apps\/[^/]+\/package\.json$/u.test(file));
  assert.ok(apps.length >= 3);
  for (const file of apps) {
    assert.equal(JSON.parse(read(file)).license, PLATFORM, file);
    const lock = file.replace(/package\.json$/u, 'package-lock.json');
    if (tracked.includes(lock)) assert.equal(JSON.parse(read(lock)).packages[''].license, PLATFORM, lock);
  }
  for (const file of ['release-status.json', 'web/release-status.json']) {
    const product = JSON.parse(read(file)).product;
    assert.equal(product.license, PLATFORM, file);
    assert.equal(product.licenseName, 'Orchestrum Personal Use License 1.0', file);
    assert.equal(product.licenseUrl, 'https://github.com/mishrasanjeev/grantex/blob/main/LICENSE', file);
    assert.equal(product.sdkLicense, 'Apache-2.0', file);
  }
});

test('SPDX headers follow the split', () => {
  const source = (file) => /\.(?:[cm]?[jt]sx?|py|sql|go|sh|ya?ml|sol)$/u.test(file);
  const files = tracked.filter(source).map((file) => [file, read(file)]);
  assert.deepEqual(files.filter(([, text]) => text.includes(spdx(PREVIOUS))).map(([file]) => file), []);
  const wrong = files.filter(([file, text]) => (clientSide(file)
    ? text.includes(spdx(PLATFORM))
    : text.includes(spdx('Apache-2.0')))).map(([file]) => file);
  assert.deepEqual(wrong, []);
  assert.ok(files.some(([file, text]) => file.startsWith('apps/') && text.includes(spdx(PLATFORM))));
  assert.ok(files.some(([file, text]) => file.startsWith('packages/') && text.includes(spdx('Apache-2.0'))));
});

test('licensing documents state the split and the individuals-only rule', () => {
  const scope = read('LICENSING.md');
  assert.match(scope, /## LICENSE-SCOPE/);
  assert.match(scope, /\| `packages\/`[^\n]*\| Apache-2\.0 \|/);
  assert.match(scope, /\| `examples\/` \| Apache-2\.0 \|/);
  assert.match(scope, /\| `apps\/`[^\n]*\| LicenseRef-Orchestrum-Personal-Use-1\.0 \|/);
  assert.match(scope, /\| The rest of `spec\/` \(specification prose\)[^\n]*\| LicenseRef-Orchestrum-Personal-Use-1\.0 \|/);
  const commercial = read('COMMERCIAL-LICENSE.md');
  assert.match(commercial, /SDKs and client packages in `packages\/`, and `examples\/` \| Apache License 2\.0, open source \| Free for any use, including commercial/);
  assert.match(commercial, /\[Orchestrum Personal Use License 1\.0\]\(LICENSE\)/);
  assert.match(commercial, /only an individual using it for their own personal purposes is free\. Every\s+organisation needs Orchestrum's prior written permission in a signed agreement/);
  assert.match(commercial, /There\s+is no exception for evaluation, charities, education, research or government/);
  for (const use of ['Evaluation, testing and pilots', 'Internal use', 'Hosting, SaaS', 'Resale', 'Embedding', 'Consulting', 'hosted services']) {
    assert.ok(commercial.includes(use), use);
  }
  assert.match(commercial, /Releases published before 21 October 2026 remain available under the terms\s+they were released with\./);
  assert.doesNotMatch(commercial, /revok/i, 'earlier grants are not described as revoked');
  assert.doesNotMatch(commercial, /PolyForm|noncommercial|self use/i);
  assert.match(read('TRADEMARKS.md'), /"Grantex" and "AgenticOrg", and their logos, are trademarks of Orchestrum\s+Technologies LLP/);
  assert.match(read('CONTRIBUTING.md'), /## Contribution licence[\s\S]*Orchestrum Personal Use License 1\.0/);
  const notice = read('NOTICE');
  assert.match(notice, /packages\/, and examples\/, are licensed under\s+the Apache License 2\.0/);
  assert.match(notice, /Orchestrum Personal Use License 1\.0/);
});

test('README and package READMEs state the right licence', () => {
  const readme = read('README.md');
  const licence = readme.indexOf('\n## Licence\n');
  const next = readme.indexOf('\n## What is Grantex?\n');
  assert.ok(licence > 0 && licence < next);
  const section = readme.slice(licence, next);
  assert.match(section, /Apache License 2\.0\]\([^)]*\), open source \| Free for any use, including commercial/);
  assert.match(section, /Orchestrum Personal Use License 1\.0\]\(LICENSE\)/);
  assert.match(section, /any use by or for an organisation/);
  for (const name of packages) {
    const file = `packages/${name}/README.md`;
    if (!existsSync(new URL(file, root))) continue;
    const text = read(file);
    assert.match(text, /## License\n\nApache-2\.0 \(\[LICENSE\]/, file);
    assert.doesNotMatch(text, /PolyForm/, file);
  }
});

test('the documentation site lists the Licence page and the superseded draft is gone', () => {
  const docs = JSON.parse(read('docs/docs.json'));
  assert.ok(JSON.stringify(docs.navigation).includes('"license"'));
  const page = read('docs/license.mdx');
  assert.match(page, /title: "Licence"/);
  assert.match(page, /Apache License 2\.0\]/);
  assert.match(page, /Orchestrum Personal Use License 1\.0\]/);
  assert.equal(existsSync(new URL('licensing/scope.json', root)), false);
});

test('public pages no longer name the superseded PolyForm licence', () => {
  // Historical records and the dependency licence policy may name it.
  const exempt = new Set([
    'CHANGELOG.md',
    'TRADEMARKS.md',
    'scripts/audit-python-dependencies.py',
    'tests/scripts/licensing.test.mjs',
  ]);
  const text = (file) => /\.(?:md|mdx|txt|html|json|ya?ml|toml)$/u.test(file) || /(?:^|\/)(?:NOTICE|LICENSE)$/u.test(file);
  const offenders = tracked
    .filter((file) => text(file) && !exempt.has(file) && !file.startsWith('docs/internal/'))
    .filter((file) => /PolyForm|polyformproject\.org/i.test(read(file)));
  assert.deepEqual(offenders, []);
});

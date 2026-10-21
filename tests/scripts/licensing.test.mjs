// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Keeps the two-licence split consistent: SDKs and client packages under
// packages/ (and examples/) are Apache-2.0; the rest of the repository is
// PolyForm Noncommercial 1.0.0 with commercial licensing by Orchestrum.
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
const POLYFORM = 'PolyForm-Noncommercial-1.0.0';
const spdx = (id) => ['SPDX-License-Identifier:', id].join(' ');

// SHA-256 of the official PolyForm Noncommercial License 1.0.0 text, from
// "# PolyForm Noncommercial License 1.0.0" to the end, as published at
// https://polyformproject.org/licenses/noncommercial/1.0.0 (Markdown source in
// the polyformproject/polyform-licenses repository, tag 1.0.0).
const OFFICIAL_TEXT_SHA256 = 'c0ea4a896d2c8c394b29f9427589996db826cd501c512279ff0ed3ef48fabbe5';
const REQUIRED_NOTICES = [
  'Required Notice: Copyright 2026 Orchestrum Technologies LLP.',
  'Required Notice: Grantex inventor and owner: Sanjeev Kumar <sanjeev@orchestrum.in> or <mishra.sanjeev@gmail.com>.',
];

test('root LICENSE is the unmodified PolyForm Noncommercial 1.0.0 text with notices and its scope', () => {
  const license = read('LICENSE');
  const start = license.indexOf('# PolyForm Noncommercial License 1.0.0');
  assert.ok(start > 0, 'licence heading present after the notices');
  assert.equal(createHash('sha256').update(license.slice(start)).digest('hex'), OFFICIAL_TEXT_SHA256);
  const header = license.slice(0, start);
  for (const line of REQUIRED_NOTICES) assert.ok(header.split('\n').includes(line), line);
  assert.match(header, /Required Notice: Commercial use of any kind requires a prior written agreement with Orchestrum Technologies LLP/);
  assert.match(header, /except the packages\/ and examples\/\s+directories, the spec\/examples\/ test vectors and the spec\/\*\.schema\.json files,\s+which are licensed under the Apache License 2\.0/);
});

test('every package and the examples carry the Apache License 2.0', () => {
  const apache = read('packages/sdk-ts/LICENSE');
  assert.match(apache, /Apache License\s+Version 2\.0, January 2004/);
  assert.doesNotMatch(apache, /PolyForm/);
  for (const name of packages) assert.equal(read(`packages/${name}/LICENSE`), apache, `packages/${name}/LICENSE`);
  assert.equal(read('examples/LICENSE'), apache);
  assert.equal(read('spec/examples/LICENSE'), apache);
});

test('package metadata declares Apache-2.0; the auth service declares PolyForm', () => {
  const manifests = tracked.filter((file) => /^packages\/[^/]+\/package\.json$/u.test(file));
  assert.ok(manifests.length >= 20);
  for (const file of manifests) assert.equal(JSON.parse(read(file)).license, 'Apache-2.0', file);
  for (const file of tracked.filter((name) => /^packages\/[^/]+\/pyproject\.toml$/u.test(name))) {
    const text = read(file);
    assert.match(text, /^license = (?:\{ text = )?"Apache-2\.0"/m, file);
    assert.match(text, /"License :: OSI Approved :: Apache Software License"/, file);
    assert.doesNotMatch(text, /PolyForm|non-commercial/i, file);
  }
  assert.equal(JSON.parse(read('apps/auth-service/package.json')).license, POLYFORM);
  for (const file of ['release-status.json', 'web/release-status.json']) {
    const product = JSON.parse(read(file)).product;
    assert.equal(product.license, POLYFORM, file);
    assert.equal(product.sdkLicense, 'Apache-2.0', file);
  }
});

test('SPDX headers follow the split', () => {
  const source = (file) => /\.(?:[cm]?[jt]sx?|py|sql|go|sh|ya?ml)$/u.test(file);
  const clientSide = (file) => ['packages/', 'examples/', 'spec/examples/'].some((prefix) => file.startsWith(prefix));
  const wrong = tracked.filter((file) => source(file) && (clientSide(file)
    ? read(file).includes(spdx(POLYFORM))
    : read(file).includes(spdx('Apache-2.0'))));
  assert.deepEqual(wrong, []);
  assert.ok(tracked.some((file) => file.startsWith('apps/') && source(file) && read(file).includes(spdx(POLYFORM))));
  assert.ok(tracked.some((file) => file.startsWith('packages/') && source(file) && read(file).includes(spdx('Apache-2.0'))));
});

test('licensing documents state the split', () => {
  const scope = read('LICENSING.md');
  assert.match(scope, /## LICENSE-SCOPE/);
  assert.match(scope, /\| `packages\/`[^\n]*\| Apache-2\.0 \|/);
  assert.match(scope, /\| `examples\/` \| Apache-2\.0 \|/);
  assert.match(scope, /\| `apps\/`[^\n]*\| PolyForm-Noncommercial-1\.0\.0 \|/);
  const commercial = read('COMMERCIAL-LICENSE.md');
  assert.match(commercial, /SDKs and client packages in `packages\/`, and `examples\/` \| Apache License 2\.0, open source \| Free for any use, including commercial/);
  assert.match(commercial, /only self use is free/);
  for (const use of ['Internal use by a for-profit business', 'Hosting, SaaS', 'Resale', 'Consulting', 'hosted services']) {
    assert.ok(commercial.includes(use), use);
  }
  assert.match(commercial, /published\s+before 21 October 2026 remain available under the Apache License 2\.0 terms they\s+were released with/);
  assert.doesNotMatch(commercial, /revok/i, 'earlier Apache grants are not described as revoked');
  assert.match(read('TRADEMARKS.md'), /"Grantex" and "AgenticOrg", and their logos, are trademarks of Orchestrum\s+Technologies LLP/);
  assert.match(read('CONTRIBUTING.md'), /## Contribution licence[\s\S]*commercial licences/);
  const notice = read('NOTICE');
  assert.match(notice, /packages\/, and examples\/, are licensed under\s+the Apache License 2\.0/);
  assert.match(notice, /PolyForm Noncommercial License 1\.0\.0/);
});

test('README and package READMEs state the right licence', () => {
  const readme = read('README.md');
  const licence = readme.indexOf('\n## Licence\n');
  const next = readme.indexOf('\n## What is Grantex?\n');
  assert.ok(licence > 0 && licence < next);
  const section = readme.slice(licence, next);
  assert.match(section, /Apache License 2\.0\]\([^)]*\), open source \| Free for any use, including commercial/);
  assert.match(section, /PolyForm Noncommercial License 1\.0\.0\]\(LICENSE\)/);
  for (const name of packages) {
    const file = `packages/${name}/README.md`;
    if (!existsSync(new URL(file, root))) continue;
    const text = read(file);
    assert.match(text, /## License\n\nApache-2\.0 \(\[LICENSE\]/, file);
    assert.doesNotMatch(text, /## License\n\nPolyForm/, file);
  }
});

test('the documentation site lists the Licence page and the superseded draft is gone', () => {
  const docs = JSON.parse(read('docs/docs.json'));
  assert.ok(JSON.stringify(docs.navigation).includes('"license"'));
  const page = read('docs/license.mdx');
  assert.match(page, /title: "Licence"/);
  assert.match(page, /Apache License 2\.0\]/);
  assert.match(page, /PolyForm Noncommercial License 1\.0\.0\]/);
  assert.equal(existsSync(new URL('licensing/scope.json', root)), false);
});

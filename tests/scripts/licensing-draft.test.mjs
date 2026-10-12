// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');

test('licensing proposal is discoverable but not an active restriction on Apache releases', () => {
  const draft = read('docs/compliance/licensing.md');
  assert.match(draft, /Approved for policy publication; not adopted by a software release/);
  assert.match(draft, /No effective date or covered release has been approved/);
  assert.match(draft, /personal and internal use is free/);
  assert.match(draft, /commercializing the platform requires an agreement with Orchestrum Technologies LLP/);
  assert.match(draft, /Already-granted Apache-2.0 permissions remain in place/);
  assert.match(draft, /bank or merchant serving its own customers/);
  assert.match(draft, /Third-party dependencies retain their own licenses/);
  assert.match(draft, /source-available,[\s\S]*not an OSI-approved open-source license/);
  assert.match(draft, /copyright ownership and contributor agreements/);
  for (const file of ['README.md', 'LICENSING.md', 'docs/compliance/terms-of-service.md', 'docs/introduction.mdx']) {
    const text = read(file);
    assert.match(text, /software[\s\S]*adoption[\s\S]*pending|awaits software[\s\S]*release adoption/, file);
    assert.match(text, /mailto:sanjeev@orchestrum.in/, file);
  }
  const navigation = JSON.parse(read('docs/docs.json'));
  assert.match(JSON.stringify(navigation), /compliance\/licensing/);
  const html = read('web/index.html');
  const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
  assert.match(footer, /href="https:\/\/docs.grantex.dev\/compliance\/licensing">Usage &amp; licensing/);
  assert.match(footer, /blob\/main\/LICENSE">Current source license/);
  assert.match(read('LICENSE'), /Apache License/);
  assert.match(JSON.parse(read('packages/sdk-ts/package.json')).license, /^Apache-2.0$/);
});

test('the concrete license and scope record cannot masquerade as an adopted license', () => {
  const scope = JSON.parse(read('licensing/scope.json'));
  assert.equal(scope.schema_version, 1);
  assert.equal(scope.product, 'Grantex');
  assert.equal(scope.status, 'approved_for_publication');
  assert.equal(scope.licensor, 'Orchestrum Technologies LLP');
  assert.equal(scope.commercial_contact, 'sanjeev@orchestrum.in');
  assert.equal(scope.proposed_license_id, 'LicenseRef-Orchestrum-Self-Use-Commercial-1.0');
  assert.match(scope.reference_baseline_commit, /^[a-f0-9]{40}$/);
  assert.equal(scope.reference_baseline_is_cutoff, false);
  assert.deepEqual(scope.covered_files, []);
  for (const field of ['release_version', 'effective_date'])
    assert.equal(scope[field], null, field);
  assert.equal(scope.owner_approval_reference, 'owner-publication-approval-2026-10-12');
  assert.equal(scope.legal_review_reference, 'owner-attested-legal-review-2026-10-12');
  assert.equal(scope.publication_approved_on, '2026-10-12');
  assert.equal(scope.existing_grants_policy, 'preserve');
  assert.equal(scope.third_party_licenses_policy, 'retain_original');
  assert.match(scope.sdk_and_protocol_policy, /preserve_published_grants/);
  const candidate = read(scope.license_text);
  assert.match(candidate, /Approved for policy publication; not adopted by a software release/);
  assert.match(candidate, /An agreement signed by an authorized Orchestrum representative/);
  assert.match(candidate, /merchant[\s\S]*selling its own goods/);
  assert.match(candidate, /implementation or consulting services/);
  assert.match(candidate, /Previously[\s\S]*published grants remain available/);
  assert.match(candidate, /Termination under this license does not terminate an independent legacy/);
  assert.match(candidate, /No governing law, venue or effective date has been selected/);
  assert.match(read('docs/compliance/licensing.md'), /zero covered files/);
});

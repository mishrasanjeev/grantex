import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(
  TEST_DIR,
  '../../../docs/internal/commerce-v1/commerce-v1-c6x1-oacp-cache-verifier-runtime-planning.md',
);

function c6x1Doc() {
  return readFileSync(DOC_PATH, 'utf8');
}

describe('C6X1 OACP cache and verifier runtime planning', () => {
  it('documents the corrected ownership model and planned cache/verifier boundaries', () => {
    const doc = c6x1Doc();
    for (const heading of [
      'Scope',
      'Correct Ownership Model',
      'Planned Artifact Issuance Boundary',
      'Planned Verifier Runtime Boundary',
      'AgenticOrg Cache Contract',
      'Freshness, Revocation, And TTL Defaults',
      'Evidence References',
      'Non-Binding Versus Commitment-Bound Use',
      'Fail-Closed Rules',
      'Guardrails',
      'What This Does Not Enable',
      'Future Work',
    ]) {
      expect(doc).toContain(`## ${heading}`);
    }

    expect(doc).toContain('AgenticOrg remains the buyer and seller AI-agent runtime');
    expect(doc).toContain('Grantex remains the trust, protocol, policy, and canonical OACP artifact authority');
    expect(doc).toContain('Merchant systems remain operational sources of record');
    expect(doc).toContain('Provider and fintech rails own mandate and payment execution');
    expect(doc).toContain('Valid cached OACP artifacts may support non-binding interactions');
  });

  it('keeps C6X1 docs/tests/planning-first and non-enabling', () => {
    const doc = c6x1Doc();
    for (const requiredBoundary of [
      'docs/tests/planning-first only',
      'no runtime code',
      'no public endpoint',
      'no public OACP publication',
      'no checkout or payment enablement',
      'no live provider rail enablement',
      'no merchant private API execution',
      'no production config change',
      'no production allowlist assignment',
    ]) {
      expect(doc).toContain(requiredBoundary);
    }
  });

  it('requires freshness, revocation, evidence-reference, and fail-closed cache posture', () => {
    const doc = c6x1Doc();
    for (const requiredPosture of [
      'issued-at, received-at, and expires-at timestamps',
      'TTL and freshness status',
      'revocation snapshot reference and age',
      'non-sensitive evidence references',
      'blocked and unsupported capability wording',
      'fail closed for stale, expired, revoked, ambiguous, missing, mismatched, or unsafe artifacts',
      'adapter preview tries to override missing, expired, or revoked canonical artifacts',
    ]) {
      expect(doc).toContain(requiredPosture);
    }
  });

  it('does not reintroduce old all-through-Grantex or readiness wording', () => {
    const doc = c6x1Doc();
    for (const forbiddenPhrase of [
      ['Grantex is the transaction/control plane', 'for every interaction'].join(' '),
      ['all provider interaction happens', 'through Grantex'].join(' '),
      ['AgenticOrg only calls Grantex', 'for everything'].join(' '),
      ['merchant systems connect only', 'to Grantex'].join(' '),
      ['Grantex owns payment', 'mandate setup'].join(' '),
      ['OACP is', 'public'].join(' '),
      ['OACP is', 'standard'].join(' '),
      ['OACP is', 'cert' + 'ified'].join(' '),
      ['production', 'ready'].join(' '),
      ['execution', 'ready'].join(' '),
    ]) {
      expect(doc).not.toContain(forbiddenPhrase);
    }
  });
});

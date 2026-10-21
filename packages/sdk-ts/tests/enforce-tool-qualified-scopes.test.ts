// SPDX-License-Identifier: Apache-2.0
/**
 * enforce() honours the tool segment of a scope with `toolQualifiedScopes: true`
 * (FINDINGS G-144). The cases in spec/examples/enforce-tool-qualified-scopes.json
 * are shared with the Python SDK.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ToolManifest } from '../src/manifest.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn(actual.verifyGrantToken) };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

interface ScopeCase {
  name: string;
  scopes: string[];
  tool: string;
  required: 'read' | 'write' | 'delete' | 'admin';
  option: boolean;
  expect: string;
}

const CASES = (JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'enforce-tool-qualified-scopes.json'),
  'utf8',
)) as { cases: ScopeCase[] }).cases;

function grant(scopes: string[]): VerifiedGrant {
  return {
    tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'shopper-01', agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01', scopes, issuedAt: 1709000000, expiresAt: 9999999999,
  };
}

function outcome(result: { allowed: boolean; reasonCode?: string; subReason?: string }): string {
  if (result.allowed) return 'allow';
  return `${result.reasonCode ?? ''}/${result.subReason ?? ''}`;
}

describe('shared tool-qualified scope cases', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    vi.mocked(verifyGrantToken).mockResolvedValueOnce(grant(c.scopes));
    const client = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', audienceCheck: 'off', toolQualifiedScopes: c.option });
    client.loadManifest(new ToolManifest({ connector: 'acme_kyb', tools: { [c.tool]: c.required } }));
    const result = await client.enforce({ grantToken: 't', connector: 'acme_kyb', tool: c.tool });
    expect(outcome(result)).toBe(c.expect);
    if (c.expect.endsWith('tool_scope_missing')) {
      expect(result.details?.['tool_scopes']).toEqual(
        [...new Set(c.scopes.filter((s) => s.includes('acme_kyb')).map((s) => s.split(':')[3]).filter((t): t is string => !!t))].sort(),
      );
    }
  });

  it('is off by default and refuses a non-boolean', () => {
    expect(() => new Grantex({ apiKey: 'k', toolQualifiedScopes: 'yes' as unknown as boolean })).toThrow('toolQualifiedScopes must be a boolean');
  });
});

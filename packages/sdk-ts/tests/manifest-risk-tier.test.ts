// SPDX-License-Identifier: Apache-2.0
/**
 * `risk_tier` on tool manifests: a `high` tool needs a decision grant on every
 * call, whether or not the manifest also declares `requires_decision`.
 */
import { describe, expect, it, vi } from 'vitest';
import { DenialReason } from '../src/denials.js';
import { ToolManifest, parseToolDeclaration, toolSpecToObject } from '../src/manifest.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn(actual.verifyGrantToken) };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

const GRANT: VerifiedGrant = {
  tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'shopper-01', agentDid: 'did:grantex:ag_01',
  developerId: 'dev_01', scopes: ['tool:acme_kyb:write'], issuedAt: 1709000000, expiresAt: 9999999999,
};

describe('risk_tier', () => {
  it('parses, round-trips and rejects bad values', () => {
    const spec = parseToolDeclaration('close_case', { permission: 'write', risk_tier: 'high' });
    expect(spec.riskTier).toBe('high');
    expect(spec.requiresDecision).toBe(false);
    expect(toolSpecToObject(spec)).toEqual({ permission: 'write', risk_tier: 'high' });
    expect(parseToolDeclaration('get_case', { permission: 'read', risk_tier: 'medium' }).riskTier).toBe('medium');
    expect(() => parseToolDeclaration('get_case', { permission: 'read', risk_tier: 'high' }))
      .toThrow('tools.get_case: risk_tier high is not allowed on a tool with read permission');
    expect(() => parseToolDeclaration('close_case', { permission: 'write', risk_tier: 'critical' }))
      .toThrow('tools.close_case.risk_tier: must be one of low, medium, high');
  });

  it('a high-risk tool needs a decision grant', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValueOnce(GRANT);
    const client = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', audienceCheck: 'off' });
    client.loadManifest(new ToolManifest({ connector: 'acme_kyb', tools: { close_case: { permission: 'write', risk_tier: 'high' } } }));
    const result = await client.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'close_case' });
    expect([result.allowed, result.reasonCode]).toEqual([false, DenialReason.DECISION_REQUIRED]);
  });

  it('a medium-risk tool does not', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValueOnce(GRANT);
    const client = new Grantex({ apiKey: 'test-key', revocationCheck: 'offline', audienceCheck: 'off' });
    client.loadManifest(new ToolManifest({ connector: 'acme_kyb', tools: { close_case: { permission: 'write', risk_tier: 'medium' } } }));
    const result = await client.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'close_case' });
    expect(result.allowed).toBe(true);
  });
});

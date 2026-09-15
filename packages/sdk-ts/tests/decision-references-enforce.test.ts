/**
 * enforce() treats a tool listed in the grant's decision references
 * (urn:grantex:decision:v1) as needing a decision grant, even when the
 * manifest does not declare requires_decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolManifest } from '../src/manifest.js';
import { DenialReason, TokenSubReason } from '../src/denials.js';
import type { VerifiedGrant } from '../src/types.js';

vi.mock('../src/verify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/verify.js')>();
  return { ...actual, verifyGrantToken: vi.fn() };
});

const { verifyGrantToken } = await import('../src/verify.js');
const { Grantex } = await import('../src/client.js');

const manifest = ToolManifest.fromJSON({
  connector: 'acme_kyb',
  tools: { case_decision: 'write', get_case: 'read' },
});

function grant(authorizationDetails: unknown): VerifiedGrant {
  return {
    tokenId: 'tok_01', grantId: 'grnt_01', principalId: 'user_01', agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01', scopes: ['tool:acme_kyb:write'], issuedAt: 1709000000, expiresAt: 9999999999,
    authorizationDetails,
  };
}

async function enforce(g: VerifiedGrant, tool: string) {
  vi.mocked(verifyGrantToken).mockResolvedValue(g);
  const client = new Grantex({ apiKey: 'test-key' });
  client.loadManifest(manifest);
  return client.enforce({ grantToken: 't', connector: 'acme_kyb', tool });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('enforce() and grant decision references', () => {
  const details = [{ type: 'urn:grantex:decision:v1', connector: 'acme_kyb', tools: ['case_decision'] }];

  it('denies a tool the grant says needs a decision with decision_required', async () => {
    const result = await enforce(grant(details), 'case_decision');
    expect([result.allowed, result.reasonCode]).toEqual([false, DenialReason.DECISION_REQUIRED]);
  });

  it('allows other tools on the connector', async () => {
    expect((await enforce(grant(details), 'get_case')).allowed).toBe(true);
  });

  it('denies every call when a decision reference is malformed', async () => {
    const result = await enforce(grant([{ type: 'urn:grantex:decision:v1', connector: 'acme_kyb', tools: 'case_decision' }]), 'get_case');
    expect([result.allowed, result.reasonCode, result.subReason]).toEqual([
      false, DenialReason.TOKEN_INVALID, TokenSubReason.MALFORMED_AUTHORIZATION_DETAILS,
    ]);
  });

  it('passes legacyClaims from the client options to the verifier only when set', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(grant(undefined));
    const client = new Grantex({ apiKey: 'test-key', legacyClaims: false });
    client.loadManifest(manifest);
    await client.enforce({ grantToken: 't', connector: 'acme_kyb', tool: 'get_case' });
    expect(verifyGrantToken).toHaveBeenCalledWith('t', expect.objectContaining({ legacyClaims: false }));
  });
});

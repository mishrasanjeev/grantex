import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { verifyGrantToken, type Grantex, type VerifiedGrant } from '@grantex/sdk';
import { createGrantexTool, withAuditLogging } from '../src/index.js';

vi.mock('@grantex/sdk', () => ({ verifyGrantToken: vi.fn() }));

const grant: VerifiedGrant = {
  tokenId: 'tok_fixture', grantId: 'grnt_fixture', principalId: 'user_fixture',
  agentDid: 'did:grantex:ag_fixture', developerId: 'dev_fixture',
  scopes: ['data:read'], issuedAt: 1, expiresAt: 9999999999,
};

function fixture(input = { item: 'synthetic' } as Record<string, unknown>) {
  const execute = vi.fn(async ({ item }: { item: string }) => ({ item }));
  const log = vi.fn().mockResolvedValue(undefined);
  const tool = withAuditLogging(createGrantexTool({
    name: 'read_fixture', description: 'Read a synthetic fixture.',
    parameters: z.object({ item: z.string() }), grantToken: 'synthetic-not-a-grant',
    requiredScope: 'data:read', execute,
  }), { audit: { log } } as unknown as Grantex, {
    agentId: 'ag_fixture', agentDid: grant.agentDid,
    grantId: grant.grantId, principalId: grant.principalId,
  });
  const model = new MockLanguageModelV4({ doGenerate: {
    content: [{ type: 'tool-call', toolCallId: 'call_fixture',
      toolName: 'read_fixture', input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    }, warnings: [],
  } });
  return { execute, log, model,
    run: () => generateText({ model, tools: { read_fixture: tool },
      prompt: 'Read the synthetic fixture.', maxRetries: 0 }) };
}

describe('real AI SDK tool contract', () => {
  beforeEach(() => {
    vi.mocked(verifyGrantToken).mockReset().mockResolvedValue(grant);
  });

  it('parses model arguments, executes the scoped tool and records its audit result', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].output).toEqual({ item: 'synthetic' });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tool:read_fixture', status: 'success',
    }));
    expect(f.model.doGenerateCalls[0].tools?.[0]).toMatchObject({
      name: 'read_fixture', inputSchema: { type: 'object' },
    });
  });

  it.each(['scope', 'authority'] as const)('does not execute after %s denial', async (reason) => {
    if (reason === 'scope') {
      vi.mocked(verifyGrantToken).mockResolvedValue({ ...grant, scopes: [] });
    } else {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('fixture authority refused'));
    }
    const f = fixture();
    const result = await f.run();
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-error', toolName: 'read_fixture' }),
    ]));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'failure' }));
  });

  it('rejects invalid model arguments before authority checks or side effects', async () => {
    const f = fixture({ item: 42 });
    const result = await f.run();
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-error', toolName: 'read_fixture' }),
    ]));
    expect(verifyGrantToken).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });
});

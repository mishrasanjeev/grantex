import { describe, it, expect, vi } from 'vitest';
import { withAuditLogging } from '../src/audit.js';
import type { GrantexTool } from '../src/types.js';
import type { Grantex } from '@grantex/sdk';

/** Minimal Grantex client stub -- only needs audit.log */
function makeClient(): Grantex {
  return {
    audit: {
      log: vi.fn().mockResolvedValue({ entryId: 'entry_01' }),
    },
  } as unknown as Grantex;
}

/** Minimal GrantexTool stub */
function makeTool(name: string, impl: () => Promise<unknown>): GrantexTool<Record<string, unknown>> {
  return {
    definition: {
      name,
      description: 'test tool',
      input_schema: { type: 'object' },
    },
    execute: vi.fn().mockImplementation(impl),
  };
}

describe('withAuditLogging', () => {
  it('logs a success entry when execute resolves', async () => {
    const client = makeClient();
    const tool = makeTool('read_file', async () => 'file contents');
    const audited = withAuditLogging(tool, client, { agentId: 'agent_1', agentDid: 'did:grantex:agent_1', grantId: 'grnt_1', principalId: 'user_1' });

    const result = await audited.execute({ path: '/tmp/test.txt' });

    expect(result).toBe('file contents');
    expect(client.audit.log).toHaveBeenCalledOnce();
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_1',
        grantId: 'grnt_1',
        action: 'tool:read_file',
        status: 'success',
      }),
    );
  });

  it('logs a failure entry and re-throws when execute rejects', async () => {
    const client = makeClient();
    const tool = makeTool('read_file', async () => {
      throw new Error('file not found');
    });
    const audited = withAuditLogging(tool, client, { agentId: 'agent_1', agentDid: 'did:grantex:agent_1', grantId: 'grnt_1', principalId: 'user_1' });

    await expect(audited.execute({})).rejects.toThrow('file not found');
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool:read_file',
        status: 'failure',
        metadata: expect.objectContaining({ error: 'file not found' }),
      }),
    );
  });

  it('preserves the original definition unchanged', () => {
    const client = makeClient();
    const tool = makeTool('my_tool', async () => null);
    const audited = withAuditLogging(tool, client, { agentId: 'a', agentDid: 'did:grantex:a', grantId: 'g', principalId: 'u' });

    expect(audited.definition).toBe(tool.definition);
  });

  it('passes args through to the underlying tool', async () => {
    const client = makeClient();
    const tool = makeTool('my_tool', async () => 'done');
    const audited = withAuditLogging(tool, client, { agentId: 'a', agentDid: 'did:grantex:a', grantId: 'g', principalId: 'u' });
    const args = { x: 1, y: 2 };

    await audited.execute(args);

    expect(tool.execute).toHaveBeenCalledWith(args);
  });

  it('includes args in audit metadata on success', async () => {
    const client = makeClient();
    const tool = makeTool('search', async () => []);
    const audited = withAuditLogging(tool, client, { agentId: 'a', agentDid: 'did:grantex:a', grantId: 'g', principalId: 'u' });

    await audited.execute({ query: 'test' });

    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { args: { query: 'test' } },
      }),
    );
  });
});

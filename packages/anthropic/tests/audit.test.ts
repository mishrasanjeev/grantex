import { describe, it, expect, vi } from 'vitest';
import { withAuditLogging, handleToolCall } from '../src/audit.js';
import type { GrantexTool, AnthropicToolUseBlock } from '../src/types.js';
import type { Grantex } from '@grantex/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

const AUDIT_OPTS = {
  agentId: 'agent_1',
  agentDid: 'did:key:z6Mk_agent1',
  grantId: 'grnt_1',
  principalId: 'user_1',
};

function makeClient(): Grantex {
  return {
    audit: {
      log: vi.fn().mockResolvedValue({ entryId: 'entry_01' }),
    },
  } as unknown as Grantex;
}

function makeTool(
  name: string,
  impl: (args: Record<string, unknown>) => Promise<unknown>,
): GrantexTool<Record<string, unknown>> {
  return {
    definition: {
      name,
      description: `test tool: ${name}`,
      input_schema: { type: 'object' as const },
    },
    execute: vi.fn().mockImplementation(impl),
  };
}

function makeBlock(name: string, input: Record<string, unknown> = {}): AnthropicToolUseBlock {
  return { type: 'tool_use', id: 'toolu_01', name, input };
}

// ─── withAuditLogging ─────────────────────────────────────────────────────────

describe('withAuditLogging', () => {
  it('logs a success entry when execute resolves', async () => {
    const client = makeClient();
    const tool = makeTool('fetch_data', async () => ({ rows: 3 }));
    const audited = withAuditLogging(tool, client, AUDIT_OPTS);

    const result = await audited.execute({ q: 'test' });

    expect(result).toEqual({ rows: 3 });
    expect(client.audit.log).toHaveBeenCalledOnce();
    expect(client.audit.log).toHaveBeenCalledWith({
      agentId: 'agent_1',
      agentDid: 'did:key:z6Mk_agent1',
      grantId: 'grnt_1',
      principalId: 'user_1',
      action: 'tool:fetch_data',
      metadata: { args: { q: 'test' } },
      status: 'success',
    });
  });

  it('logs a failure entry and re-throws when execute rejects', async () => {
    const client = makeClient();
    const tool = makeTool('fetch_data', async () => {
      throw new Error('database offline');
    });
    const audited = withAuditLogging(tool, client, AUDIT_OPTS);

    await expect(audited.execute({})).rejects.toThrow('database offline');
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool:fetch_data',
        status: 'failure',
        metadata: expect.objectContaining({ error: 'database offline' }),
      }),
    );
  });

  it('preserves the original definition unchanged', () => {
    const client = makeClient();
    const tool = makeTool('my_tool', async () => null);
    const audited = withAuditLogging(tool, client, AUDIT_OPTS);

    expect(audited.definition).toBe(tool.definition);
  });

  it('passes args through to the underlying tool', async () => {
    const client = makeClient();
    const tool = makeTool('my_tool', async () => 'done');
    const audited = withAuditLogging(tool, client, AUDIT_OPTS);
    const args = { x: 1, y: 2 };

    await audited.execute(args);

    expect(tool.execute).toHaveBeenCalledWith(args);
  });
});

// ─── handleToolCall ───────────────────────────────────────────────────────────

describe('handleToolCall', () => {
  it('executes the tool and logs success', async () => {
    const client = makeClient();
    const tool = makeTool('read_file', async () => 'file contents');
    const block = makeBlock('read_file', { path: '/tmp/x' });

    const result = await handleToolCall(tool, block, client, AUDIT_OPTS);

    expect(result).toBe('file contents');
    expect(client.audit.log).toHaveBeenCalledWith({
      agentId: 'agent_1',
      agentDid: 'did:key:z6Mk_agent1',
      grantId: 'grnt_1',
      principalId: 'user_1',
      action: 'tool:read_file',
      metadata: { args: { path: '/tmp/x' } },
      status: 'success',
    });
  });

  it('logs failure and re-throws when tool errors', async () => {
    const client = makeClient();
    const tool = makeTool('read_file', async () => {
      throw new Error('permission denied');
    });
    const block = makeBlock('read_file', { path: '/etc/shadow' });

    await expect(
      handleToolCall(tool, block, client, AUDIT_OPTS),
    ).rejects.toThrow('permission denied');

    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tool:read_file',
        status: 'failure',
        metadata: expect.objectContaining({ error: 'permission denied' }),
      }),
    );
  });

  it('uses block.name for the audit action', async () => {
    const client = makeClient();
    const tool = makeTool('write_file', async () => 'ok');
    const block = makeBlock('write_file', { content: 'hello' });

    await handleToolCall(tool, block, client, AUDIT_OPTS);

    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tool:write_file' }),
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import { withAuditLogging } from '../src/audit.js';
import type { GrantexFunction } from '../src/types.js';
import type { Grantex } from '@grantex/sdk';

// Minimal Grantex client stub — only needs audit.log
function makeClient(): Grantex {
  return {
    audit: {
      log: vi.fn().mockResolvedValue({ entryId: 'entry_01' }),
    },
  } as unknown as Grantex;
}

// Minimal GrantexFunction stub
function makeFn(name: string, impl: () => Promise<unknown>): GrantexFunction<Record<string, unknown>> {
  return {
    definition: {
      type: 'function',
      function: { name, description: 'test fn', parameters: { type: 'object' } },
    },
    execute: vi.fn().mockImplementation(impl),
  };
}

describe('withAuditLogging', () => {
  it('logs a success entry when execute resolves', async () => {
    const client = makeClient();
    const fn = makeFn('fetch_data', async () => ({ rows: 3 }));
    const audited = withAuditLogging(fn, client, { agentId: 'agent_1', grantId: 'grnt_1' });

    const result = await audited.execute({ q: 'test' });

    expect(result).toEqual({ rows: 3 });
    expect(client.audit.log).toHaveBeenCalledOnce();
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent_1',
        grantId: 'grnt_1',
        action: 'function:fetch_data',
        status: 'success',
      }),
    );
  });

  it('logs a failure entry and re-throws when execute rejects', async () => {
    const client = makeClient();
    const fn = makeFn('fetch_data', async () => {
      throw new Error('database offline');
    });
    const audited = withAuditLogging(fn, client, { agentId: 'agent_1', grantId: 'grnt_1' });

    await expect(audited.execute({})).rejects.toThrow('database offline');
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'function:fetch_data',
        status: 'failure',
        metadata: expect.objectContaining({ error: 'database offline' }),
      }),
    );
  });

  it('preserves the original definition unchanged', () => {
    const client = makeClient();
    const fn = makeFn('my_fn', async () => null);
    const audited = withAuditLogging(fn, client, { agentId: 'a', grantId: 'g' });

    expect(audited.definition).toBe(fn.definition);
  });

  it('passes args through to the underlying function', async () => {
    const client = makeClient();
    const fn = makeFn('my_fn', async () => 'done');
    const audited = withAuditLogging(fn, client, { agentId: 'a', grantId: 'g' });
    const args = { x: 1, y: 2 };

    await audited.execute(args);

    expect(fn.execute).toHaveBeenCalledWith(args);
  });
});

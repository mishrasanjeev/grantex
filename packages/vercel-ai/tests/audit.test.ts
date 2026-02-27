import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Grantex } from '@grantex/sdk';

vi.mock('ai', () => ({
  zodSchema: (schema: unknown) => schema,
}));

import { createGrantexTool } from '../src/tool.js';
import { withAuditLogging } from '../src/audit.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeToken(scopes: string[]): string {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({ scp: scopes, jti: 'tok_01', exp: 9999999999 });
  return `${header}.${payload}.fakesig`;
}

const TOKEN = makeToken(['data:read']);
const PARAMS = z.object({ item: z.string() });
const EXEC_OPTIONS = { toolCallId: 'tc_01', messages: [] as never[] };

function makeClient() {
  return {
    audit: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Grantex;
}

function baseTool(execute: (args: { item: string }) => Promise<string>) {
  return createGrantexTool({
    name: 'test_tool',
    description: 'A test tool.',
    parameters: PARAMS,
    grantToken: TOKEN,
    requiredScope: 'data:read',
    execute,
  });
}

// ─── withAuditLogging ─────────────────────────────────────────────────────────

describe('withAuditLogging', () => {
  it('calls execute and logs success', async () => {
    const client = makeClient();
    const t = withAuditLogging(baseTool(async ({ item }) => `done:${item}`), client, {
      agentId: 'ag_01',
      grantId: 'grnt_01',
    });

    const result = await t.execute({ item: 'widget' }, EXEC_OPTIONS);

    expect(result).toBe('done:widget');
    expect(client.audit.log).toHaveBeenCalledOnce();
    expect(client.audit.log).toHaveBeenCalledWith({
      agentId: 'ag_01',
      grantId: 'grnt_01',
      action: 'tool:test_tool',
      metadata: { args: { item: 'widget' } },
      status: 'success',
    });
  });

  it('logs failure and re-throws on error', async () => {
    const client = makeClient();
    const t = withAuditLogging(
      baseTool(async () => {
        throw new Error('something broke');
      }),
      client,
      { agentId: 'ag_01', grantId: 'grnt_01' },
    );

    await expect(t.execute({ item: 'widget' }, EXEC_OPTIONS)).rejects.toThrow(
      'something broke',
    );
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failure',
        metadata: expect.objectContaining({ error: 'something broke' }),
      }),
    );
  });

  it('uses toolName override when provided', async () => {
    const client = makeClient();
    const t = withAuditLogging(
      baseTool(async () => 'ok'),
      client,
      { agentId: 'ag_01', grantId: 'grnt_01', toolName: 'custom_name' },
    );

    await t.execute({ item: 'x' }, EXEC_OPTIONS);
    expect(client.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tool:custom_name' }),
    );
  });

  it('preserves description and parameters on the wrapped tool', () => {
    const client = makeClient();
    const original = baseTool(async () => 'ok');
    const wrapped = withAuditLogging(original, client, {
      agentId: 'ag_01',
      grantId: 'grnt_01',
    });

    expect(wrapped.description).toBe(original.description);
    expect(wrapped.inputSchema).toBe(original.inputSchema);
  });

  it('does not log when scope check fails at construction', () => {
    const client = makeClient();
    expect(() =>
      createGrantexTool({
        name: 'restricted',
        description: 'restricted',
        parameters: PARAMS,
        grantToken: makeToken([]),
        requiredScope: 'data:read',
        execute: async () => 'ok',
      }),
    ).toThrow();
    expect(client.audit.log).not.toHaveBeenCalled();
  });
});

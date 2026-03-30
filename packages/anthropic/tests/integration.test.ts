/**
 * Integration tests — exercises the full developer workflow:
 *   1. Create tools with realistic JWTs
 *   2. Register tools in a registry
 *   3. Execute via registry dispatch (simulating tool_use blocks)
 *   4. Audit logging with mock client
 *   5. handleToolCall convenience flow
 *   6. GrantexScopeError instanceof checks
 *   7. getGrantScopes on realistic tokens
 *
 * Uses realistic Grantex JWT claim structures (not minimal fakes).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createGrantexTool,
  getGrantScopes,
  handleToolCall,
  withAuditLogging,
  GrantexToolRegistry,
  GrantexScopeError,
} from '../src/index.js';
import type { Grantex } from '@grantex/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a realistic Grantex JWT with full claim structure. */
function makeRealisticToken(overrides: Record<string, unknown> = {}): string {
  const header = { alg: 'RS256', kid: 'grantex-2026-03' };
  const payload = {
    iss: 'https://grantex.dev',
    sub: 'user_abc123',
    agt: 'did:grantex:ag_tool_demo',
    dev: 'dev_xyz789',
    scp: ['file:read', 'file:write', 'calendar:read'],
    jti: 'tok_integration_01',
    grnt: 'grnt_integration_01',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };

  const b64Header = Buffer.from(JSON.stringify(header))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const b64Payload = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Realistic-length fake signature (RS256 signatures are ~342 base64url chars)
  const fakeSig = 'a'.repeat(342);
  return `${b64Header}.${b64Payload}.${fakeSig}`;
}

function makeClient(): { client: Grantex; logCalls: unknown[] } {
  const logCalls: unknown[] = [];
  const client = {
    audit: {
      log: vi.fn().mockImplementation(async (params: unknown) => {
        logCalls.push(params);
        return { entryId: `entry_${logCalls.length}` };
      }),
    },
  } as unknown as Grantex;
  return { client, logCalls };
}

// ─── Full developer workflow ─────────────────────────────────────────────────

describe('Integration: full developer workflow', () => {
  const GRANT_TOKEN = makeRealisticToken();
  const AUDIT_OPTS = {
    agentId: 'ag_tool_demo',
    agentDid: 'did:grantex:ag_tool_demo',
    grantId: 'grnt_integration_01',
    principalId: 'user_abc123',
  };

  it('end-to-end: create → register → execute → audit', async () => {
    // Step 1: Create tools
    const readFile = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
      grantToken: GRANT_TOKEN,
      requiredScope: 'file:read',
      execute: async (args) => ({ content: `Contents of ${args['path']}`, bytes: 1024 }),
    });

    const writeFile = createGrantexTool({
      name: 'write_file',
      description: 'Write content to a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      grantToken: GRANT_TOKEN,
      requiredScope: 'file:write',
      execute: async (args) => ({ written: true, path: args['path'] }),
    });

    // Step 2: Register in registry
    const registry = new GrantexToolRegistry();
    registry.register(readFile).register(writeFile);

    // Verify definitions are Anthropic-compatible
    expect(registry.definitions).toHaveLength(2);
    for (const def of registry.definitions) {
      expect(def).toHaveProperty('name');
      expect(def).toHaveProperty('input_schema');
      expect(def.input_schema.type).toBe('object');
    }

    // Step 3: Simulate Anthropic response — dispatch tool_use blocks
    const readResult = await registry.execute({
      type: 'tool_use',
      id: 'toolu_01abc',
      name: 'read_file',
      input: { path: '/config.json' },
    });
    expect(readResult).toEqual({ content: 'Contents of /config.json', bytes: 1024 });

    const writeResult = await registry.execute({
      type: 'tool_use',
      id: 'toolu_02def',
      name: 'write_file',
      input: { path: '/output.txt', content: 'hello' },
    });
    expect(writeResult).toEqual({ written: true, path: '/output.txt' });

    // Step 4: Audit logging with handleToolCall
    const { client, logCalls } = makeClient();
    const auditedResult = await handleToolCall(
      readFile,
      { type: 'tool_use', id: 'toolu_03ghi', name: 'read_file', input: { path: '/secret.txt' } },
      client,
      AUDIT_OPTS,
    );

    expect(auditedResult).toEqual({ content: 'Contents of /secret.txt', bytes: 1024 });
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      agentId: 'ag_tool_demo',
      agentDid: 'did:grantex:ag_tool_demo',
      grantId: 'grnt_integration_01',
      principalId: 'user_abc123',
      action: 'tool:read_file',
      status: 'success',
    });
  });

  it('scope enforcement blocks unauthorized tools', async () => {
    const deleteTool = createGrantexTool({
      name: 'delete_file',
      description: 'Delete a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      grantToken: GRANT_TOKEN,
      requiredScope: 'file:delete', // NOT in the token's scp
      execute: async () => ({ deleted: true }),
    });

    // Execute should throw GrantexScopeError
    try {
      await deleteTool.execute({ path: '/important.txt' });
      expect.unreachable('should have thrown');
    } catch (err) {
      // instanceof MUST work (critical for developer error handling)
      expect(err).toBeInstanceOf(GrantexScopeError);
      expect(err).toBeInstanceOf(Error);

      const scopeErr = err as GrantexScopeError;
      expect(scopeErr.requiredScope).toBe('file:delete');
      expect(scopeErr.grantedScopes).toEqual(['file:read', 'file:write', 'calendar:read']);
      expect(scopeErr.name).toBe('GrantexScopeError');
      expect(scopeErr.message).toContain('file:delete');
      expect(scopeErr.message).toContain('file:read');
    }
  });

  it('withAuditLogging logs failure and preserves error', async () => {
    const failingTool = createGrantexTool({
      name: 'crash_tool',
      description: 'Always fails',
      inputSchema: { type: 'object' },
      grantToken: GRANT_TOKEN,
      requiredScope: 'file:read',
      execute: async () => {
        throw new Error('disk full');
      },
    });

    const { client, logCalls } = makeClient();
    const audited = withAuditLogging(failingTool, client, AUDIT_OPTS);

    await expect(audited.execute({})).rejects.toThrow('disk full');

    // Failure should be logged with error details
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      action: 'tool:crash_tool',
      status: 'failure',
      metadata: { error: 'disk full' },
    });
  });

  it('getGrantScopes reads realistic token correctly', () => {
    const scopes = getGrantScopes(GRANT_TOKEN);
    expect(scopes).toEqual(['file:read', 'file:write', 'calendar:read']);
  });

  it('handles delegation tokens with extra claims', () => {
    const delegationToken = makeRealisticToken({
      scp: ['read'],
      parentAgt: 'did:grantex:ag_parent',
      parentGrnt: 'grnt_parent',
      delegationDepth: 1,
    });

    const scopes = getGrantScopes(delegationToken);
    expect(scopes).toEqual(['read']);
  });

  it('handles token with budget claim', () => {
    const budgetToken = makeRealisticToken({
      scp: ['spend:usd'],
      bdg: 50.0,
    });

    const scopes = getGrantScopes(budgetToken);
    expect(scopes).toEqual(['spend:usd']);
  });

  it('handles token with empty scopes', () => {
    const emptyToken = makeRealisticToken({ scp: [] });
    expect(getGrantScopes(emptyToken)).toEqual([]);

    const tool = createGrantexTool({
      name: 'any_tool',
      description: 'test',
      inputSchema: { type: 'object' },
      grantToken: emptyToken,
      requiredScope: 'anything',
      execute: vi.fn(),
    });

    expect(tool.execute({})).rejects.toThrow(GrantexScopeError);
  });

  it('registry rejects unknown tool names with clear error', async () => {
    const registry = new GrantexToolRegistry();
    const tool = createGrantexTool({
      name: 'known_tool',
      description: 'test',
      inputSchema: { type: 'object' },
      grantToken: GRANT_TOKEN,
      requiredScope: 'file:read',
      execute: async () => 'ok',
    });
    registry.register(tool);

    await expect(
      registry.execute({
        type: 'tool_use',
        id: 'toolu_bad',
        name: 'hallucinated_tool',
        input: {},
      }),
    ).rejects.toThrow("no tool registered with name 'hallucinated_tool'");
  });
});

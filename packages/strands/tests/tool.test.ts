import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('@strands-agents/sdk', () => ({
  tool: vi.fn((config) => ({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    async invoke(input: unknown, context?: unknown): Promise<unknown> {
      return config.callback(input, context);
    },
  })),
}));

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken, type EnforceResult, type VerifiedGrant } from '@grantex/sdk';
import { createGrantexTool, getGrantScopes } from '../src/tool.js';
import { GrantexScopeError, type GrantexEnforcer } from '../src/types.js';

function makeToken(scopes: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://api.grantex.dev',
      sub: 'user_01',
      scp: scopes,
      jti: 'tok_01',
      grnt: 'grnt_01',
      agt: 'did:grantex:ag_TEST',
      dev: 'dev_TEST',
      iat: 1,
      exp: 9999999999,
    }),
  ).toString('base64url');
  return `${header}.${payload}.fakesig`;
}

function makeGrant(scopes: string[]): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_TEST',
    developerId: 'dev_TEST',
    scopes,
    issuedAt: 1,
    expiresAt: 9999999999,
  };
}

function makeEnforceResult(overrides: Partial<EnforceResult>): EnforceResult {
  return {
    allowed: true,
    reason: '',
    grantId: 'grnt_01',
    agentDid: 'did:grantex:ag_TEST',
    scopes: ['calendar:read'],
    permission: 'read',
    connector: 'calendar',
    tool: 'read_calendar',
    ...overrides,
  };
}

const INPUT = z.object({ date: z.string() });
const TOKEN_WITH_READ = makeToken(['calendar:read', 'profile:read']);

describe('createGrantexTool', () => {
  beforeEach(() => {
    vi.mocked(verifyGrantToken).mockReset();
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant(['calendar:read', 'profile:read']));
  });

  it('returns a Strands-compatible tool', () => {
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      callback: async ({ date }) => `events:${date}`,
    });

    expect(strandsTool.name).toBe('read_calendar');
    expect(strandsTool.description).toBe('Read calendar events');
    expect((strandsTool as unknown as { inputSchema: unknown }).inputSchema).toBe(INPUT);
  });

  it('verifies the grant and invokes the callback when the scope is present', async () => {
    const callback = vi.fn().mockResolvedValue('events');
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      callback,
    });

    const result = await strandsTool.invoke({ date: '2026-06-20' });

    expect(result).toBe('events');
    expect(callback).toHaveBeenCalledWith({ date: '2026-06-20' }, undefined);
    expect(verifyGrantToken).toHaveBeenCalledWith(TOKEN_WITH_READ, {
      jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
    });
  });

  it('throws GrantexScopeError before invoking the callback when the scope is missing', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant(['profile:read']));
    const callback = vi.fn();
    const strandsTool = createGrantexTool({
      name: 'send_email',
      description: 'Send email',
      inputSchema: INPUT,
      grantToken: makeToken(['profile:read']),
      requiredScope: 'email:send',
      callback,
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).rejects.toThrow(GrantexScopeError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('passes verification options to the core SDK', async () => {
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      issuer: 'https://issuer.example',
      audience: 'agent-runtime',
      clockTolerance: 30,
      callback: async () => 'events',
    });

    await strandsTool.invoke({ date: '2026-06-20' });

    expect(verifyGrantToken).toHaveBeenCalledWith(TOKEN_WITH_READ, {
      jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
      issuer: 'https://issuer.example',
      audience: 'agent-runtime',
      clockTolerance: 30,
    });
  });

  it('uses client.enforce in online mode', async () => {
    const client: GrantexEnforcer = {
      enforce: vi.fn().mockResolvedValue(makeEnforceResult({ allowed: true })),
    };
    const callback = vi.fn().mockResolvedValue('events');
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      client,
      connector: 'calendar',
      online: true,
      callback,
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).resolves.toBe('events');
    expect(client.enforce).toHaveBeenCalledWith({
      grantToken: TOKEN_WITH_READ,
      connector: 'calendar',
      tool: 'read_calendar',
    });
    expect(verifyGrantToken).not.toHaveBeenCalled();
  });

  it.each(['false', 'true', 1])('rejects non-boolean online authorization %j', async (allowed) => {
    const client: GrantexEnforcer = { enforce: vi.fn().mockResolvedValue({ ...makeEnforceResult({}), allowed }) };
    const callback = vi.fn();
    const tool = createGrantexTool({ name: 'read_calendar', description: 'Read', inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ, requiredScope: 'calendar:read', client, connector: 'calendar', online: true, callback });
    await expect(tool.invoke({ date: '2026-06-20' })).rejects.toThrow(GrantexScopeError);
    expect(callback).not.toHaveBeenCalled();
  });

  it('checks bound identity before online enforcement or execution', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('wrong authenticated human'));
    const client: GrantexEnforcer = { enforce: vi.fn().mockResolvedValue(makeEnforceResult({})) };
    const callback = vi.fn();
    const tool = createGrantexTool({ name: 'read_calendar', description: 'Read', inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ, requiredScope: 'calendar:read', client, connector: 'calendar', online: true,
      expectedPrincipalId: 'another-human', callback });
    expect(client.enforce).not.toHaveBeenCalled();
    await expect(tool.invoke({ date: '2026-06-20' })).rejects.toThrow('wrong authenticated human');
    expect(client.enforce).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('checks declared scope before bound online enforcement', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant(['profile:read']));
    const client: GrantexEnforcer = { enforce: vi.fn().mockResolvedValue(makeEnforceResult({})) };
    const callback = vi.fn();
    const tool = createGrantexTool({ name: 'read_calendar', description: 'Read', inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ, requiredScope: 'calendar:read', client, connector: 'calendar', online: true,
      expectedPrincipalId: 'user_01', callback });
    await expect(tool.invoke({ date: '2026-06-20' })).rejects.toThrow(GrantexScopeError);
    expect(client.enforce).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('passes the audience to client.enforce in online mode', async () => {
    // enforce() checks the grant token audience; the tool's audience is the
    // one it expects, as in offline verification.
    const client: GrantexEnforcer = {
      enforce: vi.fn().mockResolvedValue(makeEnforceResult({ allowed: true })),
    };
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      client,
      connector: 'calendar',
      online: true,
      audience: 'https://api.merchant.example',
      callback: async () => 'events',
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).resolves.toBe('events');
    expect(client.enforce).toHaveBeenCalledWith({
      grantToken: TOKEN_WITH_READ,
      connector: 'calendar',
      tool: 'read_calendar',
      audience: 'https://api.merchant.example',
    });
  });

  it('reports an audience denial from online enforcement', async () => {
    const client: GrantexEnforcer = {
      enforce: vi.fn().mockResolvedValue(
        makeEnforceResult({
          allowed: false,
          reason: 'The grant token\'s audience does not include "https://api.merchant.example".',
        }),
      ),
    };
    const callback = vi.fn();
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      client,
      connector: 'calendar',
      online: true,
      audience: 'https://api.merchant.example',
      callback,
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).rejects.toThrow('audience does not include');
    expect(callback).not.toHaveBeenCalled();
  });

  it('throws GrantexScopeError when online enforcement denies the call', async () => {
    const client: GrantexEnforcer = {
      enforce: vi.fn().mockResolvedValue(
        makeEnforceResult({
          allowed: false,
          reason: 'missing write permission',
          scopes: ['calendar:read'],
        }),
      ),
    };
    const callback = vi.fn();
    const strandsTool = createGrantexTool({
      name: 'write_calendar',
      description: 'Write calendar event',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:write',
      client,
      connector: 'calendar',
      online: true,
      callback,
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).rejects.toThrow('missing write permission');
    expect(callback).not.toHaveBeenCalled();
  });

  it('requires client and connector for online mode', async () => {
    const strandsTool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar events',
      inputSchema: INPUT,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'calendar:read',
      online: true,
      callback: async () => 'events',
    });

    await expect(strandsTool.invoke({ date: '2026-06-20' })).rejects.toThrow('client');
  });
});

describe('getGrantScopes', () => {
  it('returns scopes from the scp claim', () => {
    expect(getGrantScopes(TOKEN_WITH_READ)).toEqual(['calendar:read', 'profile:read']);
  });

  it('returns an empty array for invalid tokens', () => {
    expect(getGrantScopes('not-a-jwt')).toEqual([]);
  });
});

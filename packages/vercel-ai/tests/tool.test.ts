import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock `ai` so zodSchema() is an identity function — no real LLM deps
vi.mock('ai', () => ({
  zodSchema: (schema: unknown) => schema,
}));
vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { createGrantexTool, getGrantScopes } from '../src/tool.js';
import { GrantexScopeError } from '../src/types.js';
import { TOOL_NAME_KEY } from '../src/tool.js';
import { verifyGrantToken, type VerifiedGrant } from '@grantex/sdk';

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
  const payload = b64url({
    iss: 'https://api.grantex.dev',
    sub: 'user_01',
    scp: scopes,
    jti: 'tok_01',
    grnt: 'grnt_01',
    exp: 9999999999,
  });
  return `${header}.${payload}.fakesig`;
}

const TOKEN_WITH_READ = makeToken(['data:read', 'data:write']);
const TOKEN_EMPTY = makeToken([]);

const PARAMS = z.object({ url: z.string() });
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

// ─── createGrantexTool ────────────────────────────────────────────────────────

describe('createGrantexTool', () => {
  beforeEach(() => {
    vi.mocked(verifyGrantToken).mockReset();
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant(['data:read', 'data:write']));
  });

  it('returns a tool with the correct shape', () => {
    const t = createGrantexTool({
      name: 'fetch_data',
      description: 'Fetches a URL.',
      parameters: PARAMS,
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'data:read',
      execute: async ({ url }) => `fetched:${url}`,
    });

    expect(t.description).toBe('Fetches a URL.');
    expect(t.inputSchema).toBe(PARAMS);
    expect(typeof t.execute).toBe('function');
    expect(t[TOOL_NAME_KEY]).toBe('fetch_data');
  });

  it('throws GrantexScopeError when required scope is missing', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant([]));
    const tool = createGrantexTool({
      name: 'admin_tool',
      description: 'Admin action.',
      parameters: PARAMS,
      grantToken: TOKEN_EMPTY,
      requiredScope: 'admin:all',
      execute: async () => 'ok',
    });
    await expect(tool.execute({ url: 'https://example.com' }, { toolCallId: 'tc_01', messages: [] }))
      .rejects.toThrowError(GrantexScopeError);
  });

  it('GrantexScopeError includes the missing scope name', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(makeGrant([]));
    const tool = createGrantexTool({
      name: 'tool',
      description: 'tool',
      parameters: PARAMS,
      grantToken: TOKEN_EMPTY,
      requiredScope: 'billing:write',
      execute: async () => 'ok',
    });
    let caught: unknown;
    try {
      await tool.execute({ url: 'https://example.com' }, { toolCallId: 'tc_01', messages: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GrantexScopeError);
    expect((caught as GrantexScopeError).requiredScope).toBe('billing:write');
    expect((caught as GrantexScopeError).grantedScopes).toEqual([]);
  });

  it('rejects an invalid JWT before calling execute', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    vi.mocked(verifyGrantToken).mockRejectedValue(new Error('invalid signature'));
    const tool = createGrantexTool({
      name: 'tool',
      description: 'tool',
      parameters: PARAMS,
      grantToken: 'not-a-jwt',
      requiredScope: 'data:read',
      execute,
    });
    await expect(tool.execute({ url: 'https://example.com' }, { toolCallId: 'tc_01', messages: [] }))
      .rejects.toThrow('invalid signature');
    expect(execute).not.toHaveBeenCalled();
  });

  it('execute delegates to the user function', async () => {
    const t = createGrantexTool({
      name: 'greet',
      description: 'Greets a user.',
      parameters: z.object({ name: z.string() }),
      grantToken: TOKEN_WITH_READ,
      requiredScope: 'data:read',
      execute: async ({ name }) => `Hello, ${name}!`,
    });

    const result = await t.execute({ name: 'Alice' }, { toolCallId: 'tc_01', messages: [] });
    expect(result).toBe('Hello, Alice!');
    expect(verifyGrantToken).toHaveBeenCalledWith(TOKEN_WITH_READ, {
      jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
    });
  });
});

// ─── getGrantScopes ───────────────────────────────────────────────────────────

describe('getGrantScopes', () => {
  it('returns the scp array from the token', () => {
    expect(getGrantScopes(TOKEN_WITH_READ)).toEqual(['data:read', 'data:write']);
  });

  it('returns [] for a token with no scp', () => {
    expect(getGrantScopes(TOKEN_EMPTY)).toEqual([]);
  });
});

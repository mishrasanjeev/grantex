import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// Mock `ai` so zodSchema() is an identity function — no real LLM deps
vi.mock('ai', () => ({
  zodSchema: (schema: unknown) => schema,
}));

import { createGrantexTool, getGrantScopes } from '../src/tool.js';
import { GrantexScopeError } from '../src/types.js';
import { TOOL_NAME_KEY } from '../src/tool.js';

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

// ─── createGrantexTool ────────────────────────────────────────────────────────

describe('createGrantexTool', () => {
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

  it('throws GrantexScopeError when required scope is missing', () => {
    expect(() =>
      createGrantexTool({
        name: 'admin_tool',
        description: 'Admin action.',
        parameters: PARAMS,
        grantToken: TOKEN_EMPTY,
        requiredScope: 'admin:all',
        execute: async () => 'ok',
      }),
    ).toThrowError(GrantexScopeError);
  });

  it('GrantexScopeError includes the missing scope name', () => {
    let caught: unknown;
    try {
      createGrantexTool({
        name: 'tool',
        description: 'tool',
        parameters: PARAMS,
        grantToken: TOKEN_EMPTY,
        requiredScope: 'billing:write',
        execute: async () => 'ok',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GrantexScopeError);
    expect((caught as GrantexScopeError).requiredScope).toBe('billing:write');
    expect((caught as GrantexScopeError).grantedScopes).toEqual([]);
  });

  it('throws a plain Error for an invalid JWT', () => {
    expect(() =>
      createGrantexTool({
        name: 'tool',
        description: 'tool',
        parameters: PARAMS,
        grantToken: 'not-a-jwt',
        requiredScope: 'data:read',
        execute: async () => 'ok',
      }),
    ).toThrow('could not decode grant token');
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

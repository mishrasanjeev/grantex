import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { verifyGrantToken, type VerifiedGrant } from '@grantex/sdk';
import { createGrantexTool, getGrantScopes } from '../src/tool.js';
import { GrantexScopeError } from '../src/types.js';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

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

const TOKEN_WITH_SCOPES = makeToken(['file:read', 'file:write']);
const TOKEN_EMPTY = makeToken([]);

const INPUT_SCHEMA: import('../src/types.js').AnthropicInputSchema = {
  type: 'object',
  properties: { path: { type: 'string', description: 'File path' } },
  required: ['path'],
};

function scopesFromToken(token: string): string[] {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('invalid JWT format');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
  return Array.isArray(payload['scp']) ? (payload['scp'] as string[]) : [];
}

function makeGrant(scopes: string[]): VerifiedGrant {
  return {
    tokenId: 'tok_01',
    grantId: 'grnt_01',
    principalId: 'user_01',
    agentDid: 'did:grantex:ag_01',
    developerId: 'dev_01',
    scopes,
    issuedAt: 1,
    expiresAt: 9999999999,
  };
}

// ─── createGrantexTool ────────────────────────────────────────────────────────

describe('createGrantexTool', () => {
  beforeEach(() => {
    vi.mocked(verifyGrantToken).mockImplementation(async (token) => makeGrant(scopesFromToken(token)));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executes when agent holds the required scope', async () => {
    const fn = vi.fn().mockResolvedValue('file contents');
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: TOKEN_WITH_SCOPES,
      requiredScope: 'file:read',
      execute: fn,
    });

    const result = await tool.execute({ path: '/tmp/config.json' });

    expect(result).toBe('file contents');
    expect(fn).toHaveBeenCalledWith({ path: '/tmp/config.json' });
    expect(verifyGrantToken).toHaveBeenCalledWith(TOKEN_WITH_SCOPES, {
      jwksUri: 'https://api.grantex.dev/.well-known/jwks.json',
    });
  });

  it('passes custom token verification options', async () => {
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: INPUT_SCHEMA,
      grantToken: TOKEN_WITH_SCOPES,
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
      issuer: 'https://issuer.example',
      audience: 'anthropic-tools',
      clockTolerance: 5,
      requiredScope: 'file:read',
      execute: vi.fn().mockResolvedValue('ok'),
    });

    await tool.execute({ path: '/tmp/config.json' });

    expect(verifyGrantToken).toHaveBeenCalledWith(TOKEN_WITH_SCOPES, {
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
      issuer: 'https://issuer.example',
      audience: 'anthropic-tools',
      clockTolerance: 5,
    });
  });

  it('rejects forged tokens even when they contain the required scope', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValueOnce(new Error('invalid signature'));
    const fn = vi.fn();
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: INPUT_SCHEMA,
      grantToken: TOKEN_WITH_SCOPES,
      requiredScope: 'file:read',
      execute: fn,
    });

    await expect(tool.execute({ path: '/tmp/config.json' })).rejects.toThrow('invalid signature');
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws GrantexScopeError when agent lacks the required scope', async () => {
    const fn = vi.fn();
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: TOKEN_EMPTY,
      requiredScope: 'file:read',
      execute: fn,
    });

    await expect(tool.execute({ path: '/tmp/x' })).rejects.toThrow(GrantexScopeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('GrantexScopeError includes scope details', async () => {
    const tool = createGrantexTool({
      name: 'delete_file',
      description: 'Delete a file',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['file:read']),
      requiredScope: 'file:delete',
      execute: vi.fn(),
    });

    let caught: unknown;
    try {
      await tool.execute({});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GrantexScopeError);
    expect((caught as GrantexScopeError).requiredScope).toBe('file:delete');
    expect((caught as GrantexScopeError).grantedScopes).toEqual(['file:read']);
  });

  it('error message includes granted scopes for debugging', async () => {
    const tool = createGrantexTool({
      name: 'send_email',
      description: 'Send an email',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['profile:read']),
      requiredScope: 'email:write',
      execute: vi.fn(),
    });

    await expect(tool.execute({})).rejects.toThrow('profile:read');
  });

  it('exposes the correct Anthropic tool definition shape', () => {
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: TOKEN_WITH_SCOPES,
      requiredScope: 'file:read',
      execute: vi.fn(),
    });

    expect(tool.definition).toEqual({
      name: 'read_file',
      description: 'Read a file from disk',
      input_schema: INPUT_SCHEMA,
    });
  });

  it('throws on a malformed grant token', async () => {
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: INPUT_SCHEMA,
      grantToken: 'not-a-jwt',
      requiredScope: 'file:read',
      execute: vi.fn(),
    });

    await expect(tool.execute({})).rejects.toThrow();
  });

  it('handles token with no scp claim gracefully', async () => {
    const header = b64url({ alg: 'RS256' });
    const payload = b64url({ sub: 'user_01', jti: 'tok_01' });
    const tokenNoScp = `${header}.${payload}.fakesig`;

    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: {} },
      grantToken: tokenNoScp,
      requiredScope: 'file:read',
      execute: vi.fn(),
    });

    await expect(tool.execute({})).rejects.toThrow(GrantexScopeError);
  });
});

// ─── getGrantScopes ───────────────────────────────────────────────────────────

describe('getGrantScopes', () => {
  it('returns the scp array from the token', () => {
    expect(getGrantScopes(TOKEN_WITH_SCOPES)).toEqual(['file:read', 'file:write']);
  });

  it('returns [] for a token with no scp', () => {
    expect(getGrantScopes(TOKEN_EMPTY)).toEqual([]);
  });

  it('returns [] for a token with a non-array scp', () => {
    const header = b64url({ alg: 'RS256' });
    const payload = b64url({ scp: 'not-an-array' });
    const token = `${header}.${payload}.fakesig`;

    expect(getGrantScopes(token)).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createGrantexTool, getGrantScopes } from '../src/tool.js';
import { GrantexScopeError } from '../src/types.js';

/** Build a minimal JWT-shaped token with the given scp claim. */
function makeToken(scp: string[]): string {
  const payload = { scp, grnt: 'grnt_01', jti: 'tok_01', sub: 'user_1' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

const INPUT_SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string', description: 'File path' } },
  required: ['path'],
};

describe('createGrantexTool', () => {
  it('executes when agent holds the required scope', async () => {
    const fn = vi.fn().mockResolvedValue('file contents');
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['file:read']),
      requiredScope: 'file:read',
      execute: fn,
    });

    const result = await tool.execute({ path: '/tmp/test.txt' });

    expect(result).toBe('file contents');
    expect(fn).toHaveBeenCalledWith({ path: '/tmp/test.txt' });
  });

  it('throws GrantexScopeError when agent lacks the required scope', async () => {
    const fn = vi.fn();
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['profile:read']),
      requiredScope: 'file:read',
      execute: fn,
    });

    await expect(tool.execute({ path: '/tmp/test.txt' })).rejects.toThrow(GrantexScopeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('error includes required and granted scopes', async () => {
    const tool = createGrantexTool({
      name: 'send_email',
      description: 'Send an email',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['profile:read', 'calendar:read']),
      requiredScope: 'email:write',
      execute: vi.fn(),
    });

    try {
      await tool.execute({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GrantexScopeError);
      const scopeErr = err as GrantexScopeError;
      expect(scopeErr.requiredScope).toBe('email:write');
      expect(scopeErr.grantedScopes).toEqual(['profile:read', 'calendar:read']);
      expect(scopeErr.message).toContain('email:write');
      expect(scopeErr.message).toContain('profile:read');
    }
  });

  it('exposes the correct Anthropic tool definition shape', () => {
    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: makeToken(['file:read']),
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
      description: 'Read a file from disk',
      inputSchema: INPUT_SCHEMA,
      grantToken: 'not.a.jwt',
      requiredScope: 'file:read',
      execute: vi.fn(),
    });

    await expect(tool.execute({})).rejects.toThrow();
  });

  it('treats missing scp claim as empty scopes', async () => {
    const payload = { grnt: 'grnt_01', sub: 'user_1' };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;

    const tool = createGrantexTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: INPUT_SCHEMA,
      grantToken: token,
      requiredScope: 'file:read',
      execute: vi.fn(),
    });

    try {
      await tool.execute({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GrantexScopeError);
      expect((err as GrantexScopeError).grantedScopes).toEqual([]);
    }
  });
});

describe('getGrantScopes', () => {
  it('returns the scp claim as an array', () => {
    const scopes = getGrantScopes(makeToken(['file:read', 'file:write']));
    expect(scopes).toEqual(['file:read', 'file:write']);
  });

  it('returns empty array when scp is missing', () => {
    const payload = { grnt: 'grnt_01' };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
    expect(getGrantScopes(token)).toEqual([]);
  });

  it('throws on malformed token', () => {
    expect(() => getGrantScopes('bad')).toThrow();
  });
});

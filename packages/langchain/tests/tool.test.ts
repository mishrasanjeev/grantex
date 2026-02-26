import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock @langchain/core/tools before importing our module so DynamicTool is replaced
// with a minimal stub that just stores name, description, and func.
vi.mock('@langchain/core/tools', () => ({
  DynamicTool: class MockDynamicTool {
    name: string;
    description: string;
    readonly #func: (input: string) => Promise<string>;

    constructor(opts: {
      name: string;
      description: string;
      func: (input: string) => Promise<string>;
    }) {
      this.name = opts.name;
      this.description = opts.description;
      this.#func = opts.func;
    }

    async invoke(input: string): Promise<string> {
      return this.#func(input);
    }
  },
}));

import { createGrantexTool } from '../src/tool.js';

/** Build a minimal JWT-shaped token with the given scp claim. */
function makeToken(scp: string[]): string {
  const payload = { scp, grnt: 'grnt_01', jti: 'tok_01', sub: 'user_1' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

describe('createGrantexTool', () => {
  it('invokes func when agent holds the required scope', async () => {
    const fn = vi.fn().mockResolvedValue('calendar events');
    const tool = createGrantexTool({
      name: 'read_calendar',
      description: "Read the user's calendar",
      grantToken: makeToken(['calendar:read', 'profile:read']),
      requiredScope: 'calendar:read',
      func: fn,
    });

    const result = await tool.invoke('show today');

    expect(result).toBe('calendar events');
    expect(fn).toHaveBeenCalledWith('show today');
  });

  it('throws before calling func when agent lacks the required scope', async () => {
    const fn = vi.fn();
    const tool = createGrantexTool({
      name: 'read_calendar',
      description: "Read the user's calendar",
      grantToken: makeToken(['profile:read']),
      requiredScope: 'calendar:read',
      func: fn,
    });

    await expect(tool.invoke('show today')).rejects.toThrow('calendar:read');
    expect(fn).not.toHaveBeenCalled();
  });

  it('error message includes granted scopes for easier debugging', async () => {
    const tool = createGrantexTool({
      name: 'write_email',
      description: 'Send an email',
      grantToken: makeToken(['profile:read']),
      requiredScope: 'email:write',
      func: vi.fn(),
    });

    await expect(tool.invoke('hello')).rejects.toThrow('profile:read');
  });

  it('passes name and description through to the underlying tool', () => {
    const tool = createGrantexTool({
      name: 'read_calendar',
      description: "Read the user's upcoming calendar events",
      grantToken: makeToken(['calendar:read']),
      requiredScope: 'calendar:read',
      func: vi.fn(),
    });

    expect(tool.name).toBe('read_calendar');
    expect(tool.description).toBe("Read the user's upcoming calendar events");
  });

  it('throws on a malformed grant token', async () => {
    const tool = createGrantexTool({
      name: 'read_calendar',
      description: 'Read calendar',
      grantToken: 'not.a.jwt',
      requiredScope: 'calendar:read',
      func: vi.fn(),
    });

    // 'not.a.jwt' has 3 parts but the middle is not valid JSON-in-base64
    // so it will throw when decoding
    await expect(tool.invoke('hi')).rejects.toThrow();
  });
});

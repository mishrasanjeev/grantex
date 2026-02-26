import { describe, it, expect, vi } from 'vitest';
import { createGrantexFunction } from '../src/function.js';

/** Build a minimal JWT-shaped token with the given scp claim. */
function makeToken(scp: string[]): string {
  const payload = { scp, grnt: 'grnt_01', jti: 'tok_01', sub: 'user_1' };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

const PARAMS = {
  type: 'object' as const,
  properties: { date: { type: 'string', description: 'ISO date' } },
  required: ['date'],
};

describe('createGrantexFunction', () => {
  it('executes func when agent holds the required scope', async () => {
    const fn = vi.fn().mockResolvedValue({ events: [] });
    const gfn = createGrantexFunction({
      name: 'list_events',
      description: 'List calendar events',
      parameters: PARAMS,
      grantToken: makeToken(['calendar:read']),
      requiredScope: 'calendar:read',
      func: fn,
    });

    const result = await gfn.execute({ date: '2024-01-15' });

    expect(result).toEqual({ events: [] });
    expect(fn).toHaveBeenCalledWith({ date: '2024-01-15' });
  });

  it('throws before calling func when agent lacks the required scope', async () => {
    const fn = vi.fn();
    const gfn = createGrantexFunction({
      name: 'list_events',
      description: 'List calendar events',
      parameters: PARAMS,
      grantToken: makeToken(['profile:read']),
      requiredScope: 'calendar:read',
      func: fn,
    });

    await expect(gfn.execute({ date: '2024-01-15' })).rejects.toThrow('calendar:read');
    expect(fn).not.toHaveBeenCalled();
  });

  it('error message includes granted scopes for easier debugging', async () => {
    const gfn = createGrantexFunction({
      name: 'send_email',
      description: 'Send an email',
      parameters: PARAMS,
      grantToken: makeToken(['profile:read']),
      requiredScope: 'email:write',
      func: vi.fn(),
    });

    await expect(gfn.execute({})).rejects.toThrow('profile:read');
  });

  it('exposes the correct definition shape', () => {
    const gfn = createGrantexFunction({
      name: 'list_events',
      description: 'List calendar events',
      parameters: PARAMS,
      grantToken: makeToken(['calendar:read']),
      requiredScope: 'calendar:read',
      func: vi.fn(),
    });

    expect(gfn.definition).toEqual({
      type: 'function',
      function: {
        name: 'list_events',
        description: 'List calendar events',
        parameters: PARAMS,
      },
    });
  });

  it('throws on a malformed grant token', async () => {
    const gfn = createGrantexFunction({
      name: 'list_events',
      description: 'List calendar events',
      parameters: PARAMS,
      grantToken: 'not.a.jwt',
      requiredScope: 'calendar:read',
      func: vi.fn(),
    });

    await expect(gfn.execute({})).rejects.toThrow();
  });
});

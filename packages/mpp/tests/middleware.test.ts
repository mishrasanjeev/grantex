import { describe, it, expect } from 'vitest';
import { createMppPassportMiddleware } from '../src/middleware.js';
import type { IssuedPassport, AgentPassportCredential } from '../src/types.js';

function makePassport(overrides?: Partial<IssuedPassport>): IssuedPassport {
  return {
    passportId: 'urn:grantex:passport:01HXYZ',
    credential: {} as AgentPassportCredential,
    encodedCredential: 'dGVzdC1lbmNvZGVk',
    expiresAt: new Date(Date.now() + 86400_000),
    ...overrides,
  };
}

describe('createMppPassportMiddleware', () => {
  it('attaches X-Grantex-Passport header to requests', async () => {
    const passport = makePassport();
    const middleware = createMppPassportMiddleware({ passport });

    const request = new Request('https://api.example.com/resource', {
      method: 'GET',
    });

    const enriched = await middleware(request);

    expect(enriched.headers.get('X-Grantex-Passport')).toBe('dGVzdC1lbmNvZGVk');
    expect(enriched.url).toBe('https://api.example.com/resource');
    expect(enriched.method).toBe('GET');
  });

  it('preserves existing headers', async () => {
    const passport = makePassport();
    const middleware = createMppPassportMiddleware({ passport });

    const request = new Request('https://api.example.com/resource', {
      method: 'POST',
      headers: {
        'Authorization': 'Payment mock-mpp-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: 'test' }),
    });

    const enriched = await middleware(request);

    expect(enriched.headers.get('X-Grantex-Passport')).toBe('dGVzdC1lbmNvZGVk');
    expect(enriched.headers.get('Authorization')).toBe('Payment mock-mpp-token');
    expect(enriched.headers.get('Content-Type')).toBe('application/json');
  });

  it('throws when passport has expired', async () => {
    const passport = makePassport({
      expiresAt: new Date(Date.now() - 1000),
    });
    const middleware = createMppPassportMiddleware({ passport });

    const request = new Request('https://api.example.com/resource');

    await expect(middleware(request)).rejects.toThrow('expired');
  });
});

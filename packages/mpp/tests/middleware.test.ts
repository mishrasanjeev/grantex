import { describe, it, expect, vi } from 'vitest';
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

  it('auto-refreshes when passport is near expiry and onRefresh is provided', async () => {
    const nearExpiry = makePassport({
      encodedCredential: 'b2xkLXBhc3Nwb3J0',
      expiresAt: new Date(Date.now() + 60_000), // 60s left, below 300s threshold
    });
    const refreshedPassport = makePassport({
      passportId: 'urn:grantex:passport:REFRESHED',
      encodedCredential: 'cmVmcmVzaGVk',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const onRefresh = vi.fn().mockResolvedValue(refreshedPassport);
    const middleware = createMppPassportMiddleware({
      passport: nearExpiry,
      autoRefreshThreshold: 300,
      onRefresh,
    });

    const request = new Request('https://api.example.com/resource');

    // First call uses the current (near-expiry) passport but triggers refresh
    const enriched = await middleware(request);
    expect(enriched.headers.get('X-Grantex-Passport')).toBe('b2xkLXBhc3Nwb3J0');
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Wait for background refresh to complete
    await new Promise((r) => setTimeout(r, 10));

    // Second call should use the refreshed passport
    const enriched2 = await middleware(new Request('https://api.example.com/resource'));
    expect(enriched2.headers.get('X-Grantex-Passport')).toBe('cmVmcmVzaGVk');
  });

  it('recovers from expired passport via onRefresh', async () => {
    const expired = makePassport({
      expiresAt: new Date(Date.now() - 1000),
    });
    const refreshedPassport = makePassport({
      encodedCredential: 'cmVjb3ZlcmVk',
      expiresAt: new Date(Date.now() + 86400_000),
    });

    const onRefresh = vi.fn().mockResolvedValue(refreshedPassport);
    const middleware = createMppPassportMiddleware({
      passport: expired,
      onRefresh,
    });

    const request = new Request('https://api.example.com/resource');
    const enriched = await middleware(request);

    expect(enriched.headers.get('X-Grantex-Passport')).toBe('cmVjb3ZlcmVk');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('throws when expired and onRefresh fails', async () => {
    const expired = makePassport({
      expiresAt: new Date(Date.now() - 1000),
    });

    const onRefresh = vi.fn().mockRejectedValue(new Error('network error'));
    const middleware = createMppPassportMiddleware({
      passport: expired,
      onRefresh,
    });

    const request = new Request('https://api.example.com/resource');
    await expect(middleware(request)).rejects.toThrow('refresh failed');
  });
});

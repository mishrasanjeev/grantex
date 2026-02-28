import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('PrincipalSessionsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('create() POSTs to /v1/principal-sessions', async () => {
    const mockResponse = {
      sessionToken: 'eyJ...',
      dashboardUrl: 'https://api.grantex.dev/permissions?session=eyJ...',
      expiresAt: '2026-03-01T00:00:00.000Z',
    };
    const mockFetch = makeFetch(201, mockResponse);
    vi.stubGlobal('fetch', mockFetch);

    const client = new Grantex({ apiKey: 'test_key' });
    const result = await client.principalSessions.create({
      principalId: 'user_123',
      expiresIn: '2h',
    });

    expect(result.sessionToken).toBe('eyJ...');
    expect(result.dashboardUrl).toContain('/permissions?session=');
    expect(result.expiresAt).toBeTruthy();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/v1/principal-sessions');
    expect(init.method).toBe('POST');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.principalId).toBe('user_123');
    expect(sentBody.expiresIn).toBe('2h');
  });

  it('create() sends only principalId when expiresIn is omitted', async () => {
    const mockFetch = makeFetch(201, {
      sessionToken: 'tok',
      dashboardUrl: 'url',
      expiresAt: '2026-03-01T00:00:00.000Z',
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = new Grantex({ apiKey: 'test_key' });
    await client.principalSessions.create({ principalId: 'user_456' });

    const [, init] = mockFetch.mock.calls[0]!;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.principalId).toBe('user_456');
  });
});

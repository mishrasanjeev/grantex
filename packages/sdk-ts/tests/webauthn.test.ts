import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_REGISTRATION_OPTIONS = {
  challengeId: 'ch_01',
  publicKey: {
    rp: { name: 'Grantex', id: 'grantex.dev' },
    challenge: 'dGVzdC1jaGFsbGVuZ2U',
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  },
};

const MOCK_CREDENTIAL = {
  id: 'cred_01',
  principalId: 'user_abc123',
  deviceName: 'YubiKey 5',
  backedUp: false,
  transports: ['usb'],
  createdAt: '2026-03-01T00:00:00Z',
  lastUsedAt: null,
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('WebAuthnClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('registerOptions() POSTs to /v1/webauthn/register/options', async () => {
    const mockFetch = makeFetch(200, MOCK_REGISTRATION_OPTIONS);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.webauthn.registerOptions({ principalId: 'user_abc123' });

    expect(result.challengeId).toBe('ch_01');
    expect(result.publicKey).toBeDefined();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webauthn\/register\/options$/);
    expect(init.method).toBe('POST');
  });

  it('registerVerify() POSTs to /v1/webauthn/register/verify', async () => {
    const mockFetch = makeFetch(200, MOCK_CREDENTIAL);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.webauthn.registerVerify({
      challengeId: 'ch_01',
      response: { id: 'rawId', rawId: 'rawId', type: 'public-key' },
      deviceName: 'YubiKey 5',
    });

    expect(result.id).toBe('cred_01');
    expect(result.principalId).toBe('user_abc123');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webauthn\/register\/verify$/);
    expect(init.method).toBe('POST');
  });

  it('listCredentials() GETs /v1/webauthn/credentials with principalId query', async () => {
    const mockFetch = makeFetch(200, { credentials: [MOCK_CREDENTIAL] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.webauthn.listCredentials('user_abc123');

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]!.deviceName).toBe('YubiKey 5');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/webauthn\/credentials\?principalId=user_abc123$/);
  });

  it('deleteCredential() DELETEs /v1/webauthn/credentials/:id', async () => {
    vi.stubGlobal('fetch', makeFetch(204, null));

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.webauthn.deleteCredential('cred_01')).resolves.toBeUndefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/webauthn\/credentials\/cred_01$/);
    expect(init.method).toBe('DELETE');
  });
});

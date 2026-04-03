import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function noContent() {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import {
  getSsoConfig,
  saveSsoConfig,
  deleteSsoConfig,
  listSsoConnections,
  createSsoConnection,
  deleteSsoConnection,
  testSsoConnection,
} from '../sso';

describe('sso', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── getSsoConfig ──────────────────────────────────────────────────────

  it('getSsoConfig sends GET /v1/sso/config', async () => {
    const config = { issuerUrl: 'https://idp.example.com', clientId: 'client-1', redirectUri: 'https://app.com/cb' };
    ok(config);
    const result = await getSsoConfig();
    expect(result).toEqual(config);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/sso/config', expect.objectContaining({ method: 'GET' }));
  });

  it('getSsoConfig throws on 404', async () => {
    err(404, 'NOT_FOUND', 'No SSO configured');
    await expect(getSsoConfig()).rejects.toThrow('No SSO configured');
  });

  // ── saveSsoConfig ─────────────────────────────────────────────────────

  it('saveSsoConfig sends POST /v1/sso/config with data', async () => {
    const data = {
      issuerUrl: 'https://idp.example.com',
      clientId: 'c1',
      clientSecret: 'secret',
      redirectUri: 'https://app.com/cb',
    };
    ok({ issuerUrl: data.issuerUrl, clientId: data.clientId, redirectUri: data.redirectUri });
    await saveSsoConfig(data);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/sso/config');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('saveSsoConfig throws on 400', async () => {
    err(400, 'VALIDATION', 'Invalid issuer URL');
    await expect(saveSsoConfig({ issuerUrl: '', clientId: '', clientSecret: '', redirectUri: '' })).rejects.toThrow('Invalid issuer URL');
  });

  // ── deleteSsoConfig ───────────────────────────────────────────────────

  it('deleteSsoConfig sends DELETE /v1/sso/config', async () => {
    noContent();
    await deleteSsoConfig();
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/sso/config', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteSsoConfig throws on error', async () => {
    err(404, 'NOT_FOUND', 'No SSO configured');
    await expect(deleteSsoConfig()).rejects.toThrow('No SSO configured');
  });

  // ── listSsoConnections ────────────────────────────────────────────────

  it('listSsoConnections sends GET /v1/sso/connections and returns {connections}', async () => {
    const resp = { connections: [{ id: 'c1', name: 'Okta', protocol: 'oidc' }] };
    ok(resp);
    const result = await listSsoConnections();
    expect(result).toEqual(resp);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/sso/connections', expect.objectContaining({ method: 'GET' }));
  });

  it('listSsoConnections throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listSsoConnections()).rejects.toThrow('Failed');
  });

  // ── createSsoConnection ───────────────────────────────────────────────

  it('createSsoConnection sends POST /v1/sso/connections with data', async () => {
    const data = { name: 'Azure AD', protocol: 'oidc' as const, issuerUrl: 'https://login.microsoft.com/x', clientId: 'c1' };
    ok({ id: 'conn-1', ...data, status: 'active' });
    const result = await createSsoConnection(data);
    expect(result.id).toBe('conn-1');
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/sso/connections');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  it('createSsoConnection throws on 400', async () => {
    err(400, 'VALIDATION', 'Name required');
    await expect(createSsoConnection({ name: '', protocol: 'oidc' })).rejects.toThrow('Name required');
  });

  // ── deleteSsoConnection ───────────────────────────────────────────────

  it('deleteSsoConnection sends DELETE /v1/sso/connections/:id', async () => {
    noContent();
    await deleteSsoConnection('conn-1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/sso/connections/conn-1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteSsoConnection throws on error', async () => {
    err(404, 'NOT_FOUND', 'Connection not found');
    await expect(deleteSsoConnection('missing')).rejects.toThrow('Connection not found');
  });

  // ── testSsoConnection ─────────────────────────────────────────────────

  it('testSsoConnection sends POST /v1/sso/connections/:id/test', async () => {
    const testResult = { success: true, protocol: 'oidc', issuer: 'https://idp.example.com' };
    ok(testResult);
    const result = await testSsoConnection('conn-1');
    expect(result).toEqual(testResult);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/v1/sso/connections/conn-1/test');
    expect(opts.method).toBe('POST');
  });

  it('testSsoConnection returns failure result', async () => {
    ok({ success: false, protocol: 'saml', error: 'IdP unreachable' });
    const result = await testSsoConnection('conn-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('IdP unreachable');
  });

  it('testSsoConnection throws on server error', async () => {
    err(500, 'INTERNAL', 'Test failed');
    await expect(testSsoConnection('conn-1')).rejects.toThrow('Test failed');
  });
});

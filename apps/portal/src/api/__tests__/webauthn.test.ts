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

import { listWebAuthnCredentials, deleteWebAuthnCredential } from '../webauthn';

describe('webauthn', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── listWebAuthnCredentials ───────────────────────────────────────────

  it('listWebAuthnCredentials sends GET /v1/webauthn/credentials with principalId', async () => {
    ok({ credentials: [{ id: 'wc1', principalId: 'p1', credentialId: 'cred-1' }] });
    const result = await listWebAuthnCredentials('p1');
    expect(result).toEqual([{ id: 'wc1', principalId: 'p1', credentialId: 'cred-1' }]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/webauthn/credentials?principalId=p1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('listWebAuthnCredentials encodes principalId', async () => {
    ok({ credentials: [] });
    await listWebAuthnCredentials('p/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/webauthn/credentials?principalId=p%2F1');
  });

  it('listWebAuthnCredentials throws on error', async () => {
    err(401, 'UNAUTHORIZED', 'Not authenticated');
    await expect(listWebAuthnCredentials('p1')).rejects.toThrow('Not authenticated');
  });

  // ── deleteWebAuthnCredential ──────────────────────────────────────────

  it('deleteWebAuthnCredential sends DELETE /v1/webauthn/credentials/:id', async () => {
    noContent();
    await deleteWebAuthnCredential('wc1');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/webauthn/credentials/wc1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('deleteWebAuthnCredential encodes id', async () => {
    noContent();
    await deleteWebAuthnCredential('wc/1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/webauthn/credentials/wc%2F1');
  });

  it('deleteWebAuthnCredential throws on error', async () => {
    err(404, 'NOT_FOUND', 'Credential not found');
    await expect(deleteWebAuthnCredential('missing')).rejects.toThrow('Credential not found');
  });
});

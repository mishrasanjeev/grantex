import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { GoogleDriveAdapter } from '../../src/adapters/google-drive.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['files:read', 'files:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('GoogleDriveAdapter', () => {
  const adapter = new GoogleDriveAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'google-oauth-token',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listFiles', () => {
    it('lists files successfully', async () => {
      const files = { files: [{ id: 'f1', name: 'doc.txt' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(files),
      }));

      const result = await adapter.listFiles('grant-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(files);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/drive/v3/files');
    });

    it('passes query parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ files: [] }),
      }));

      await adapter.listFiles('grant-token', {
        q: 'name contains "report"',
        pageSize: 25,
        fields: 'files(id,name)',
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('q=');
      expect(url).toContain('pageSize=25');
      expect(url).toContain('fields=');
    });

    it('throws SCOPE_MISSING without files:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.listFiles('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.listFiles('bad-token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 403, text: () => Promise.resolve('Forbidden'),
      }));

      try {
        await adapter.listFiles('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('uploadFile', () => {
    it('uploads file successfully', async () => {
      const created = { id: 'f_new', name: 'upload.txt' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.uploadFile('token', {
        name: 'upload.txt',
        mimeType: 'text/plain',
        content: 'Hello world',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[0]).toContain('uploadType=multipart');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'f2' }),
      }));

      await adapter.uploadFile('token', {
        name: 'report.pdf',
        mimeType: 'application/pdf',
        content: 'pdf-content',
        parents: ['folder_1'],
        description: 'Monthly report',
      });

      const body = vi.mocked(fetch).mock.calls[0]![1]?.body as string;
      expect(body).toContain('"parents":["folder_1"]');
      expect(body).toContain('"description":"Monthly report"');
    });

    it('throws SCOPE_MISSING without files:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['files:read'],
      });

      await expect(adapter.uploadFile('token', {
        name: 'test.txt',
        mimeType: 'text/plain',
        content: 'data',
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

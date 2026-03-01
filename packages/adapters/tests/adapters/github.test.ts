import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { GitHubAdapter } from '../../src/adapters/github.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['repos:read', 'issues:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('GitHubAdapter', () => {
  const adapter = new GitHubAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'ghp_test_token',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listRepositories', () => {
    it('lists repositories successfully', async () => {
      const repos = [{ id: 1, name: 'my-repo', full_name: 'user/my-repo' }];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(repos),
      }));

      const result = await adapter.listRepositories('grant-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(repos);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/user/repos');
    });

    it('passes query parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve([]),
      }));

      await adapter.listRepositories('grant-token', {
        sort: 'updated',
        direction: 'desc',
        per_page: 50,
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('sort=updated');
      expect(url).toContain('direction=desc');
      expect(url).toContain('per_page=50');
    });

    it('throws SCOPE_MISSING without repos:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.listRepositories('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.listRepositories('bad-token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('Unauthorized'),
      }));

      try {
        await adapter.listRepositories('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createIssue', () => {
    it('creates issue successfully', async () => {
      const created = { id: 42, number: 1, title: 'Bug report' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createIssue('token', {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Bug report',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[0]).toContain('/repos/octocat/hello-world/issues');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 43 }),
      }));

      await adapter.createIssue('token', {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Feature request',
        body: 'Please add this',
        labels: ['enhancement'],
        assignees: ['octocat'],
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.body).toBe('Please add this');
      expect(body.labels).toEqual(['enhancement']);
      expect(body.assignees).toEqual(['octocat']);
    });

    it('throws SCOPE_MISSING without issues:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['repos:read'],
      });

      await expect(adapter.createIssue('token', {
        owner: 'octocat',
        repo: 'hello-world',
        title: 'Test',
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

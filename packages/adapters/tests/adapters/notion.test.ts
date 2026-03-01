import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { NotionAdapter } from '../../src/adapters/notion.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['pages:read', 'pages:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('NotionAdapter', () => {
  const adapter = new NotionAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'ntn_test_secret',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('queryDatabase', () => {
    it('queries database successfully', async () => {
      const results = { results: [{ id: 'page_1', object: 'page' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(results),
      }));

      const result = await adapter.queryDatabase('grant-token', {
        database_id: 'db_123',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(results);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/databases/db_123/query');
      expect((fetchCall[1]?.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28');
    });

    it('passes filter and sort parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ results: [] }),
      }));

      await adapter.queryDatabase('grant-token', {
        database_id: 'db_123',
        filter: { property: 'Status', select: { equals: 'Done' } },
        sorts: [{ property: 'Created', direction: 'descending' }],
        page_size: 10,
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.filter).toEqual({ property: 'Status', select: { equals: 'Done' } });
      expect(body.sorts).toHaveLength(1);
      expect(body.page_size).toBe(10);
    });

    it('throws SCOPE_MISSING without pages:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.queryDatabase('token', { database_id: 'db_1' }))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.queryDatabase('bad-token', { database_id: 'db_1' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 404, text: () => Promise.resolve('Not Found'),
      }));

      try {
        await adapter.queryDatabase('token', { database_id: 'db_1' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createPage', () => {
    it('creates page successfully', async () => {
      const created = { id: 'page_new', object: 'page' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createPage('token', {
        parent: { database_id: 'db_123' },
        properties: { Name: { title: [{ text: { content: 'New Page' } }] } },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[0]).toContain('/v1/pages');
    });

    it('includes children blocks when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'page_2' }),
      }));

      await adapter.createPage('token', {
        parent: { database_id: 'db_123' },
        properties: { Name: { title: [{ text: { content: 'Test' } }] } },
        children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }],
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.children).toHaveLength(1);
    });

    it('throws SCOPE_MISSING without pages:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['pages:read'],
      });

      await expect(adapter.createPage('token', {
        parent: { database_id: 'db_123' },
        properties: {},
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

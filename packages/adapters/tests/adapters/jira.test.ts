import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { JiraAdapter } from '../../src/adapters/jira.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['issues:read', 'issues:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('JiraAdapter', () => {
  const adapter = new JiraAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'base64-encoded-credentials',
    baseUrl: 'https://myteam.atlassian.net',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('searchIssues', () => {
    it('searches issues successfully', async () => {
      const issues = { total: 1, issues: [{ key: 'PROJ-1', fields: { summary: 'Bug' } }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(issues),
      }));

      const result = await adapter.searchIssues('grant-token', {
        jql: 'project = PROJ',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(issues);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('myteam.atlassian.net/rest/api/3/search');
      expect(fetchCall[1]?.method).toBe('POST');
    });

    it('passes search parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ total: 0, issues: [] }),
      }));

      await adapter.searchIssues('grant-token', {
        jql: 'status = Open',
        maxResults: 50,
        startAt: 10,
        fields: ['summary', 'status'],
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.jql).toBe('status = Open');
      expect(body.maxResults).toBe(50);
      expect(body.startAt).toBe(10);
      expect(body.fields).toEqual(['summary', 'status']);
    });

    it('uses Basic auth header', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ total: 0, issues: [] }),
      }));

      await adapter.searchIssues('grant-token', { jql: 'project = PROJ' });

      const headers = vi.mocked(fetch).mock.calls[0]![1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Basic base64-encoded-credentials');
    });

    it('throws SCOPE_MISSING without issues:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.searchIssues('token', { jql: 'project = PROJ' }))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.searchIssues('bad-token', { jql: 'project = PROJ' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 400, text: () => Promise.resolve('Bad JQL'),
      }));

      try {
        await adapter.searchIssues('token', { jql: 'INVALID' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createIssue', () => {
    it('creates issue successfully', async () => {
      const created = { id: '10001', key: 'PROJ-2', self: 'https://myteam.atlassian.net/rest/api/3/issue/10001' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createIssue('token', {
        projectKey: 'PROJ',
        summary: 'New bug report',
        issueType: 'Bug',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[0]).toContain('/rest/api/3/issue');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.fields.project.key).toBe('PROJ');
      expect(body.fields.summary).toBe('New bug report');
      expect(body.fields.issuetype.name).toBe('Bug');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ key: 'PROJ-3' }),
      }));

      await adapter.createIssue('token', {
        projectKey: 'PROJ',
        summary: 'Feature request',
        issueType: 'Story',
        description: 'Implement dark mode',
        priority: 'High',
        assignee: 'user123',
        labels: ['enhancement', 'ui'],
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.fields.description.type).toBe('doc');
      expect(body.fields.description.content[0].content[0].text).toBe('Implement dark mode');
      expect(body.fields.priority.name).toBe('High');
      expect(body.fields.assignee.id).toBe('user123');
      expect(body.fields.labels).toEqual(['enhancement', 'ui']);
    });

    it('throws SCOPE_MISSING without issues:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['issues:read'],
      });

      await expect(adapter.createIssue('token', {
        projectKey: 'PROJ',
        summary: 'Test',
        issueType: 'Task',
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

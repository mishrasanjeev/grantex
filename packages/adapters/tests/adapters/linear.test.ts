import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { LinearAdapter } from '../../src/adapters/linear.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['issues:read', 'issues:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('LinearAdapter', () => {
  const adapter = new LinearAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'lin_api_key',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listIssues', () => {
    it('lists issues successfully', async () => {
      const issues = { data: { issues: { nodes: [{ id: 'iss_1', title: 'Bug' }] } } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(issues),
      }));

      const result = await adapter.listIssues('grant-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(issues);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toBe('https://api.linear.app/graphql');
      expect(fetchCall[1]?.method).toBe('POST');
    });

    it('passes GraphQL variables with teamId filter', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ data: { issues: { nodes: [] } } }),
      }));

      await adapter.listIssues('grant-token', {
        teamId: 'team_abc',
        first: 25,
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.query).toContain('ListIssues');
      expect(body.variables.first).toBe(25);
      expect(body.variables.filter.team.id.eq).toBe('team_abc');
    });

    it('throws SCOPE_MISSING without issues:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.listIssues('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.listIssues('bad-token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 500, text: () => Promise.resolve('Internal Server Error'),
      }));

      try {
        await adapter.listIssues('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createIssue', () => {
    it('creates issue successfully', async () => {
      const created = { data: { issueCreate: { success: true, issue: { id: 'iss_new' } } } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createIssue('token', {
        teamId: 'team_abc',
        title: 'New feature',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toBe('https://api.linear.app/graphql');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.query).toContain('CreateIssue');
      expect(body.variables.input.teamId).toBe('team_abc');
      expect(body.variables.input.title).toBe('New feature');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ data: { issueCreate: { success: true } } }),
      }));

      await adapter.createIssue('token', {
        teamId: 'team_abc',
        title: 'Urgent fix',
        description: 'Fix the login bug',
        priority: 1,
        assigneeId: 'user_xyz',
        labelIds: ['label_1'],
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.variables.input.description).toBe('Fix the login bug');
      expect(body.variables.input.priority).toBe(1);
      expect(body.variables.input.assigneeId).toBe('user_xyz');
      expect(body.variables.input.labelIds).toEqual(['label_1']);
    });

    it('throws SCOPE_MISSING without issues:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['issues:read'],
      });

      await expect(adapter.createIssue('token', {
        teamId: 'team_abc',
        title: 'Test',
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

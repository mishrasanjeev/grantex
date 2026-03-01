import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { SalesforceAdapter } from '../../src/adapters/salesforce.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['crm:read', 'crm:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('SalesforceAdapter', () => {
  const adapter = new SalesforceAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'sf-access-token',
    instanceUrl: 'https://myorg.salesforce.com',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('queryRecords', () => {
    it('queries records successfully', async () => {
      const records = { totalSize: 1, records: [{ Id: '001', Name: 'Acme' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(records),
      }));

      const result = await adapter.queryRecords('grant-token', {
        query: 'SELECT Id, Name FROM Account LIMIT 10',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(records);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('myorg.salesforce.com');
      expect(fetchCall[0]).toContain('/services/data/v59.0/query');
      expect(fetchCall[0]).toContain('q=');
    });

    it('strips trailing slash from instance URL', async () => {
      const adapterSlash = new SalesforceAdapter({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        credentials: 'sf-token',
        instanceUrl: 'https://myorg.salesforce.com/',
      });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ totalSize: 0, records: [] }),
      }));

      await adapterSlash.queryRecords('grant-token', { query: 'SELECT Id FROM Account' });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).not.toContain('.com//');
    });

    it('throws SCOPE_MISSING without crm:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.queryRecords('token', { query: 'SELECT Id FROM Account' }))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.queryRecords('bad-token', { query: 'SELECT Id FROM Account' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 400, text: () => Promise.resolve('Bad Request'),
      }));

      try {
        await adapter.queryRecords('token', { query: 'INVALID' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createRecord', () => {
    it('creates record successfully', async () => {
      const created = { id: '001abc', success: true };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createRecord('token', {
        sobject: 'Account',
        fields: { Name: 'New Corp', Industry: 'Technology' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      expect(fetchCall[0]).toContain('/sobjects/Account');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.Name).toBe('New Corp');
    });

    it('throws SCOPE_MISSING without crm:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['crm:read'],
      });

      await expect(adapter.createRecord('token', {
        sobject: 'Account',
        fields: { Name: 'Test' },
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

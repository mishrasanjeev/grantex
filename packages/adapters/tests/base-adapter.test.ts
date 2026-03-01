import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { BaseAdapter } from '../src/base-adapter.js';
import { GrantexAdapterError } from '../src/errors.js';
import type { AdapterConfig } from '../src/types.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_123',
  grantId: 'grnt_123',
  principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1',
  developerId: 'dev_1',
  scopes: ['calendar:read', 'payments:initiate:max_500'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

class TestAdapter extends BaseAdapter {
  async testVerifyAndCheckScope(token: string, scope: string) {
    return this.verifyAndCheckScope(token, scope);
  }

  async testResolveCredential() {
    return this.resolveCredential();
  }

  async testLogAudit(
    grant: VerifiedGrant,
    action: string,
    status: 'success' | 'failure' | 'blocked',
  ) {
    return this.logAudit(grant, action, status);
  }

  async testCallUpstream<T>(url: string, options: RequestInit) {
    return this.callUpstream<T>(url, options);
  }
}

describe('BaseAdapter', () => {
  const baseConfig: AdapterConfig = {
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'test-api-key',
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('verifyAndCheckScope', () => {
    it('verifies token and returns grant with matched scope', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
      const adapter = new TestAdapter(baseConfig);

      const result = await adapter.testVerifyAndCheckScope('valid-token', 'calendar:read');

      expect(result.grant).toBe(MOCK_GRANT);
      expect(result.matchedScope.baseScope).toBe('calendar:read');
      expect(verifyGrantToken).toHaveBeenCalledWith('valid-token', {
        jwksUri: baseConfig.jwksUri,
      });
    });

    it('passes clockTolerance when configured', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
      const adapter = new TestAdapter({ ...baseConfig, clockTolerance: 30 });

      await adapter.testVerifyAndCheckScope('token', 'calendar:read');

      expect(verifyGrantToken).toHaveBeenCalledWith('token', {
        jwksUri: baseConfig.jwksUri,
        clockTolerance: 30,
      });
    });

    it('throws TOKEN_INVALID when verification fails', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('bad token'));
      const adapter = new TestAdapter(baseConfig);

      await expect(adapter.testVerifyAndCheckScope('bad', 'calendar:read'))
        .rejects.toThrow(GrantexAdapterError);

      try {
        await adapter.testVerifyAndCheckScope('bad', 'calendar:read');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws SCOPE_MISSING when scope not granted', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
      const adapter = new TestAdapter(baseConfig);

      await expect(adapter.testVerifyAndCheckScope('token', 'email:send'))
        .rejects.toThrow(GrantexAdapterError);

      try {
        await adapter.testVerifyAndCheckScope('token', 'email:send');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('SCOPE_MISSING');
      }
    });

    it('finds scope with constraint', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
      const adapter = new TestAdapter(baseConfig);

      const result = await adapter.testVerifyAndCheckScope('token', 'payments:initiate');
      expect(result.matchedScope.baseScope).toBe('payments:initiate');
      expect(result.matchedScope.constraint).toEqual({ type: 'max', value: 500 });
    });
  });

  describe('resolveCredential', () => {
    it('returns string credential directly', async () => {
      const adapter = new TestAdapter(baseConfig);
      const cred = await adapter.testResolveCredential();
      expect(cred).toBe('test-api-key');
    });

    it('calls function credential provider', async () => {
      const adapter = new TestAdapter({
        ...baseConfig,
        credentials: () => 'dynamic-key',
      });
      const cred = await adapter.testResolveCredential();
      expect(cred).toBe('dynamic-key');
    });

    it('awaits async credential provider', async () => {
      const adapter = new TestAdapter({
        ...baseConfig,
        credentials: async () => 'async-key',
      });
      const cred = await adapter.testResolveCredential();
      expect(cred).toBe('async-key');
    });

    it('throws CREDENTIAL_ERROR on failure', async () => {
      const adapter = new TestAdapter({
        ...baseConfig,
        credentials: () => { throw new Error('no cred'); },
      });

      try {
        await adapter.testResolveCredential();
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('CREDENTIAL_ERROR');
      }
    });
  });

  describe('logAudit', () => {
    it('calls auditLogger when provided', async () => {
      const logger = vi.fn().mockResolvedValue(undefined);
      const adapter = new TestAdapter({ ...baseConfig, auditLogger: logger });

      await adapter.testLogAudit(MOCK_GRANT, 'test:action', 'success');

      expect(logger).toHaveBeenCalledWith({
        agentId: MOCK_GRANT.agentDid,
        grantId: MOCK_GRANT.grantId,
        action: 'test:action',
        status: 'success',
      });
    });

    it('does nothing when no auditLogger', async () => {
      const adapter = new TestAdapter(baseConfig);
      // Should not throw
      await adapter.testLogAudit(MOCK_GRANT, 'test:action', 'success');
    });

    it('swallows auditLogger errors', async () => {
      const logger = vi.fn().mockRejectedValue(new Error('audit fail'));
      const adapter = new TestAdapter({ ...baseConfig, auditLogger: logger });

      // Should not throw
      await adapter.testLogAudit(MOCK_GRANT, 'test:action', 'success');
    });
  });

  describe('callUpstream', () => {
    it('makes fetch request and returns JSON', async () => {
      const mockResponse = { ok: true, json: () => Promise.resolve({ id: '123' }) };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const adapter = new TestAdapter(baseConfig);
      const result = await adapter.testCallUpstream<{ id: string }>('https://api.test.com/data', {
        method: 'GET',
      });

      expect(result).toEqual({ id: '123' });
    });

    it('throws UPSTREAM_ERROR on non-ok response', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

      const adapter = new TestAdapter(baseConfig);

      try {
        await adapter.testCallUpstream('https://api.test.com/data', { method: 'GET' });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
        expect((err as GrantexAdapterError).message).toContain('500');
      }
    });

    it('throws UPSTREAM_ERROR on network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const adapter = new TestAdapter(baseConfig);

      try {
        await adapter.testCallUpstream('https://api.test.com/data', { method: 'GET' });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
        expect((err as GrantexAdapterError).message).toContain('ECONNREFUSED');
      }
    });
  });
});

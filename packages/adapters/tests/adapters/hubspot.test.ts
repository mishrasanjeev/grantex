import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { HubSpotAdapter } from '../../src/adapters/hubspot.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['contacts:read', 'contacts:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('HubSpotAdapter', () => {
  const adapter = new HubSpotAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'hubspot-api-key',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listContacts', () => {
    it('lists contacts successfully', async () => {
      const contacts = { results: [{ id: '1', properties: { email: 'a@b.com' } }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(contacts),
      }));

      const result = await adapter.listContacts('grant-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(contacts);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/crm/v3/objects/contacts');
    });

    it('passes query parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ results: [] }),
      }));

      await adapter.listContacts('grant-token', {
        limit: 20,
        after: 'cursor_abc',
        properties: ['email', 'firstname'],
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('limit=20');
      expect(url).toContain('after=cursor_abc');
      expect(url).toContain('properties=email');
      expect(url).toContain('properties=firstname');
    });

    it('throws SCOPE_MISSING without contacts:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.listContacts('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.listContacts('bad-token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 429, text: () => Promise.resolve('Rate limited'),
      }));

      try {
        await adapter.listContacts('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createContact', () => {
    it('creates contact successfully', async () => {
      const created = { id: '2', properties: { email: 'new@example.com' } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createContact('token', {
        email: 'new@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.properties.email).toBe('new@example.com');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: '3' }),
      }));

      await adapter.createContact('token', {
        email: 'jane@example.com',
        firstname: 'Jane',
        lastname: 'Doe',
        phone: '+1234567890',
        company: 'Acme Inc',
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.properties.firstname).toBe('Jane');
      expect(body.properties.lastname).toBe('Doe');
      expect(body.properties.phone).toBe('+1234567890');
      expect(body.properties.company).toBe('Acme Inc');
    });

    it('throws SCOPE_MISSING without contacts:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['contacts:read'],
      });

      await expect(adapter.createContact('token', {
        email: 'test@example.com',
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

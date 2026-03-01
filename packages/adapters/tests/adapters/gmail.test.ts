import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { GmailAdapter } from '../../src/adapters/gmail.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['email:read', 'email:send'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('GmailAdapter', () => {
  const adapter = new GmailAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'google-oauth-token',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listMessages', () => {
    it('lists messages with default params', async () => {
      const messages = { messages: [{ id: 'msg_1' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(messages),
      }));

      const result = await adapter.listMessages('token');
      expect(result.success).toBe(true);
      expect(result.data).toEqual(messages);

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('/users/me/messages');
    });

    it('passes query and label filters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ messages: [] }),
      }));

      await adapter.listMessages('token', {
        q: 'from:alice',
        maxResults: 5,
        labelIds: ['INBOX', 'UNREAD'],
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('q=from');
      expect(url).toContain('maxResults=5');
      expect(url).toContain('labelIds=INBOX');
      expect(url).toContain('labelIds=UNREAD');
    });

    it('throws SCOPE_MISSING without email:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['email:send'],
      });

      await expect(adapter.listMessages('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws UPSTREAM_ERROR on API failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('Unauthorized'),
      }));

      try {
        await adapter.listMessages('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('sendMessage', () => {
    it('sends message successfully', async () => {
      const sent = { id: 'msg_sent', threadId: 'thr_1' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(sent),
      }));

      const result = await adapter.sendMessage('token', {
        to: 'bob@example.com',
        subject: 'Hello',
        body: 'Hi Bob!',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(sent);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/users/me/messages/send');
      expect(fetchCall[1]?.method).toBe('POST');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.raw).toBeDefined();
    });

    it('includes cc and bcc in MIME', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'msg_2' }),
      }));

      await adapter.sendMessage('token', {
        to: 'bob@example.com',
        subject: 'Test',
        body: 'Hello',
        cc: 'alice@example.com',
        bcc: 'charlie@example.com',
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      const decoded = Buffer.from(body.raw, 'base64url').toString();
      expect(decoded).toContain('Cc: alice@example.com');
      expect(decoded).toContain('Bcc: charlie@example.com');
    });

    it('throws SCOPE_MISSING without email:send', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['email:read'],
      });

      await expect(adapter.sendMessage('token', {
        to: 'bob@example.com', subject: 'Test', body: 'Hi',
      })).rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.sendMessage('bad-token', {
          to: 'bob@example.com', subject: 'Test', body: 'Hi',
        });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });
  });
});

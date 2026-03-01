import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { SlackAdapter } from '../../src/adapters/slack.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['notifications:send', 'notifications:read'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('SlackAdapter', () => {
  const adapter = new SlackAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'xoxb-slack-token',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('sendMessage', () => {
    it('sends message successfully', async () => {
      const slackResp = { ok: true, channel: 'C123', ts: '1234567890.123456' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(slackResp),
      }));

      const result = await adapter.sendMessage('token', {
        channel: 'C123',
        text: 'Hello from agent!',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(slackResp);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('chat.postMessage');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.channel).toBe('C123');
      expect(body.text).toBe('Hello from agent!');
    });

    it('includes thread_ts when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ ok: true }),
      }));

      await adapter.sendMessage('token', {
        channel: 'C123',
        text: 'Thread reply',
        thread_ts: '1234567890.123456',
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.thread_ts).toBe('1234567890.123456');
    });

    it('throws UPSTREAM_ERROR when Slack returns ok: false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
      }));

      try {
        await adapter.sendMessage('token', { channel: 'C999', text: 'test' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
        expect((err as GrantexAdapterError).message).toContain('channel_not_found');
      }
    });

    it('throws SCOPE_MISSING without notifications:send', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['notifications:read'],
      });

      await expect(adapter.sendMessage('token', {
        channel: 'C123', text: 'test',
      })).rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.sendMessage('bad-token', { channel: 'C123', text: 'test' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('TOKEN_INVALID');
      }
    });
  });

  describe('listMessages', () => {
    it('lists messages successfully', async () => {
      const slackResp = { ok: true, messages: [{ text: 'Hello', ts: '123' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(slackResp),
      }));

      const result = await adapter.listMessages('token', { channel: 'C123' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(slackResp);

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('conversations.history');
      expect(url).toContain('channel=C123');
    });

    it('passes optional filters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ ok: true, messages: [] }),
      }));

      await adapter.listMessages('token', {
        channel: 'C123',
        limit: 20,
        oldest: '1000000000.000000',
        latest: '2000000000.000000',
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('limit=20');
      expect(url).toContain('oldest=');
      expect(url).toContain('latest=');
    });

    it('throws UPSTREAM_ERROR when Slack returns ok: false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ ok: false, error: 'missing_scope' }),
      }));

      try {
        await adapter.listMessages('token', { channel: 'C123' });
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
        expect((err as GrantexAdapterError).message).toContain('missing_scope');
      }
    });

    it('throws SCOPE_MISSING without notifications:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT, scopes: ['notifications:send'],
      });

      await expect(adapter.listMessages('token', { channel: 'C123' }))
        .rejects.toThrow(GrantexAdapterError);
    });
  });
});

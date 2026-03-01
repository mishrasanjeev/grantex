import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerifiedGrant } from '@grantex/sdk';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
}));

import { verifyGrantToken } from '@grantex/sdk';
import { GoogleCalendarAdapter } from '../../src/adapters/google-calendar.js';
import { GrantexAdapterError } from '../../src/errors.js';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_1', grantId: 'grnt_1', principalId: 'user_1',
  agentDid: 'did:grantex:agent:a1', developerId: 'dev_1',
  scopes: ['calendar:read', 'calendar:write'],
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

describe('GoogleCalendarAdapter', () => {
  const adapter = new GoogleCalendarAdapter({
    jwksUri: 'https://auth.example.com/.well-known/jwks.json',
    credentials: 'google-oauth-token',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
  });

  describe('listEvents', () => {
    it('lists events with default calendar', async () => {
      const events = { items: [{ id: 'evt_1', summary: 'Meeting' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(events),
      }));

      const result = await adapter.listEvents('grant-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(events);
      expect(result.grant).toBe(MOCK_GRANT);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[0]).toContain('/calendars/primary/events');
    });

    it('passes query parameters', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ items: [] }),
      }));

      await adapter.listEvents('grant-token', {
        calendarId: 'work',
        timeMin: '2026-01-01T00:00:00Z',
        maxResults: 10,
      });

      const url = vi.mocked(fetch).mock.calls[0]![0] as string;
      expect(url).toContain('/calendars/work/events');
      expect(url).toContain('timeMin=');
      expect(url).toContain('maxResults=10');
    });

    it('throws SCOPE_MISSING without calendar:read', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['email:read'],
      });

      await expect(adapter.listEvents('token'))
        .rejects.toThrow(GrantexAdapterError);
    });

    it('throws TOKEN_INVALID on verification failure', async () => {
      vi.mocked(verifyGrantToken).mockRejectedValue(new Error('expired'));

      try {
        await adapter.listEvents('bad-token');
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
        await adapter.listEvents('token');
        expect.fail('should throw');
      } catch (err) {
        expect((err as GrantexAdapterError).code).toBe('UPSTREAM_ERROR');
      }
    });
  });

  describe('createEvent', () => {
    it('creates event successfully', async () => {
      const created = { id: 'evt_new', summary: 'Team Sync' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve(created),
      }));

      const result = await adapter.createEvent('token', {
        summary: 'Team Sync',
        start: { dateTime: '2026-03-01T10:00:00Z' },
        end: { dateTime: '2026-03-01T11:00:00Z' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(created);

      const fetchCall = vi.mocked(fetch).mock.calls[0]!;
      expect(fetchCall[1]?.method).toBe('POST');
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.summary).toBe('Team Sync');
    });

    it('includes optional fields when provided', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: () => Promise.resolve({ id: 'evt_2' }),
      }));

      await adapter.createEvent('token', {
        summary: 'Test',
        start: { dateTime: '2026-03-01T10:00:00Z' },
        end: { dateTime: '2026-03-01T11:00:00Z' },
        description: 'A test event',
        attendees: [{ email: 'bob@example.com' }],
        calendarId: 'team',
      });

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.description).toBe('A test event');
      expect(body.attendees).toEqual([{ email: 'bob@example.com' }]);
    });

    it('throws SCOPE_MISSING without calendar:write', async () => {
      vi.mocked(verifyGrantToken).mockResolvedValue({
        ...MOCK_GRANT,
        scopes: ['calendar:read'],
      });

      await expect(adapter.createEvent('token', {
        summary: 'Test',
        start: { dateTime: '2026-03-01T10:00:00Z' },
        end: { dateTime: '2026-03-01T11:00:00Z' },
      })).rejects.toThrow(GrantexAdapterError);
    });
  });
});

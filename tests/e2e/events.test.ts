/** Event-stream regression: run with EVENT_STREAM_READY_ENABLED=true on the server. */
import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-events-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
});

async function withStream(
  query: string,
  authenticated: boolean,
  check: (response: Response) => Promise<void> | void,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${BASE_URL}/v1/events/stream${query}`, {
      headers: authenticated ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    await check(response);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

describe('E2E: SSE Event Stream', () => {
  it('returns headers and a ready comment before any event or heartbeat', async () => {
    await withStream('', true, async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-cache');
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(': connected\n\n');
      reader.releaseLock();
    });
  });

  it('rejects unauthenticated requests without timing out', async () => {
    await withStream('', false, (response) => {
      expect(response.status).toBe(401);
    });
  });

  it('accepts a type filter without waiting for a matching event', async () => {
    await withStream('?types=grant.created,token.issued', true, (response) => {
      expect(response.status).toBe(200);
    });
  });

  it('disables response buffering', async () => {
    await withStream('', true, (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get('x-accel-buffering')).toBe('no');
    });
  });
});

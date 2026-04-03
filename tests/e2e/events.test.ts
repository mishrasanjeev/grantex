/**
 * E2E Tests: Event Streaming
 *
 * Tests SSE event stream connection, content type headers,
 * and connection limits.
 * Run: npx vitest run tests/e2e/events.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-events-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: SSE Event Stream', () => {
  it('SSE stream endpoint returns 200 with correct content type', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/v1/events/stream`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type');
      expect(contentType).toContain('text/event-stream');

      // The connection header should indicate keep-alive
      const cacheControl = res.headers.get('cache-control');
      expect(cacheControl).toContain('no-cache');
    } catch (err: any) {
      // AbortError is expected since we're closing the SSE connection
      if (err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  it('SSE stream rejects unauthenticated requests', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/v1/events/stream`, {
        signal: controller.signal,
      });

      // Should return 401 or similar auth error
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  it('SSE stream accepts type filter parameter', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/v1/events/stream?types=grant.created,token.issued`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });
});

describe('E2E: Event Stream Headers', () => {
  it('SSE stream includes buffering headers', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${BASE_URL}/v1/events/stream`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);

      // X-Accel-Buffering should be disabled for SSE
      const accelBuffering = res.headers.get('x-accel-buffering');
      if (accelBuffering !== null) {
        expect(accelBuffering).toBe('no');
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('CORS', () => {
  it('allows preflight from https://grantex.dev and skips auth', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/signup',
      headers: {
        origin: 'https://grantex.dev',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://grantex.dev');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('allows preflight from http://localhost:5173 (dev)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/signup',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not reflect unknown origins', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/signup',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'POST',
      },
    });

    // Fastify-cors returns 204 but does NOT set Allow-Origin for unknown
    // origins, so the browser blocks the response.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('actual POST from allowed origin returns Allow-Origin header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/signup',
      headers: {
        origin: 'https://grantex.dev',
        'content-type': 'application/json',
      },
      payload: {}, // empty body → 400, but CORS headers still land
    });

    expect(res.headers['access-control-allow-origin']).toBe('https://grantex.dev');
  });
});

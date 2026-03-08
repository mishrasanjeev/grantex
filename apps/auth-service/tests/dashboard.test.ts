import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('GET /dashboard', () => {
  it('returns HTML with status 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Developer Dashboard');
  });

  it('does not require authentication', async () => {
    // No auth header — should still succeed
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('GET /dashboard/principal', () => {
  it('returns HTML with status 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/principal',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('Manage Permissions');
  });

  it('returns HTML with prefilled principal ID when id query param provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/principal?id=user123',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('user123');
  });

  it('returns HTML with empty value when no id query param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/principal',
    });

    expect(res.statusCode).toBe(200);
    // The input value should be empty when no id is provided
    expect(res.body).toContain('value=""');
  });

  it('escapes HTML special characters in id param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/principal?id=user"<script>alert(1)</script>',
    });

    expect(res.statusCode).toBe(200);
    // The < and " chars should be escaped
    expect(res.body).not.toContain('<script>alert(1)</script>');
  });

  it('does not require authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/principal',
    });

    expect(res.statusCode).toBe(200);
  });
});

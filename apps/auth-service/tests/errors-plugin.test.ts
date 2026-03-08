import { describe, it, expect, vi, beforeAll } from 'vitest';
import Fastify from 'fastify';
import { errorsPlugin } from '../src/plugins/errors.js';

async function buildErrorApp() {
  const app = Fastify({ logger: false });
  await errorsPlugin(app);
  return app;
}

describe('errorsPlugin', () => {
  it('handles 500 errors and logs them', async () => {
    const app = await buildErrorApp();

    app.get('/err500', async () => {
      const err = new Error('Something broke') as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err500' });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Something broke');
    expect(body.requestId).toBeDefined();

    await app.close();
  });

  it('maps 401 to UNAUTHORIZED code', async () => {
    const app = await buildErrorApp();

    app.get('/err401', async () => {
      const err = new Error('Not authenticated') as Error & { statusCode: number };
      err.statusCode = 401;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err401' });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');

    await app.close();
  });

  it('maps 403 to FORBIDDEN code', async () => {
    const app = await buildErrorApp();

    app.get('/err403', async () => {
      const err = new Error('Access denied') as Error & { statusCode: number };
      err.statusCode = 403;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err403' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');

    await app.close();
  });

  it('maps 404 to NOT_FOUND code', async () => {
    const app = await buildErrorApp();

    app.get('/err404', async () => {
      const err = new Error('Resource not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err404' });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');

    await app.close();
  });

  it('maps 422 to VALIDATION_ERROR code', async () => {
    const app = await buildErrorApp();

    app.get('/err422', async () => {
      const err = new Error('Invalid input') as Error & { statusCode: number };
      err.statusCode = 422;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err422' });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_ERROR');

    await app.close();
  });

  it('maps other 4xx to BAD_REQUEST code', async () => {
    const app = await buildErrorApp();

    app.get('/err400', async () => {
      const err = new Error('Bad request') as Error & { statusCode: number };
      err.statusCode = 400;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err400' });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');

    await app.close();
  });

  it('maps 409 to BAD_REQUEST code', async () => {
    const app = await buildErrorApp();

    app.get('/err409', async () => {
      const err = new Error('Conflict') as Error & { statusCode: number };
      err.statusCode = 409;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err409' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('BAD_REQUEST');

    await app.close();
  });

  it('uses default error message when none provided', async () => {
    const app = await buildErrorApp();

    app.get('/err-no-msg', async () => {
      const err = new Error('') as Error & { statusCode: number };
      err.statusCode = 500;
      throw err;
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err-no-msg' });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe('An unexpected error occurred');

    await app.close();
  });

  it('defaults to 500 when no statusCode on error', async () => {
    const app = await buildErrorApp();

    app.get('/err-no-status', async () => {
      throw new Error('Unknown error');
    });

    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/err-no-status' });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');

    await app.close();
  });
});

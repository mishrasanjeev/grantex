import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('POST /v1/budget/allocate', () => {
  it('creates a budget allocation', async () => {
    seedAuth();
    // Grant exists
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_1' }]);
    // Insert allocation
    sqlMock.mockResolvedValueOnce([{
      id: 'bdg_1',
      grant_id: 'grnt_1',
      developer_id: 'dev_TEST',
      initial_budget: '100.0000',
      remaining_budget: '100.0000',
      currency: 'USD',
      created_at: new Date(),
      updated_at: new Date(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', initialBudget: 100 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('id');
    expect(res.json().initialBudget).toBe('100.0000');
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when grant not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // No grant

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_missing', initialBudget: 50 },
    });

    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      payload: { grantId: 'grnt_1', initialBudget: 100 },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/budget/debit', () => {
  it('debits from budget', async () => {
    seedAuth();
    // Debit UPDATE returns updated row
    sqlMock.mockResolvedValueOnce([{ id: 'bdg_1', initial_budget: '100.0000', remaining_budget: '90.0000' }]);
    // Insert transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 10, description: 'API call' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('remaining');
    expect(res.json()).toHaveProperty('transactionId');
  });

  it('returns 402 when insufficient budget', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // No matching row (insufficient)

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 9999 },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('INSUFFICIENT_BUDGET');
  });

  it('returns 400 for missing fields', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for non-positive amount', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: -5 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/budget/balance/:grantId', () => {
  it('returns budget allocation', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'bdg_1',
      grant_id: 'grnt_1',
      developer_id: 'dev_TEST',
      initial_budget: '100.0000',
      remaining_budget: '75.5000',
      currency: 'USD',
      created_at: new Date(),
      updated_at: new Date(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/balance/grnt_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().remainingBudget).toBe('75.5000');
  });

  it('returns 404 when no allocation', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/balance/grnt_missing',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /v1/budget/transactions/:grantId', () => {
  it('returns paginated transactions', async () => {
    seedAuth();
    // Transactions query
    sqlMock.mockResolvedValueOnce([{
      id: 'btx_1',
      grant_id: 'grnt_1',
      allocation_id: 'bdg_1',
      amount: '10.0000',
      description: 'API call',
      metadata: {},
      created_at: new Date(),
    }]);
    // Count query
    sqlMock.mockResolvedValueOnce([{ count: '1' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/transactions/grnt_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(1);
    expect(res.json().total).toBe(1);
  });

  it('returns empty list when no transactions', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/transactions/grnt_empty',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toHaveLength(0);
    expect(res.json().total).toBe(0);
  });

  it('supports page and pageSize params', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ count: '0' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/transactions/grnt_1?page=2&pageSize=10',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
  });
});

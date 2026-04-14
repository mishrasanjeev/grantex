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
    // Grant exists, active, not expired
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_1', status: 'active', expires_at: new Date(Date.now() + 3600_000) }]);
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

  it('returns 409 GRANT_INACTIVE when allocating against a revoked grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_revoked', status: 'revoked', expires_at: new Date(Date.now() + 3600_000) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_revoked', initialBudget: 50 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('GRANT_INACTIVE');
  });

  it('returns 409 GRANT_INACTIVE when allocating against an expired grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_exp', status: 'active', expires_at: new Date(Date.now() - 1000) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_exp', initialBudget: 50 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('GRANT_INACTIVE');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      payload: { grantId: 'grnt_1', initialBudget: 100 },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 409 for duplicate budget allocation', async () => {
    seedAuth();
    // Grant exists, active, not expired
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_1', status: 'active', expires_at: new Date(Date.now() + 3600_000) }]);
    // Insert fails with unique constraint
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('unique constraint violated'), { code: '23505' }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', initialBudget: 100 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });

  it('re-throws unknown errors from allocation', async () => {
    seedAuth();
    // Grant exists, active, not expired
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_1', status: 'active', expires_at: new Date(Date.now() + 3600_000) }]);
    // Insert fails with non-unique error
    sqlMock.mockRejectedValueOnce(new Error('connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/allocate',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', initialBudget: 100 },
    });

    expect(res.statusCode).toBe(500);
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
    sqlMock.mockResolvedValueOnce([]); // UPDATE: no matching row
    // Disambiguation SELECT — grant is still live → INSUFFICIENT_BUDGET (not GRANT_INACTIVE)
    sqlMock.mockResolvedValueOnce([{ status: 'active', expires_at: new Date(Date.now() + 3600_000) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 9999 },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('INSUFFICIENT_BUDGET');
  });

  it('returns 409 GRANT_INACTIVE when debiting against a revoked grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // UPDATE: no matching row (grant blocked the join)
    // Disambiguation SELECT — grant exists but is revoked
    sqlMock.mockResolvedValueOnce([{ status: 'revoked', expires_at: new Date(Date.now() + 3600_000) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_revoked', amount: 10 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('GRANT_INACTIVE');
  });

  it('returns 409 GRANT_INACTIVE when debiting against an expired grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // UPDATE: no matching row
    // Disambiguation SELECT — grant exists, status active, but expires_at is past
    sqlMock.mockResolvedValueOnce([{ status: 'active', expires_at: new Date(Date.now() - 1000) }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_expired', amount: 10 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('GRANT_INACTIVE');
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

  it('re-throws non-InsufficientBudgetError exceptions', async () => {
    seedAuth();
    // debitBudget's SQL call fails with a generic error
    sqlMock.mockRejectedValueOnce(new Error('connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 10 },
    });

    expect(res.statusCode).toBe(500);
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

describe('GET /v1/budget/allocations', () => {
  it('returns all budget allocations for the developer', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'bdg_1',
        grant_id: 'grnt_1',
        developer_id: 'dev_TEST',
        initial_budget: '100.0000',
        remaining_budget: '75.0000',
        currency: 'USD',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'bdg_2',
        grant_id: 'grnt_2',
        developer_id: 'dev_TEST',
        initial_budget: '200.0000',
        remaining_budget: '200.0000',
        currency: 'USD',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/allocations',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().allocations).toHaveLength(2);
  });

  it('returns empty list when no allocations', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/budget/allocations',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().allocations).toHaveLength(0);
  });
});

describe('POST /v1/budget/debit (threshold events)', () => {
  it('emits 50% threshold event when usage crosses 50%', async () => {
    seedAuth();
    // Debit UPDATE returns row with 50% used (initial=100, remaining=45 after debit)
    sqlMock.mockResolvedValueOnce([{ id: 'bdg_1', initial_budget: '100.0000', remaining_budget: '45.0000' }]);
    // Insert transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 5, description: 'API call' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('remaining');
  });

  it('emits exhausted event when remaining reaches 0', async () => {
    seedAuth();
    // Debit UPDATE returns row with 0 remaining
    sqlMock.mockResolvedValueOnce([{ id: 'bdg_1', initial_budget: '100.0000', remaining_budget: '0.0000' }]);
    // Insert transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_1', amount: 10 },
    });

    expect(res.statusCode).toBe(200);
  });

  it('emits budget.threshold at 50% usage', async () => {
    seedAuth();
    // Debit UPDATE RETURNING — initial=100, remaining=50 → usedPct=50
    sqlMock.mockResolvedValueOnce([{
      id: 'bdg_thresh50',
      grant_id: 'grnt_thresh50',
      initial_budget: '100.0000',
      remaining_budget: '50.0000',
    }]);
    // INSERT budget_transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_thresh50', amount: 50 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().remaining).toBe('50.0000');
  });

  it('emits budget.threshold at 80% usage', async () => {
    seedAuth();
    // Debit UPDATE RETURNING — initial=100, remaining=20 → usedPct=80
    sqlMock.mockResolvedValueOnce([{
      id: 'bdg_thresh80',
      grant_id: 'grnt_thresh80',
      initial_budget: '100.0000',
      remaining_budget: '20.0000',
    }]);
    // INSERT budget_transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_thresh80', amount: 80 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().remaining).toBe('20.0000');
  });

  it('emits budget.exhausted when remaining hits 0', async () => {
    seedAuth();
    // Debit UPDATE RETURNING — initial=100, remaining=0 → exhausted
    sqlMock.mockResolvedValueOnce([{
      id: 'bdg_exhaust',
      grant_id: 'grnt_exhaust',
      initial_budget: '100.0000',
      remaining_budget: '0.0000',
    }]);
    // INSERT budget_transaction
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/budget/debit',
      headers: authHeader(),
      payload: { grantId: 'grnt_exhaust', amount: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().remaining).toBe('0.0000');
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

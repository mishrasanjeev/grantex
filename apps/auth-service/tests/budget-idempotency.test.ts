import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import { canonicalJson, sha256hex } from '../src/lib/hash.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

let app: FastifyInstance;
const key = 'budget-retry-example-0001';
const body = { grantId: 'grnt_1', amount: 10 };
const requestHash = sha256hex(canonicalJson({ ...body, description: null, metadata: {} }));

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
afterEach(() => { vi.unstubAllEnvs(); });

function seedReplay(hash = requestHash) {
  seedAuth();
  sqlMock.mockResolvedValueOnce([{ id: 'bdg_1' }]);
  sqlMock.mockResolvedValueOnce([{ active: true }]);
  sqlMock.mockResolvedValueOnce([{
    request_hash: hash, remaining_budget: '90.0000', transaction_id: 'btx_original',
  }]);
}

describe('budget debit idempotency opt-in', () => {
  it.each([undefined, '', 'false', 'TRUE', '1'])('is disabled unless exactly true (%j)', (value) => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', value);
    expect(config.budgetDebitIdempotencyEnabled).toBe(false);
  });

  it('retains the legacy no-key SQL path when disabled, even with an invalid header', async () => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'false');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'bdg_1', initial_budget: '100.0000', remaining_budget: '90.0000' }]);
    sqlMock.mockResolvedValueOnce([]);
    const response = await app.inject({ method: 'POST', url: '/v1/budget/debit',
      headers: { ...authHeader(), 'idempotency-key': 'short' }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(sqlMock.begin).toHaveBeenCalledTimes(1);
    expect(sqlMock.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('budget_debit_idempotency');
  });

  it.each(['', 'short', 'x'.repeat(257)])('rejects invalid enabled keys before debit (%j)', async (invalid) => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
    seedAuth();
    const response = await app.inject({ method: 'POST', url: '/v1/budget/debit',
      headers: { ...authHeader(), 'idempotency-key': invalid }, payload: body });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_IDEMPOTENCY_KEY');
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it('returns the stored response without updating funds or inserting another ledger row', async () => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
    seedReplay();
    const response = await app.inject({ method: 'POST', url: '/v1/budget/debit',
      headers: { ...authHeader(), 'idempotency-key': key }, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ remaining: '90.0000', transactionId: 'btx_original', grantId: 'grnt_1' });
    const queries = sqlMock.mock.calls.map(call => String(call[0])).join('\n');
    expect(queries).toContain('FOR UPDATE');
    expect(queries).not.toContain('UPDATE budget_allocations');
    expect(queries).not.toContain('INSERT INTO budget_transactions');
  });

  it('conflicts rather than changing a key-bound request', async () => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
    seedReplay('0'.repeat(64));
    const response = await app.inject({ method: 'POST', url: '/v1/budget/debit',
      headers: { ...authHeader(), 'idempotency-key': key }, payload: body });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect(sqlMock.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('UPDATE budget_allocations');
  });

  it('does not replay a response after the grant becomes inactive', async () => {
    vi.stubEnv('BUDGET_DEBIT_IDEMPOTENCY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'bdg_1' }]);
    sqlMock.mockResolvedValueOnce([{ active: false }]);
    const response = await app.inject({ method: 'POST', url: '/v1/budget/debit',
      headers: { ...authHeader(), 'idempotency-key': key }, payload: body });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('GRANT_INACTIVE');
    expect(sqlMock.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('FROM budget_debit_idempotency');
  });
});

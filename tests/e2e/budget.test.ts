/**
 * E2E Tests: Budget Management
 *
 * Tests budget allocation, debit, balance check, transactions listing,
 * insufficient funds (402), bad request validation, and pagination.
 * Run: npx vitest run tests/e2e/budget.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let grantId: string;
let grantToken: string;
let secondGrantId: string;

async function authorizeAndExchange(agentId: string, scopes: string[]) {
  const auth = await grantex.authorize({ agentId, userId: `budget-user-${Date.now()}`, scopes });
  const code = ('code' in auth && typeof (auth as any).code === 'string')
    ? (auth as any).code
    : await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: '{}',
      }).then(r => r.json()).then((d: any) => d.code);
  return grantex.tokens.exchange({ code, agentId });
}

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-budget-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  const agent = await grantex.agents.register({ name: `budget-agent-${Date.now()}`, scopes: ['files:read', 'calendar:read'] });

  // Create two grants for multi-grant testing
  const token1 = await authorizeAndExchange(agent.agentId, ['files:read']);
  grantId = token1.grantId;
  grantToken = token1.grantToken;

  const token2 = await authorizeAndExchange(agent.agentId, ['calendar:read']);
  secondGrantId = token2.grantId;
});

describe('E2E: Budget Allocation', () => {
  it('allocates a budget to a grant', async () => {
    const result = await grantex.budgets.allocate({
      grantId,
      initialBudget: 1000,
      currency: 'USD',
    });
    expect(result).toBeDefined();
    expect(result.grantId).toBe(grantId);
    expect(result.initialBudget).toBe(1000);
    expect(result.remainingBudget).toBe(1000);
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
  });

  it('rejects duplicate budget allocation for the same grant', async () => {
    await expect(
      grantex.budgets.allocate({ grantId, initialBudget: 500 }),
    ).rejects.toThrow();
  });

  it('allocates a budget to a second grant independently', async () => {
    const result = await grantex.budgets.allocate({
      grantId: secondGrantId,
      initialBudget: 2000,
      currency: 'EUR',
    });
    expect(result.grantId).toBe(secondGrantId);
    expect(result.initialBudget).toBe(2000);
    expect(result.remainingBudget).toBe(2000);
  });

  it('rejects allocation with zero budget', async () => {
    const agent = await grantex.agents.register({ name: `budget-zero-${Date.now()}`, scopes: ['files:read'] });
    const token = await authorizeAndExchange(agent.agentId, ['files:read']);
    await expect(
      grantex.budgets.allocate({ grantId: token.grantId, initialBudget: 0 }),
    ).rejects.toThrow();
  });

  it('rejects allocation with negative budget', async () => {
    const agent = await grantex.agents.register({ name: `budget-neg-${Date.now()}`, scopes: ['files:read'] });
    const token = await authorizeAndExchange(agent.agentId, ['files:read']);
    await expect(
      grantex.budgets.allocate({ grantId: token.grantId, initialBudget: -100 }),
    ).rejects.toThrow();
  });

  it('rejects allocation for non-existent grant', async () => {
    await expect(
      grantex.budgets.allocate({ grantId: 'grnt_nonexistent_000', initialBudget: 100 }),
    ).rejects.toThrow();
  });
});

describe('E2E: Budget Debit', () => {
  it('debits from the budget', async () => {
    const result = await grantex.budgets.debit({
      grantId,
      amount: 250,
      description: 'test debit',
    });
    expect(result.remaining).toBe(750);
    expect(result.transactionId).toBeTruthy();
    expect(typeof result.transactionId).toBe('string');
    expect(result.grantId).toBe(grantId);
  });

  it('debits again and reflects cumulative spending', async () => {
    const result = await grantex.budgets.debit({
      grantId,
      amount: 300,
      description: 'second debit',
    });
    expect(result.remaining).toBe(450);
    expect(result.transactionId).toBeTruthy();
  });

  it('debits with metadata', async () => {
    const result = await grantex.budgets.debit({
      grantId,
      amount: 50,
      description: 'debit with metadata',
      metadata: { action: 'api-call', endpoint: '/v1/data' },
    });
    expect(result.remaining).toBe(400);
  });

  it('rejects debit with zero amount', async () => {
    await expect(
      grantex.budgets.debit({ grantId, amount: 0, description: 'zero debit' }),
    ).rejects.toThrow();
  });

  it('rejects debit with negative amount', async () => {
    await expect(
      grantex.budgets.debit({ grantId, amount: -50, description: 'negative debit' }),
    ).rejects.toThrow();
  });

  it('returns 402 INSUFFICIENT_BUDGET when overdrawing', async () => {
    try {
      await grantex.budgets.debit({ grantId, amount: 9999, description: 'too much' });
      expect.fail('Should have thrown');
    } catch (err: any) {
      const status = err.status ?? err.statusCode ?? err.response?.status;
      expect(status).toBe(402);
    }
  });

  it('debits from second grant independently', async () => {
    const result = await grantex.budgets.debit({
      grantId: secondGrantId,
      amount: 100,
      description: 'second grant debit',
    });
    expect(result.remaining).toBe(1900);
    expect(result.grantId).toBe(secondGrantId);
  });
});

describe('E2E: Budget Balance', () => {
  it('checks budget balance reflects debits', async () => {
    const balance = await grantex.budgets.balance(grantId);
    expect(balance.remainingBudget).toBe(400);
    expect(balance.initialBudget).toBe(1000);
    expect(balance.grantId).toBe(grantId);
  });

  it('checks second grant balance independently', async () => {
    const balance = await grantex.budgets.balance(secondGrantId);
    expect(balance.remainingBudget).toBe(1900);
    expect(balance.initialBudget).toBe(2000);
  });

  it('returns 404 for balance of non-existent grant', async () => {
    await expect(
      grantex.budgets.balance('grnt_nonexistent_000000'),
    ).rejects.toThrow();
  });
});

describe('E2E: Budget Transactions', () => {
  it('lists budget transactions for the grant', async () => {
    const txns = await grantex.budgets.transactions(grantId);
    expect(txns.transactions).toBeDefined();
    expect(Array.isArray(txns.transactions)).toBe(true);
    expect(txns.transactions.length).toBeGreaterThanOrEqual(3);
    expect(txns.total).toBeGreaterThanOrEqual(3);

    // Verify transaction shape
    const tx = txns.transactions[0];
    expect(tx).toHaveProperty('amount');
    expect(typeof tx.amount).toBe('number');
  });

  it('lists transactions for the second grant separately', async () => {
    const txns = await grantex.budgets.transactions(secondGrantId);
    expect(txns.transactions.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty transactions for grant with no debits', async () => {
    const agent = await grantex.agents.register({ name: `budget-notx-${Date.now()}`, scopes: ['files:read'] });
    const token = await authorizeAndExchange(agent.agentId, ['files:read']);
    await grantex.budgets.allocate({ grantId: token.grantId, initialBudget: 100 });

    const txns = await grantex.budgets.transactions(token.grantId);
    expect(txns.transactions.length).toBe(0);
    expect(txns.total).toBe(0);
  });
});

describe('E2E: Budget Allocations List', () => {
  it('lists all budget allocations for the developer', async () => {
    const res = await fetch(`${BASE_URL}/v1/budget/allocations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { allocations: any[] };
    expect(body.allocations).toBeDefined();
    expect(Array.isArray(body.allocations)).toBe(true);
    // Should have at least the two allocations we created + the no-tx one
    expect(body.allocations.length).toBeGreaterThanOrEqual(3);

    // Verify allocation shape
    const alloc = body.allocations[0];
    expect(alloc).toHaveProperty('id');
    expect(alloc).toHaveProperty('grantId');
    expect(alloc).toHaveProperty('initialBudget');
    expect(alloc).toHaveProperty('remainingBudget');
  });
});

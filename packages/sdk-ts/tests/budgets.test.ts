import { describe, it, expect, afterEach, vi } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_ALLOCATION = {
  id: 'budg_01',
  grantId: 'grant_01',
  developerId: 'dev_01',
  initialBudget: '100.00',
  remainingBudget: '75.50',
  currency: 'USD',
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

const MOCK_TRANSACTION = {
  id: 'tx_01',
  grantId: 'grant_01',
  allocationId: 'budg_01',
  amount: '24.50',
  description: 'API call',
  metadata: { endpoint: '/v1/agents' },
  createdAt: '2026-03-01T01:00:00Z',
};

describe('BudgetsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('allocate() POSTs to /v1/budget/allocate', async () => {
    const mockFetch = makeFetch(201, MOCK_ALLOCATION);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.allocate({
      grantId: 'grant_01',
      initialBudget: 100,
      currency: 'USD',
    });

    expect(result.id).toBe('budg_01');
    expect(result.initialBudget).toBe('100.00');
    expect(result.currency).toBe('USD');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/budget\/allocate$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.grantId).toBe('grant_01');
    expect(body.initialBudget).toBe(100);
    expect(body.currency).toBe('USD');
  });

  it('allocate() sends only required fields when currency is omitted', async () => {
    const mockFetch = makeFetch(201, { ...MOCK_ALLOCATION, currency: 'USD' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.budgets.allocate({
      grantId: 'grant_01',
      initialBudget: 50,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.grantId).toBe('grant_01');
    expect(body.initialBudget).toBe(50);
  });

  it('debit() POSTs to /v1/budget/debit', async () => {
    const mockFetch = makeFetch(200, { remaining: '75.50', transactionId: 'tx_01' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.debit({
      grantId: 'grant_01',
      amount: 24.50,
      description: 'API call',
      metadata: { endpoint: '/v1/agents' },
    });

    expect(result.remaining).toBe('75.50');
    expect(result.transactionId).toBe('tx_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/budget\/debit$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.grantId).toBe('grant_01');
    expect(body.amount).toBe(24.50);
    expect(body.description).toBe('API call');
    expect(body.metadata).toEqual({ endpoint: '/v1/agents' });
  });

  it('debit() works with only required fields', async () => {
    const mockFetch = makeFetch(200, { remaining: '90.00', transactionId: 'tx_02' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.debit({
      grantId: 'grant_01',
      amount: 10,
    });

    expect(result.remaining).toBe('90.00');
    expect(result.transactionId).toBe('tx_02');
  });

  it('balance() GETs /v1/budget/balance/:grantId', async () => {
    const mockFetch = makeFetch(200, MOCK_ALLOCATION);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.balance('grant_01');

    expect(result.grantId).toBe('grant_01');
    expect(result.remainingBudget).toBe('75.50');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/budget\/balance\/grant_01$/);
    expect(init.method).toBe('GET');
  });

  it('transactions() GETs /v1/budget/transactions/:grantId', async () => {
    const mockFetch = makeFetch(200, {
      transactions: [MOCK_TRANSACTION],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.transactions('grant_01');

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.id).toBe('tx_01');
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/budget\/transactions\/grant_01$/);
    expect(init.method).toBe('GET');
  });

  it('transactions() passes pagination params as query string', async () => {
    const mockFetch = makeFetch(200, {
      transactions: [],
      total: 50,
      page: 3,
      pageSize: 10,
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.budgets.transactions('grant_01', { page: 3, pageSize: 10 });

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('page=3');
    expect(url).toContain('pageSize=10');
  });

  it('transactions() works without pagination params', async () => {
    const mockFetch = makeFetch(200, {
      transactions: [MOCK_TRANSACTION],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.budgets.transactions('grant_01');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/budget\/transactions\/grant_01$/);
    expect(url).not.toContain('?');
  });
});

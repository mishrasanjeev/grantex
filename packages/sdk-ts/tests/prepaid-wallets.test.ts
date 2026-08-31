import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrepaidWalletAgentClient,
  PrincipalPrepaidWalletClient,
  type PrepaidAuthorizationRequest,
} from '../src/prepaid-wallets.js';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PrepaidWalletAgentClient', () => {
  const dpopFetch = vi.fn<(
    input: string | URL,
    accessToken: string,
    init?: RequestInit,
  ) => Promise<Response>>();
  const client = new PrepaidWalletAgentClient({
    oauthClient: { fetch: dpopFetch },
    accessToken: 'access-one',
    resourceUrl: 'https://api.grantex.dev/v1/prepaid-wallets',
  });

  beforeEach(() => dpopFetch.mockReset());

  it('lists through the DPoP resource client and supports token rotation', async () => {
    dpopFetch.mockImplementation(async () => response({ wallets: [{ walletId: 'pwal_1' }] }));
    expect(await client.list()).toEqual([{ walletId: 'pwal_1' }]);
    expect(dpopFetch).toHaveBeenCalledWith(
      'https://api.grantex.dev/v1/prepaid-wallets',
      'access-one',
      expect.any(Object),
    );

    client.setAccessToken('access-two');
    await client.list();
    expect(dpopFetch.mock.calls[1]![1]).toBe('access-two');
  });

  it('authorizes x402 terms and exposes a directly compatible callback', async () => {
    dpopFetch.mockResolvedValue(response({ authorization: 'wallet-jwt' }, 201));
    const params: PrepaidAuthorizationRequest = {
      amount: '1000', asset: 'USDC', network: 'grantex:prepaid',
      recipient: 'merchant', resource: 'https://merchant.test/data',
      scope: 'data:read', maxTimeoutSeconds: 120, idempotencyKey: 'idem-1234567890123456',
    };
    expect(await client.x402Authorizer(params)).toMatchObject({ authorization: 'wallet-jwt' });
    const init = dpopFetch.mock.calls[0]![2]!;
    expect(dpopFetch.mock.calls[0]![0]).toBe('https://api.grantex.dev/v1/prepaid-wallets/authorizations');
    expect(JSON.parse(String(init.body))).toEqual(params);
  });

  it('returns an exact approval challenge and sends the approved retry context unchanged', async () => {
    dpopFetch.mockResolvedValueOnce(response({
      status: 'approval_required', approvalRequestId: 'wapr_1', walletId: 'pwal_1',
      assignmentId: 'wasn_1', policyIds: ['wspol_1'], expiresAt: new Date().toISOString(),
    }, 202));
    const request: PrepaidAuthorizationRequest = {
      walletId: 'pwal_1', amount: '2500', asset: 'USDC', network: 'grantex:prepaid',
      recipient: 'merchant', resource: 'https://merchant.test/pay', scope: 'commerce:pay',
      maxTimeoutSeconds: 300, idempotencyKey: 'approval-payment-000001', merchantId: 'org_merchant',
      purpose: 'software', projectId: 'project-7', costCenter: 'engineering',
    };
    await expect(client.authorizePayment(request)).resolves.toMatchObject({ status: 'approval_required' });

    dpopFetch.mockResolvedValueOnce(response({ authorization: 'approved-wallet-jwt' }, 201));
    await client.authorizePayment({ ...request, approvalRequestId: 'wapr_1' });
    expect(JSON.parse(String(dpopFetch.mock.calls[1]![2]!.body))).toEqual({
      ...request, approvalRequestId: 'wapr_1',
    });
  });

  it('requests reloads and surfaces API errors without leaking response internals', async () => {
    dpopFetch.mockResolvedValueOnce(response({ reloadRequestId: 'wrel_1', status: 'pending' }, 201));
    expect(await client.requestReload('pwal/1', '5000', 'reload-request-00000001', 'low funds')).toMatchObject({ status: 'pending' });
    expect(dpopFetch.mock.calls[0]![0]).toContain('pwal%2F1/reload-requests');
    expect(JSON.parse(String(dpopFetch.mock.calls[0]![2]!.body))).toEqual({
      amount: '5000', idempotencyKey: 'reload-request-00000001', reason: 'low funds',
    });

    dpopFetch.mockResolvedValueOnce(response({ message: 'Wallet is blocked', code: 'WALLET_BLOCKED', requestId: 'req_1' }, 403));
    await expect(client.requestReload('pwal_1', '5000', 'reload-request-00000002')).rejects.toMatchObject({
      name: 'PrepaidWalletApiError', status: 403, code: 'WALLET_BLOCKED', requestId: 'req_1',
    });
  });

  it('rejects a resource URL that cannot match the OAuth wallet audience', () => {
    expect(() => new PrepaidWalletAgentClient({
      oauthClient: { fetch: dpopFetch }, accessToken: 'token', resourceUrl: 'https://api.grantex.dev/v1/other',
    })).toThrow('must end with /v1/prepaid-wallets');
    expect(() => new PrepaidWalletAgentClient({
      oauthClient: { fetch: dpopFetch }, accessToken: 'token',
      resourceUrl: 'http://api.example/v1/prepaid-wallets',
    })).toThrow('must use HTTPS');
  });
});

describe('PrincipalPrepaidWalletClient', () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  let client: PrincipalPrepaidWalletClient;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    client = new PrincipalPrepaidWalletClient({ baseUrl: 'https://api.grantex.dev/', sessionToken: 'session-one' });
  });

  it('rejects insecure remote and credential-bearing base URLs', () => {
    expect(() => new PrincipalPrepaidWalletClient({
      baseUrl: 'http://api.example', sessionToken: 'session',
    })).toThrow('must use HTTPS');
    expect(() => new PrincipalPrepaidWalletClient({
      baseUrl: 'https://user:password@api.example', sessionToken: 'session',
    })).toThrow('must not contain credentials');
  });

  it('covers create, list, activity, assignment, block, reload, decision, funding, and release routes', async () => {
    const calls: Array<() => Promise<unknown>> = [
      () => client.create({ name: 'Ops', custodyMode: 'sandbox_ledger', network: 'grantex:prepaid', asset: 'USDC' }),
      () => client.list(),
      () => client.activity('pwal_1'),
      () => client.assign('pwal_1', { agentId: 'agt_1', perTransactionLimit: '100', cumulativeLimit: '1000', cumulativePeriodSeconds: 3600 }),
      () => client.setAssignmentStatus('wasn_1', 'blocked', 'pause'),
      () => client.setWalletStatus('pwal_1', 'blocked', 'lost device'),
      () => client.setAgentBlocked('agt_1', true, 'incident'),
      () => client.reload('pwal_1', '5000', 'reload-idempotency-0001'),
      () => client.decideReload('wrel_1', 'approved'),
      () => client.fundReload('wrel_1'),
      () => client.releaseReservation('wres_1', 'merchant cancelled'),
      () => client.createSpendPolicy({
        name: 'Daily engineering cap', scopeType: 'group', scopeId: 'engineering', effect: 'limit',
        maxAmount: '10000', windowType: 'calendar_day', onExceed: 'require_approval',
      }),
      () => client.listSpendPolicies(),
      () => client.setSpendPolicyStatus('wspol_1', 'disabled'),
      () => client.listPaymentApprovals(),
      () => client.decidePaymentApproval('wapr_1', 'approved', 'Business owner approved'),
    ];
    for (const call of calls) {
      fetchMock.mockResolvedValueOnce(response({ wallets: [], ok: true }));
      await call();
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls.length);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.grantex\.dev\/v1\/principal\/prepaid-wallet/);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-one');
    }
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'POST', 'GET', 'GET', 'POST', 'PATCH', 'PATCH', 'PUT', 'POST', 'POST', 'POST', 'POST',
      'POST', 'GET', 'PATCH', 'GET', 'POST',
    ]);
  });

  it('rotates the principal session token', async () => {
    client.setSessionToken('session-two');
    fetchMock.mockResolvedValueOnce(response({ wallets: [] }));
    await client.list();
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer session-two');
  });
});

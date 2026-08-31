import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, sqlMock, TEST_DEVELOPER } from './helpers.js';
import { signPrincipalSessionToken } from '../src/lib/crypto.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
}, 30_000);

async function principalHeader() {
  const token = await signPrincipalSessionToken({
    developerId: TEST_DEVELOPER.id,
    principalId: 'principal_wallet_test',
  }, 3600);
  return { authorization: `Bearer ${token}` };
}

describe('prepaid wallet route trust boundaries', () => {
  it.each([
    ['POST', '/v1/principal/prepaid-wallets'],
    ['GET', '/v1/principal/prepaid-wallets'],
    ['PUT', '/v1/principal/prepaid-wallet-agents/agt_1/block'],
    ['POST', '/v1/principal/prepaid-wallet-spend-policies'],
    ['GET', '/v1/principal/prepaid-wallet-spend-policies'],
    ['GET', '/v1/principal/prepaid-wallet-payment-approvals'],
  ])('requires a principal session for %s %s', async (method, url) => {
    const response = await app.inject({
      method: method as 'POST' | 'GET' | 'PUT',
      url,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each([
    ['POST', '/v1/prepaid-wallet-spend-policies'],
    ['GET', '/v1/prepaid-wallet-spend-policies'],
    ['PATCH', '/v1/prepaid-wallet-spend-policies/wspol_1/status'],
  ])('requires a developer API key for %s %s', async (method, url) => {
    const response = await app.inject({
      method: method as 'POST' | 'GET' | 'PATCH', url, payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('creates a wallet only in the authenticated principal/developer partition', async () => {
    const row = {
      id: 'pwal_1', developer_id: TEST_DEVELOPER.id, principal_id: 'principal_wallet_test',
      name: 'Agent float', custody_mode: 'sandbox_ledger', provider: null,
      provider_wallet_id: null, wallet_address: null, network: 'grantex:prepaid', asset: 'USDC',
      decimals: 6, available_amount: '0', reserved_amount: '0', low_balance_threshold: '1000',
      status: 'active', blocked_at: null, blocked_reason: null, metadata: {},
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    sqlMock.mockResolvedValueOnce([row]);
    const response = await app.inject({
      method: 'POST', url: '/v1/principal/prepaid-wallets', headers: await principalHeader(),
      payload: { name: 'Agent float', custodyMode: 'sandbox_ledger', network: 'grantex:prepaid', asset: 'USDC', lowBalanceThreshold: '1000' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ walletId: 'pwal_1', principalId: 'principal_wallet_test' });
  });

  it('requires a stable idempotency key for direct principal funding', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/principal/prepaid-wallets/pwal_1/reloads',
      headers: await principalHeader(),
      payload: { amount: '1000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects missing agent DPoP credentials before touching wallet data', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/prepaid-wallets/authorizations',
      payload: { amount: '1' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('DPoP');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('advertises only the supported official x402 v2 pair', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/x402/supported' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kinds: [{ x402Version: 2, scheme: 'exact', network: 'grantex:prepaid' }] });
  });

  it('fails closed on malformed or unsigned x402 verify and settle requests', async () => {
    for (const path of ['/v1/x402/verify', '/v1/x402/settle']) {
      const response = await app.inject({ method: 'POST', url: path, payload: { x402Version: 2 } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject(path.endsWith('verify')
        ? { isValid: false, invalidReason: 'INVALID_REQUEST' }
        : { success: false, errorReason: 'INVALID_REQUEST' });
    }
  });
});

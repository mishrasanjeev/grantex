import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateOAuthAgentKey,
  OAuthAgentClient,
  PrepaidWalletAgentClient,
  PrincipalPrepaidWalletClient,
  type AssignPrepaidWalletParams,
  type PrepaidAuthorizationRequest,
  type PrepaidAuthorizationResponse,
  type PrepaidWallet,
  type WalletAssignment,
} from '@grantex/sdk';
import { createX402Agent, HEADERS } from '../../packages/x402/src/agent.js';

const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ISSUER = (process.env.E2E_ISSUER ?? BASE_URL).replace(/\/$/, '');
const RESOURCE = `${ISSUER}/v1/prepaid-wallets`;
const REDIRECT_URI = 'https://wallet-e2e.example/callback';
const NETWORK = 'grantex:prepaid';
const ASSET = 'USDC';
const RECIPIENT = 'merchant:test';
const SCOPE = 'commerce:pay';

let apiKey = '';
let agentId = '';

function tokenPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('Access token is not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function developerApi(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as T;
}

async function expectApiError<T>(promise: Promise<T>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    const value = error as Error & { status?: number; code?: string };
    expect(value.status, value.message).toBe(status);
    expect(value.code, value.message).toBe(code);
  }
}

function authorizationRequest(
  overrides: Partial<PrepaidAuthorizationRequest> = {},
): PrepaidAuthorizationRequest {
  return {
    amount: '1000',
    asset: ASSET,
    network: NETWORK,
    recipient: RECIPIENT,
    resource: 'https://merchant.example/items/coffee',
    scope: SCOPE,
    maxTimeoutSeconds: 300,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

function x402Envelope(authorization: PrepaidAuthorizationResponse, request: PrepaidAuthorizationRequest) {
  const requirements = {
    scheme: 'exact',
    network: NETWORK,
    amount: request.amount,
    asset: ASSET,
    payTo: request.recipient,
    maxTimeoutSeconds: request.maxTimeoutSeconds,
    extra: { grantexScope: request.scope },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: {
        url: request.resource,
        description: 'Prepaid wallet E2E purchase',
        mimeType: 'application/json',
      },
      accepted: requirements,
      payload: { authorization: authorization.authorization },
    },
    paymentRequirements: requirements,
  };
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function fromBase64Json(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
}

async function facilitator(path: 'verify' | 'settle', body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_URL}/v1/x402/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return responseJson(response);
}

afterAll(async () => {
  if (apiKey && agentId) {
    await developerApi(`/v1/agents/${agentId}`, { method: 'DELETE' }).catch(() => undefined);
  }
});

describe('agent prepaid wallets and x402 v2 E2E', () => {
  it('enforces the complete multi-wallet, policy, reload, block, and settlement lifecycle', async () => {
    const signup = await fetch(`${BASE_URL}/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `prepaid-wallet-e2e-${Date.now()}`, mode: 'sandbox' }),
    });
    apiKey = (await responseJson<{ apiKey: string }>(signup)).apiKey;

    const key = await generateOAuthAgentKey();
    const registration = await developerApi('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Prepaid Wallet E2E Agent',
        description: 'Disposable agent for the complete prepaid-wallet test suite',
        scopes: ['wallet:read', 'wallet:spend', 'wallet:reload:request', SCOPE, 'commerce:refund'],
        redirectUris: [REDIRECT_URI],
        resourceServers: [RESOURCE],
        publicJwk: key.publicJwk,
      }),
    });
    agentId = (await responseJson<{ agentId: string }>(registration)).agentId;

    const oauth = await OAuthAgentClient.create({
      issuer: ISSUER,
      clientId: agentId,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      privateKey: key.privateKey,
      publicJwk: key.publicJwk,
      allowInsecureLoopback: true,
    });
    const principalId = `principal-wallet-e2e-${Date.now()}`;
    const pending = await oauth.beginAuthorization({
      scopes: ['wallet:read', 'wallet:spend', 'wallet:reload:request', SCOPE, 'commerce:refund'],
      principalHint: principalId,
    });
    const approval = await fetch(pending.authorizationUrl, { redirect: 'manual' });
    expect(approval.status).toBe(303);
    const callback = approval.headers.get('location');
    expect(callback).toBeTruthy();
    const tokens = await oauth.completeAuthorization(callback!);
    expect(tokenPayload(tokens.access_token)).toMatchObject({
      sub: principalId,
      client_id: agentId,
      aud: RESOURCE,
      scope: 'wallet:read wallet:spend wallet:reload:request commerce:pay commerce:refund',
    });

    const sessionResponse = await developerApi('/v1/principal-sessions', {
      method: 'POST',
      body: JSON.stringify({ principalId, expiresIn: '1h' }),
    });
    const session = await responseJson<{ sessionToken: string }>(sessionResponse);
    const principal = new PrincipalPrepaidWalletClient({ baseUrl: BASE_URL, sessionToken: session.sessionToken });
    const agent = new PrepaidWalletAgentClient({ oauthClient: oauth, accessToken: tokens.access_token });

    async function createWallet(
      name: string,
      balance: string,
      policy: Partial<AssignPrepaidWalletParams> = {},
      lowBalanceThreshold = '0',
    ): Promise<{ wallet: PrepaidWallet; assignment: WalletAssignment }> {
      const wallet = await principal.create({
        name,
        custodyMode: 'sandbox_ledger',
        network: NETWORK,
        asset: ASSET,
        decimals: 6,
        lowBalanceThreshold,
      });
      if (balance !== '0') await principal.reload(wallet.walletId, balance, randomUUID());
      const assignment = await principal.assign(wallet.walletId, {
        agentId,
        perTransactionLimit: '5000',
        cumulativeLimit: '20000',
        cumulativePeriodSeconds: 3600,
        allowedRecipients: [RECIPIENT],
        allowedScopes: [SCOPE],
        ...policy,
      });
      return { wallet, assignment };
    }

    // Direct principal funding is response-loss safe and cannot change terms.
    const retrySafeWallet = await principal.create({
      name: 'Retry-safe direct reload wallet',
      custodyMode: 'sandbox_ledger',
      network: NETWORK,
      asset: ASSET,
    });
    const directReloadKey = randomUUID();
    const directReloadA = await principal.reload(retrySafeWallet.walletId, '3000', directReloadKey);
    const directReloadB = await principal.reload(retrySafeWallet.walletId, '3000', directReloadKey);
    expect(directReloadB.reloadRequestId).toBe(directReloadA.reloadRequestId);
    expect((await principal.list()).find((wallet) => wallet.walletId === retrySafeWallet.walletId)?.availableAmount).toBe('3000');
    await expectApiError(principal.reload(retrySafeWallet.walletId, '3001', directReloadKey), 409, 'IDEMPOTENCY_CONFLICT');
    await expectApiError(principal.reload(retrySafeWallet.walletId, '3000', directReloadKey, 'different-reference'), 409, 'IDEMPOTENCY_CONFLICT');
    await principal.reload(retrySafeWallet.walletId, '100', randomUUID(), 'provider-credit-e2e-1');
    await expectApiError(principal.reload(
      retrySafeWallet.walletId,
      '100',
      randomUUID(),
      'provider-credit-e2e-1',
    ), 409, 'EXTERNAL_REFERENCE_CONFLICT');

    const capacityWallet = await principal.create({
      name: 'Atomic balance capacity wallet',
      custodyMode: 'sandbox_ledger',
      network: NETWORK,
      asset: ASSET,
    });
    await principal.reload(capacityWallet.walletId, '9'.repeat(78), randomUUID());
    await expectApiError(principal.reload(capacityWallet.walletId, '1', randomUUID()), 409, 'WALLET_BALANCE_LIMIT_EXCEEDED');

    // Multiple wallets: an unpinned authorization skips an underfunded first wallet.
    const first = await createWallet('First wallet, deliberately small', '500');
    const second = await createWallet('Second wallet, automatic fallback', '20000');
    const listed = await agent.list();
    expect(listed.map((wallet) => wallet.walletId)).toEqual(expect.arrayContaining([
      first.wallet.walletId,
      second.wallet.walletId,
    ]));
    expect(listed.every((wallet) => !('provider' in wallet)
      && !('providerWalletId' in wallet)
      && !('walletAddress' in wallet)
      && !('metadata' in wallet)
      && !('principalId' in wallet))).toBe(true);
    const fallbackRequest = authorizationRequest({ amount: '1000' });
    const fallback = await agent.authorizePayment(fallbackRequest);
    expect(fallback.walletId).toBe(second.wallet.walletId);
    await principal.releaseReservation(fallback.reservationId, 'E2E fallback reservation cleanup');

    // Explicit wallet selection, recipient/scope/asset/network, per-tx, and timeout controls.
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: first.wallet.walletId,
      amount: '501',
    })), 402, 'INSUFFICIENT_WALLET_FUNDS');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      amount: '5001',
    })), 402, 'PER_TRANSACTION_LIMIT_EXCEEDED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      recipient: 'merchant:blocked',
    })), 403, 'RECIPIENT_NOT_ALLOWED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      scope: 'commerce:refund',
    })), 403, 'SCOPE_NOT_ALLOWED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      scope: 'commerce:delete',
    })), 403, 'PAYMENT_SCOPE_NOT_GRANTED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      asset: 'EURC',
    })), 403, 'ASSET_OR_NETWORK_NOT_ALLOWED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      network: 'eip155:8453',
    })), 403, 'ASSET_OR_NETWORK_NOT_ALLOWED');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: second.wallet.walletId,
      maxTimeoutSeconds: 301,
    })), 400, 'INVALID_TIMEOUT');

    // Idempotency is agent/principal-wide and cannot drift to another wallet or payment.
    const idempotencyKey = randomUUID();
    const idempotentRequest = authorizationRequest({
      walletId: second.wallet.walletId,
      amount: '750',
      idempotencyKey,
    });
    const idempotentA = await agent.authorizePayment(idempotentRequest);
    const idempotentB = await agent.authorizePayment(idempotentRequest);
    expect(idempotentB.reservationId).toBe(idempotentA.reservationId);
    await expectApiError(agent.authorizePayment({ ...idempotentRequest, amount: '751' }), 409, 'IDEMPOTENCY_CONFLICT');
    await expectApiError(agent.authorizePayment({
      ...idempotentRequest,
      walletId: first.wallet.walletId,
    }), 409, 'IDEMPOTENCY_CONFLICT');

    // Official x402 v2 facilitator verify and settle are binding-exact and idempotent.
    const x402 = x402Envelope(idempotentA, idempotentRequest);
    expect(await facilitator('verify', x402)).toMatchObject({ isValid: true, payer: second.wallet.walletId });
    const mismatch = structuredClone(x402);
    mismatch.paymentRequirements.amount = '749';
    expect(await facilitator('verify', mismatch)).toMatchObject({
      isValid: false,
      invalidReason: 'PAYMENT_REQUIREMENTS_MISMATCH',
    });
    const bindingMutations: Array<(value: typeof x402) => void> = [
      (value) => { value.paymentRequirements.amount = value.paymentPayload.accepted.amount = '749'; },
      (value) => { value.paymentRequirements.asset = value.paymentPayload.accepted.asset = 'EURC'; },
      (value) => { value.paymentRequirements.network = value.paymentPayload.accepted.network = 'eip155:8453'; },
      (value) => { value.paymentRequirements.payTo = value.paymentPayload.accepted.payTo = 'merchant:other'; },
      (value) => { value.paymentRequirements.maxTimeoutSeconds = value.paymentPayload.accepted.maxTimeoutSeconds = 299; },
      (value) => {
        value.paymentRequirements.extra.grantexScope = 'commerce:refund';
        value.paymentPayload.accepted.extra.grantexScope = 'commerce:refund';
      },
      (value) => { value.paymentPayload.resource.url = 'https://merchant.example/items/other'; },
    ];
    for (const mutate of bindingMutations) {
      const changed = structuredClone(x402);
      mutate(changed);
      expect(await facilitator('verify', changed)).toMatchObject({ isValid: false });
    }
    const forged = structuredClone(x402);
    const originalAuthorization = forged.paymentPayload.payload.authorization;
    const forgedParts = originalAuthorization.split('.');
    const signature = forgedParts[2]!;
    forgedParts[2] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    forged.paymentPayload.payload.authorization = forgedParts.join('.');
    expect(await facilitator('verify', forged)).toMatchObject({
      isValid: false,
      invalidReason: 'INVALID_WALLET_AUTHORIZATION',
    });
    const settled = await facilitator('settle', x402);
    expect(settled).toMatchObject({ success: true, network: NETWORK, payer: second.wallet.walletId });
    expect(String(settled['transaction'])).toMatch(/^wtx_/);
    expect(await facilitator('settle', x402)).toEqual(settled);
    expect(await facilitator('verify', x402)).toMatchObject({
      isValid: false,
      invalidReason: 'RESERVATION_NOT_ACTIVE',
    });
    await expectApiError(agent.authorizePayment(idempotentRequest), 409, 'PAYMENT_ALREADY_SETTLED');

    // The published x402 fetch wrapper performs a real 402 -> PAYMENT-SIGNATURE -> settlement round trip.
    const transportWallet = await createWallet('Official x402 transport wallet', '5000');
    const merchantUrl = 'https://merchant.example/items/x402-e2e';
    const transportRequirements = {
      scheme: 'exact',
      network: NETWORK,
      amount: '1250',
      asset: ASSET,
      payTo: RECIPIENT,
      maxTimeoutSeconds: 120,
      extra: { grantexScope: SCOPE },
    };
    let merchantCalls = 0;
    const merchantFetch: typeof fetch = async (input, init) => {
      merchantCalls += 1;
      const request = input instanceof Request ? input : new Request(input, init);
      const signature = request.headers.get(HEADERS.PAYMENT_SIGNATURE);
      if (!signature) {
        return new Response(null, {
          status: 402,
          headers: {
            [HEADERS.PAYMENT_REQUIRED]: base64Json({
              x402Version: 2,
              resource: { url: merchantUrl, description: 'x402 E2E item', mimeType: 'application/json' },
              accepts: [transportRequirements],
            }),
          },
        });
      }
      const paymentPayload = fromBase64Json(signature);
      const envelope = {
        x402Version: 2,
        paymentPayload,
        paymentRequirements: transportRequirements,
      };
      const verified = await facilitator('verify', envelope);
      if (verified['isValid'] !== true) return Response.json(verified, { status: 402 });
      const settlement = await facilitator('settle', envelope);
      return Response.json({ purchased: true }, {
        status: 200,
        headers: { [HEADERS.PAYMENT_RESPONSE]: base64Json(settlement) },
      });
    };
    const x402Agent = createX402Agent({
      authorizePayment: agent.x402Authorizer,
      walletId: transportWallet.wallet.walletId,
      fetch: merchantFetch,
    });
    const merchantResponse = await x402Agent.fetch(merchantUrl, {
      idempotencyKey: 'merchant-order-x402-e2e-0001',
    });
    expect(merchantResponse.status).toBe(200);
    expect(await merchantResponse.json()).toEqual({ purchased: true });
    expect(merchantCalls).toBe(2);
    expect(fromBase64Json(merchantResponse.headers.get(HEADERS.PAYMENT_RESPONSE)!)).toMatchObject({
      success: true,
      network: NETWORK,
      payer: transportWallet.wallet.walletId,
    });
    expect((await principal.activity(transportWallet.wallet.walletId)).reservations).toEqual([
      expect.objectContaining({ status: 'settled', amount: '1250' }),
    ]);

    // Rolling cumulative policy counts both reservations and settlements atomically.
    const cumulative = await createWallet('Rolling cumulative wallet', '10000', {
      perTransactionLimit: '3000',
      cumulativeLimit: '5000',
    });
    const cumulativeA = await agent.authorizePayment(authorizationRequest({
      walletId: cumulative.wallet.walletId,
      amount: '3000',
    }));
    const cumulativeBRequest = authorizationRequest({
      walletId: cumulative.wallet.walletId,
      amount: '2000',
    });
    const cumulativeB = await agent.authorizePayment(cumulativeBRequest);
    expect(cumulativeB.remainingCumulative).toBe('0');
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: cumulative.wallet.walletId,
      amount: '1',
    })), 402, 'CUMULATIVE_LIMIT_EXCEEDED');
    await principal.releaseReservation(cumulativeA.reservationId, 'Cumulative reserve cleanup');
    await facilitator('settle', x402Envelope(cumulativeB, cumulativeBRequest));

    // The agent can request a reload only at/below the principal's threshold.
    const reload = await createWallet('Reload workflow wallet', '6000', {}, '2000');
    await expectApiError(agent.requestReload(reload.wallet.walletId, '5000', randomUUID(), 'Too early'), 409, 'RELOAD_NOT_AVAILABLE');
    const reloadSpendRequest = authorizationRequest({ walletId: reload.wallet.walletId, amount: '4000' });
    const reloadSpend = await agent.authorizePayment(reloadSpendRequest);
    await facilitator('settle', x402Envelope(reloadSpend, reloadSpendRequest));
    const reloadRequestKey = randomUUID();
    const requestA = await agent.requestReload(reload.wallet.walletId, '5000', reloadRequestKey, 'Balance is at the principal threshold');
    const requestB = await agent.requestReload(reload.wallet.walletId, '5000', reloadRequestKey, 'Balance is at the principal threshold');
    expect(requestB.reloadRequestId).toBe(requestA.reloadRequestId);
    await expectApiError(agent.requestReload(reload.wallet.walletId, '5001', reloadRequestKey, 'Balance is at the principal threshold'), 409, 'IDEMPOTENCY_CONFLICT');
    await expectApiError(agent.requestReload(reload.wallet.walletId, '5000', randomUUID(), 'Balance is at the principal threshold'), 409, 'RELOAD_REQUEST_CONFLICT');
    expect((await principal.decideReload(requestA.reloadRequestId, 'approved')).status).toBe('approved');
    expect((await principal.decideReload(requestA.reloadRequestId, 'approved')).status).toBe('approved');
    await expectApiError(principal.decideReload(requestA.reloadRequestId, 'rejected'), 409, 'RELOAD_DECISION_CONFLICT');
    const fundedA = await principal.fundReload(requestA.reloadRequestId);
    const fundedB = await principal.fundReload(requestA.reloadRequestId);
    expect(fundedB.reloadRequestId).toBe(fundedA.reloadRequestId);
    expect(fundedB.status).toBe('funded');
    expect((await agent.requestReload(
      reload.wallet.walletId,
      '5000',
      reloadRequestKey,
      'Balance is at the principal threshold',
    )).status).toBe('funded');
    const reloadAfterFunding = await principal.list();
    expect(reloadAfterFunding.find((wallet) => wallet.walletId === reload.wallet.walletId)?.availableAmount).toBe('7000');

    const rejectionWallet = await createWallet('Reload rejection wallet', '1000', {}, '1000');
    const rejectedRequest = await agent.requestReload(rejectionWallet.wallet.walletId, '1000', randomUUID(), 'Ask principal');
    expect((await principal.decideReload(rejectedRequest.reloadRequestId, 'rejected')).status).toBe('rejected');
    await expectApiError(principal.fundReload(rejectedRequest.reloadRequestId), 409, 'RELOAD_NOT_APPROVED');

    const terminal = await createWallet('Terminal assignment revocation wallet', '1000');
    expect((await principal.setAssignmentStatus(terminal.assignment.assignmentId, 'revoked', 'Permanent removal')).status).toBe('revoked');
    await expectApiError(principal.assign(terminal.wallet.walletId, {
      agentId,
      perTransactionLimit: '1000',
      cumulativeLimit: '5000',
      cumulativePeriodSeconds: 3600,
    }), 409, 'ASSIGNMENT_REVOKED');
    await expectApiError(principal.setAssignmentStatus(terminal.assignment.assignmentId, 'active'), 409, 'ASSIGNMENT_REVOKED');

    const validity = await createWallet('Expiring assignment wallet', '1000', {
      validUntil: new Date(Date.now() + 1_000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expectApiError(agent.authorizePayment(authorizationRequest({
      walletId: validity.wallet.walletId,
      amount: '1',
    })), 403, 'ASSIGNMENT_NOT_CURRENT');

    const policyUpdate = await createWallet('Policy update release wallet', '2000');
    await agent.authorizePayment(authorizationRequest({ walletId: policyUpdate.wallet.walletId, amount: '500' }));
    await principal.assign(policyUpdate.wallet.walletId, {
      agentId,
      perTransactionLimit: '250',
      cumulativeLimit: '1000',
      cumulativePeriodSeconds: 3600,
      allowedRecipients: [RECIPIENT],
      allowedScopes: [SCOPE],
    });
    expect((await principal.activity(policyUpdate.wallet.walletId)).reservations).toEqual([
      expect.objectContaining({ status: 'released', release_reason: 'assignment_policy_updated' }),
    ]);

    // A principal can release, block one assignment, block one wallet, or block every wallet.
    const controls = await createWallet('Principal control wallet', '10000');
    const held = await agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId }));
    expect((await principal.setAssignmentStatus(controls.assignment.assignmentId, 'blocked', 'Agent assignment paused')).status).toBe('blocked');
    expect((await facilitator('verify', x402Envelope(held, authorizationRequest({
      walletId: controls.wallet.walletId,
      amount: held.amount,
      idempotencyKey: 'not-used-for-facilitator-binding',
    }))))).toMatchObject({ isValid: false });
    await expectApiError(agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId })), 403, 'WALLET_BLOCKED');
    await principal.setAssignmentStatus(controls.assignment.assignmentId, 'active');

    const walletHold = await agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId }));
    await principal.setWalletStatus(controls.wallet.walletId, 'blocked', 'Wallet paused');
    expect((await facilitator('verify', x402Envelope(walletHold, authorizationRequest({
      walletId: controls.wallet.walletId,
      amount: walletHold.amount,
      idempotencyKey: 'not-used-for-facilitator-binding',
    }))))).toMatchObject({ isValid: false });
    await principal.setWalletStatus(controls.wallet.walletId, 'active');

    const globalHold = await agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId }));
    expect((await principal.setAgentBlocked(agentId, true, 'Emergency global stop')).allWalletsBlocked).toBe(true);
    expect((await facilitator('verify', x402Envelope(globalHold, authorizationRequest({
      walletId: controls.wallet.walletId,
      amount: globalHold.amount,
      idempotencyKey: 'not-used-for-facilitator-binding',
    }))))).toMatchObject({ isValid: false });
    await expectApiError(agent.authorizePayment(authorizationRequest({ walletId: second.wallet.walletId })), 403, 'WALLET_BLOCKED');
    expect((await principal.setAgentBlocked(agentId, false)).allWalletsBlocked).toBe(false);

    const manualRelease = await agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId }));
    expect(await principal.releaseReservation(manualRelease.reservationId, 'Principal cancelled purchase')).toEqual({
      reservationId: manualRelease.reservationId,
      status: 'released',
    });
    expect(await facilitator('verify', x402Envelope(manualRelease, authorizationRequest({
      walletId: controls.wallet.walletId,
      amount: manualRelease.amount,
      idempotencyKey: 'not-used-for-facilitator-binding',
    })))).toMatchObject({ isValid: false, invalidReason: 'RESERVATION_NOT_ACTIVE' });

    const closed = await createWallet('Terminal closed wallet', '1000');
    await agent.authorizePayment(authorizationRequest({ walletId: closed.wallet.walletId, amount: '100' }));
    expect((await principal.setWalletStatus(closed.wallet.walletId, 'closed', 'Retired wallet')).status).toBe('closed');
    await expectApiError(principal.setWalletStatus(closed.wallet.walletId, 'active'), 409, 'WALLET_CLOSED');
    await expectApiError(agent.authorizePayment(authorizationRequest({ walletId: closed.wallet.walletId, amount: '1' })), 403, 'WALLET_BLOCKED');

    // Expired reservations fail closed and their funds return on the next wallet operation.
    const expiryRequest = authorizationRequest({
      walletId: controls.wallet.walletId,
      amount: '500',
      maxTimeoutSeconds: 1,
    });
    const expiring = await agent.authorizePayment(expiryRequest);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(await facilitator('verify', x402Envelope(expiring, expiryRequest))).toMatchObject({
      isValid: false,
      invalidReason: 'INVALID_WALLET_AUTHORIZATION',
    });
    await agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId, amount: '1' }));

    // Concurrent authorizations cannot overrun the balance or rolling cumulative cap.
    const concurrent = await createWallet('Concurrent spend wallet', '10000', {
      perTransactionLimit: '1000',
      cumulativeLimit: '5000',
    });
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => agent.authorizePayment(
      authorizationRequest({ walletId: concurrent.wallet.walletId, amount: '1000' }),
    )));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
    const failures = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(failures).toHaveLength(5);
    expect(failures.every((failure) => (failure.reason as { code?: string }).code === 'CUMULATIVE_LIMIT_EXCEEDED')).toBe(true);
    await principal.setWalletStatus(concurrent.wallet.walletId, 'blocked', 'Release concurrent E2E holds');
    const concurrentActivity = await principal.activity(concurrent.wallet.walletId);
    expect(concurrentActivity.reservations.filter((item) => item['status'] === 'released')).toHaveLength(5);

    // A global principal block serializes with in-flight reservations and drains every hold.
    const blockRace = await createWallet('Global block race wallet', '10000', {
      perTransactionLimit: '1000',
      cumulativeLimit: '10000',
    });
    const blockRaceAuthorizations = Array.from({ length: 10 }, () => agent.authorizePayment(
      authorizationRequest({ walletId: blockRace.wallet.walletId, amount: '1000' }),
    ));
    const [, blockResult] = await Promise.all([
      Promise.allSettled(blockRaceAuthorizations),
      principal.setAgentBlocked(agentId, true, 'Concurrent emergency stop'),
    ]);
    expect(blockResult.allWalletsBlocked).toBe(true);
    const blockRaceActivity = await principal.activity(blockRace.wallet.walletId);
    expect(blockRaceActivity.reservations.some((item) => item['status'] === 'reserved')).toBe(false);
    expect(blockRaceActivity.reservations.every((item) => item['status'] === 'released'
      && item['release_reason'] === 'agent_all_wallets_blocked')).toBe(true);
    expect((await principal.list()).find((wallet) => wallet.walletId === blockRace.wallet.walletId)?.availableAmount).toBe('10000');
    await principal.setAgentBlocked(agentId, false);

    // External-custody records are representable but fail closed without an adapter.
    const external = await principal.create({
      name: 'External provider wallet',
      custodyMode: 'external',
      provider: 'example-provider',
      providerWalletId: `provider-${randomUUID()}`,
      network: NETWORK,
      asset: ASSET,
      decimals: 6,
    });
    await expectApiError(principal.create({
      name: 'Duplicate external provider wallet',
      custodyMode: 'external',
      provider: 'example-provider',
      providerWalletId: external.providerWalletId!,
      network: NETWORK,
      asset: ASSET,
    }), 409, 'PROVIDER_WALLET_EXISTS');
    await principal.assign(external.walletId, {
      agentId,
      perTransactionLimit: '1000',
      cumulativeLimit: '5000',
      cumulativePeriodSeconds: 3600,
      allowedRecipients: [RECIPIENT],
      allowedScopes: [SCOPE],
    });
    await expectApiError(principal.reload(external.walletId, '1000', randomUUID(), 'provider-credit-1'), 503, 'CUSTODY_ADAPTER_UNAVAILABLE');
    await expectApiError(agent.authorizePayment(authorizationRequest({ walletId: external.walletId })), 503, 'CUSTODY_ADAPTER_UNAVAILABLE');

    // Activity is durable and links reloads, reservations, settlements, releases, and policy state.
    const activity = await principal.activity(reload.wallet.walletId);
    expect(activity.assignments).toHaveLength(1);
    expect(activity.reloadRequests.some((item) => item.status === 'funded')).toBe(true);
    expect(activity.reservations.some((item) => item['status'] === 'settled')).toBe(true);
    expect(activity.ledger.some((item) => item['entry_type'] === 'credit')).toBe(true);
    expect(activity.ledger.some((item) => item['entry_type'] === 'settlement')).toBe(true);

    // A second principal using the same registered agent cannot see or spend the first principal's wallets.
    const otherPrincipalId = `principal-wallet-isolation-${Date.now()}`;
    const otherPending = await oauth.beginAuthorization({
      scopes: ['wallet:read', 'wallet:spend', SCOPE],
      principalHint: otherPrincipalId,
    });
    const otherApproval = await fetch(otherPending.authorizationUrl, { redirect: 'manual' });
    const otherCallback = otherApproval.headers.get('location');
    expect(otherApproval.status).toBe(303);
    expect(otherCallback).toBeTruthy();
    const otherTokens = await oauth.completeAuthorization(otherCallback!);
    const otherSessionResponse = await developerApi('/v1/principal-sessions', {
      method: 'POST',
      body: JSON.stringify({ principalId: otherPrincipalId, expiresIn: '1h' }),
    });
    const otherSession = await responseJson<{ sessionToken: string }>(otherSessionResponse);
    const otherPrincipal = new PrincipalPrepaidWalletClient({ baseUrl: BASE_URL, sessionToken: otherSession.sessionToken });
    const otherAgent = new PrepaidWalletAgentClient({ oauthClient: oauth, accessToken: otherTokens.access_token });
    expect(await otherPrincipal.list()).toEqual([]);
    await expectApiError(otherPrincipal.activity(reload.wallet.walletId), 404, 'WALLET_NOT_FOUND');
    expect(await otherAgent.list()).toEqual([]);
    await expectApiError(otherAgent.authorizePayment(authorizationRequest({
      walletId: reload.wallet.walletId,
      amount: '1',
    })), 404, 'NO_ASSIGNED_WALLET');

    // Suspending the agent blocks wallet use even while its grant remains active.
    expect((await responseJson<{ status: string }>(await developerApi(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'suspended' }),
    }))).status).toBe('suspended');
    await expectApiError(agent.authorizePayment(authorizationRequest({ walletId: controls.wallet.walletId })), 401, 'INVALID_TOKEN');
    expect((await responseJson<{ status: string }>(await developerApi(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    }))).status).toBe('active');

    // Revocation serializes against in-flight authorizations and leaves no reservation behind.
    const revocationWallet = await createWallet('Grant revocation release wallet', '5000');
    await agent.authorizePayment(authorizationRequest({ walletId: revocationWallet.wallet.walletId, amount: '1000' }));
    const grantResponse = await fetch(`${BASE_URL}/v1/principal/grants`, {
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    const grants = await responseJson<{ grants: Array<{ grantId: string; agentId: string }> }>(grantResponse);
    const activeGrant = grants.grants.find((grant) => grant.agentId === agentId);
    expect(activeGrant).toBeTruthy();
    const racingAuthorizations = Array.from({ length: 10 }, () => agent.authorizePayment(authorizationRequest({
      walletId: revocationWallet.wallet.walletId,
      amount: '100',
    })));
    const revokePromise = fetch(`${BASE_URL}/v1/principal/grants/${encodeURIComponent(activeGrant!.grantId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
    });
    const [, revokeResult] = await Promise.all([
      Promise.allSettled(racingAuthorizations),
      revokePromise,
    ]);
    const revokeResponse = revokeResult;
    expect(revokeResponse.status).toBe(204);
    const revocationActivity = await principal.activity(revocationWallet.wallet.walletId);
    expect(revocationActivity.reservations.length).toBeGreaterThanOrEqual(1);
    expect(revocationActivity.reservations.every((item) => item['status'] === 'released'
      && item['release_reason'] === 'oauth_grant_revoked')).toBe(true);
    expect((await principal.list()).find((wallet) => wallet.walletId === revocationWallet.wallet.walletId)?.availableAmount).toBe('5000');

    const deleteResponse = await developerApi(`/v1/agents/${agentId}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(409);
    expect(await deleteResponse.json()).toMatchObject({ code: 'AGENT_HAS_FINANCIAL_HISTORY' });
  }, 180_000);
});

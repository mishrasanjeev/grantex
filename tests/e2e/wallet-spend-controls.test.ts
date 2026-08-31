import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateOAuthAgentKey,
  OAuthAgentClient,
  PrepaidWalletAgentClient,
  PrincipalPrepaidWalletClient,
  type PrepaidAuthorization,
  type PrepaidAuthorizationRequest,
  type PrepaidApprovalRequired,
} from '@grantex/sdk';

const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ISSUER = (process.env.E2E_ISSUER ?? BASE_URL).replace(/\/$/, '');
const RESOURCE = `${ISSUER}/v1/prepaid-wallets`;
const NETWORK = 'grantex:prepaid';
const ASSET = 'USDC';
const SCOPE = 'commerce:pay';
const ORIGIN = 'https://merchant.example';
const ALT_ORIGIN = 'https://merchant-alt.example';
const RECIPIENT = 'merchant:approved';

let apiKey = '';
const agentIds: string[] = [];

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as T;
}

async function developer(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

async function expectError<T>(promise: Promise<T>, status: number, code: string) {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    const value = error as Error & { status?: number; code?: string };
    expect(value.status, value.message).toBe(status);
    expect(value.code, value.message).toBe(code);
  }
}

async function agentFor(principalId: string, ordinal: number) {
  const key = await generateOAuthAgentKey();
  const redirectUri = `https://wallet-policy-e2e.example/callback/${ordinal}`;
  const registration = await developer('/v1/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: `Layered Wallet Agent ${ordinal}`,
      description: 'Disposable layered wallet policy E2E agent',
      scopes: ['wallet:read', 'wallet:spend', 'wallet:reload:request', SCOPE],
      redirectUris: [redirectUri],
      resourceServers: [RESOURCE],
      publicJwk: key.publicJwk,
    }),
  });
  const agentId = (await json<{ agentId: string }>(registration)).agentId;
  agentIds.push(agentId);
  const oauth = await OAuthAgentClient.create({
    issuer: ISSUER, clientId: agentId, redirectUri, resource: RESOURCE,
    privateKey: key.privateKey, publicJwk: key.publicJwk, allowInsecureLoopback: true,
  });
  const pending = await oauth.beginAuthorization({
    scopes: ['wallet:read', 'wallet:spend', 'wallet:reload:request', SCOPE], principalHint: principalId,
  });
  const approval = await fetch(pending.authorizationUrl, { redirect: 'manual' });
  expect(approval.status).toBe(303);
  const callback = approval.headers.get('location');
  expect(callback).toBeTruthy();
  const tokens = await oauth.completeAuthorization(callback!);
  return {
    agentId,
    client: new PrepaidWalletAgentClient({ oauthClient: oauth, accessToken: tokens.access_token }),
  };
}

function payment(overrides: Partial<PrepaidAuthorizationRequest> = {}): PrepaidAuthorizationRequest {
  return {
    amount: '1000', asset: ASSET, network: NETWORK, recipient: RECIPIENT,
    resource: `${ORIGIN}/pay`, scope: SCOPE, maxTimeoutSeconds: 300,
    idempotencyKey: randomUUID(), merchantId: 'org_merchant', purpose: 'software',
    projectId: 'project-7', costCenter: 'engineering', ...overrides,
  };
}

function authorized(value: PrepaidAuthorization | PrepaidApprovalRequired): PrepaidAuthorization {
  if ('status' in value) throw new Error(`Unexpected approval request ${value.approvalRequestId}`);
  return value;
}

function approvalRequired(value: PrepaidAuthorization | PrepaidApprovalRequired): PrepaidApprovalRequired {
  if (!('status' in value)) throw new Error('Expected principal approval');
  return value;
}

function envelope(authorization: PrepaidAuthorization, request: PrepaidAuthorizationRequest) {
  const requirements = {
    scheme: 'exact', network: NETWORK, amount: request.amount, asset: request.asset,
    payTo: request.recipient, maxTimeoutSeconds: request.maxTimeoutSeconds,
    extra: {
      grantexScope: request.scope,
      grantexContext: {
        merchantId: request.merchantId,
        purpose: request.purpose,
        projectId: request.projectId,
        costCenter: request.costCenter,
      },
    },
  };
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: request.resource, description: 'Layered policy E2E', mimeType: 'application/json' },
      accepted: requirements,
      payload: { authorization: authorization.authorization },
    },
    paymentRequirements: requirements,
  };
}

async function settle(authorization: PrepaidAuthorization, request: PrepaidAuthorizationRequest) {
  return json<Record<string, unknown>>(await fetch(`${BASE_URL}/v1/x402/settle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope(authorization, request)),
  }));
}

afterAll(async () => {
  await Promise.all(agentIds.map((agentId) => developer(`/v1/agents/${agentId}`, { method: 'DELETE' }).catch(() => undefined)));
});

describe('layered agent prepaid-wallet governance E2E', () => {
  it('enforces organization, principal, group, wallet, assignment, approval, reload, and audit controls', async () => {
    const signup = await fetch(`${BASE_URL}/v1/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `wallet-policy-e2e-${Date.now()}`, mode: 'sandbox' }),
    });
    apiKey = (await json<{ apiKey: string }>(signup)).apiKey;
    const principalId = `principal-layered-wallet-${Date.now()}`;
    const first = await agentFor(principalId, 1);
    const second = await agentFor(principalId, 2);
    const session = await json<{ sessionToken: string }>(await developer('/v1/principal-sessions', {
      method: 'POST', body: JSON.stringify({ principalId, expiresIn: '1h' }),
    }));
    const principal = new PrincipalPrepaidWalletClient({ baseUrl: BASE_URL, sessionToken: session.sessionToken });

    const governed = await principal.create({
      name: 'Cross-agent governed wallet', custodyMode: 'sandbox_ledger', network: NETWORK, asset: ASSET,
      maxBalance: '100000', maxReloadAmount: '50000', reloadCumulativeLimit: '80000',
      reloadPeriodSeconds: 3600, reloadCountLimit: 2,
    });
    await expectError(principal.reload(governed.walletId, '50001', randomUUID()), 409, 'WALLET_RELOAD_AMOUNT_EXCEEDED');
    await principal.reload(governed.walletId, '40000', randomUUID());
    await principal.reload(governed.walletId, '40000', randomUUID());
    await expectError(principal.reload(governed.walletId, '1', randomUUID()), 409, 'WALLET_RELOAD_CUMULATIVE_LIMIT_EXCEEDED');

    const maxBalance = await principal.create({
      name: 'Maximum balance wallet', custodyMode: 'sandbox_ledger', network: NETWORK, asset: ASSET,
      maxBalance: '5000',
    });
    await principal.reload(maxBalance.walletId, '5000', randomUUID());
    await expectError(principal.reload(maxBalance.walletId, '1', randomUUID()), 409, 'WALLET_MAX_BALANCE_EXCEEDED');
    const countLimited = await principal.create({
      name: 'Reload velocity wallet', custodyMode: 'sandbox_ledger', network: NETWORK, asset: ASSET,
      reloadCountLimit: 2, reloadPeriodSeconds: 3600,
    });
    await principal.reload(countLimited.walletId, '1', randomUUID());
    await principal.reload(countLimited.walletId, '1', randomUUID());
    await expectError(principal.reload(countLimited.walletId, '1', randomUUID()), 409, 'WALLET_RELOAD_COUNT_LIMIT_EXCEEDED');

    await expectError(principal.assign(governed.walletId, {
      agentId: first.agentId, perTransactionLimit: '10000', cumulativeLimit: '100000', cumulativePeriodSeconds: 3600,
    }), 400, 'RECIPIENT_POLICY_REQUIRED');
    for (const agent of [first, second]) {
      await principal.assign(governed.walletId, {
        agentId: agent.agentId, perTransactionLimit: '10000', cumulativeLimit: '100000',
        cumulativePeriodSeconds: 3600, allowedRecipients: [RECIPIENT], allowedScopes: [SCOPE],
        allowedResourceOrigins: [ORIGIN], budgetGroup: 'engineering-team',
      });
    }

    const groupPolicy = await json<{ policyId: string }>(await developer('/v1/prepaid-wallet-spend-policies', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Engineering lifetime approval threshold', scopeType: 'group', scopeId: 'engineering-team',
        effect: 'limit', maxAmount: '5000', windowType: 'lifetime', onExceed: 'require_approval',
        assets: [ASSET], networks: [NETWORK], actionScopes: [SCOPE],
      }),
    }));
    expect(groupPolicy.policyId).toMatch(/^wspol_/);
    const firstRequest = payment({ walletId: governed.walletId, amount: '3000' });
    const firstAuthorization = authorized(await first.client.authorizePayment(firstRequest));
    const secondRequest = payment({ walletId: governed.walletId, amount: '2500' });
    const challenge = approvalRequired(await second.client.authorizePayment(secondRequest));
    expect(challenge.policyIds).toContain(groupPolicy.policyId);
    const approvals = await principal.listPaymentApprovals();
    expect(approvals).toEqual(expect.arrayContaining([
      expect.objectContaining({ approvalRequestId: challenge.approvalRequestId, status: 'pending', amount: '2500' }),
    ]));
    await principal.decidePaymentApproval(challenge.approvalRequestId, 'approved', 'Cross-agent budget owner approved');
    await expectError(second.client.authorizePayment({
      ...secondRequest, amount: '2400', idempotencyKey: randomUUID(),
      approvalRequestId: challenge.approvalRequestId,
    }), 409, 'PAYMENT_APPROVAL_INVALID');
    const secondAuthorization = authorized(await second.client.authorizePayment({
      ...secondRequest, approvalRequestId: challenge.approvalRequestId,
    }));
    await settle(firstAuthorization, firstRequest);
    await settle(secondAuthorization, secondRequest);
    expect((await principal.listPaymentApprovals()).find((item) => item.approvalRequestId === challenge.approvalRequestId)?.status).toBe('consumed');

    const filtered = await principal.create({
      name: 'Filtered policy wallet', custodyMode: 'sandbox_ledger', network: NETWORK, asset: ASSET,
    });
    await principal.reload(filtered.walletId, '10000', randomUUID());
    const filteredAssignment = await principal.assign(filtered.walletId, {
      agentId: first.agentId, perTransactionLimit: '10000', cumulativeLimit: '100000', cumulativePeriodSeconds: 3600,
      allowedRecipients: [RECIPIENT, 'merchant:blocked'], allowedScopes: [SCOPE], allowedResourceOrigins: [ORIGIN, ALT_ORIGIN],
    });
    const broadPolicies = [
      await principal.createSpendPolicy({
        name: 'Assignment safety ceiling', scopeType: 'assignment', scopeId: filteredAssignment.assignmentId,
        effect: 'limit', maxAmount: '10000', windowType: 'per_authorization',
      }),
      await principal.createSpendPolicy({
        name: 'Agent daily ceiling', scopeType: 'agent', scopeId: first.agentId,
        effect: 'limit', maxAmount: '100000', windowType: 'calendar_day',
      }),
      await principal.createSpendPolicy({
        name: 'Principal monthly ceiling', scopeType: 'principal',
        effect: 'limit', maxAmount: '1000000', windowType: 'calendar_month',
      }),
      await json<{ policyId: string }>(await developer('/v1/prepaid-wallet-spend-policies', {
        method: 'POST', body: JSON.stringify({
          name: 'Developer weekly ceiling', scopeType: 'developer', effect: 'limit',
          maxAmount: '10000000', windowType: 'calendar_week',
        }),
      })),
    ];
    expect(broadPolicies.map((policy) => policy.policyId)).toHaveLength(4);
    const denyPolicy = await principal.createSpendPolicy({
      name: 'Block one merchant recipient', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'deny', recipients: ['merchant:blocked'],
    });
    await expectError(first.client.authorizePayment(payment({
      walletId: filtered.walletId, recipient: 'merchant:blocked',
    })), 402, 'LAYERED_SPEND_POLICY_DENIED');
    const merchantPolicy = await principal.createSpendPolicy({
      name: 'Verified merchant required', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'limit', maxAmount: '100000', windowType: 'lifetime', requireVerifiedMerchant: true,
      recipients: [RECIPIENT],
    });
    await expectError(first.client.authorizePayment(payment({ walletId: filtered.walletId })), 402, 'LAYERED_SPEND_POLICY_DENIED');
    await principal.setSpendPolicyStatus(merchantPolicy.policyId, 'disabled');

    const perAuthorizationPolicy = await principal.createSpendPolicy({
      name: 'Independent per-payment ceiling', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'limit', maxAmount: '1500', windowType: 'per_authorization',
    });
    for (let index = 0; index < 2; index += 1) {
      const request = payment({ walletId: filtered.walletId, amount: '1000' });
      await settle(authorized(await first.client.authorizePayment(request)), request);
    }
    await expectError(first.client.authorizePayment(payment({
      walletId: filtered.walletId, amount: '1501',
    })), 402, 'LAYERED_SPEND_POLICY_DENIED');

    const rollingCountPolicy = await principal.createSpendPolicy({
      name: 'Two payments per rolling window', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'limit', maxCount: 2, windowType: 'rolling', windowSeconds: 3600,
    });
    await expectError(first.client.authorizePayment(payment({
      walletId: filtered.walletId, amount: '1000',
    })), 402, 'LAYERED_SPEND_POLICY_DENIED');
    await principal.setSpendPolicyStatus(rollingCountPolicy.policyId, 'disabled');
    await principal.setSpendPolicyStatus(perAuthorizationPolicy.policyId, 'disabled');

    const originPolicy = await principal.createSpendPolicy({
      name: 'Merchant-origin rolling ceiling', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'limit', maxAmount: '1500', windowType: 'rolling', windowSeconds: 3600,
      resourceOrigins: [ALT_ORIGIN],
    });
    const primaryOriginRequest = payment({ walletId: filtered.walletId, amount: '1000' });
    await settle(authorized(await first.client.authorizePayment(primaryOriginRequest)), primaryOriginRequest);
    const alternateOriginRequest = payment({
      walletId: filtered.walletId, amount: '1000', resource: `${ALT_ORIGIN}/x402/weather`,
    });
    await settle(authorized(await first.client.authorizePayment(alternateOriginRequest)), alternateOriginRequest);
    await expectError(first.client.authorizePayment(payment({
      walletId: filtered.walletId, amount: '501', resource: `${ALT_ORIGIN}/x402/weather`,
    })), 402, 'LAYERED_SPEND_POLICY_DENIED');
    await principal.setSpendPolicyStatus(originPolicy.policyId, 'disabled');

    const concurrencyPolicy = await principal.createSpendPolicy({
      name: 'One parallel authorization per rolling window', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'limit', maxCount: 1, windowType: 'rolling', windowSeconds: 3600,
      purposes: ['parallel-control'],
    });
    const parallelRequests = [
      payment({ walletId: filtered.walletId, amount: '100', purpose: 'parallel-control' }),
      payment({ walletId: filtered.walletId, amount: '100', purpose: 'parallel-control' }),
    ];
    const parallelResults = await Promise.allSettled(
      parallelRequests.map((request) => first.client.authorizePayment(request)),
    );
    const parallelSuccesses = parallelResults
      .map((result, index) => ({ result, index }))
      .filter((item): item is { result: PromiseFulfilledResult<PrepaidAuthorization | PrepaidApprovalRequired>; index: number } => item.result.status === 'fulfilled');
    const parallelFailures = parallelResults.filter((result) => result.status === 'rejected');
    expect(parallelSuccesses).toHaveLength(1);
    expect(parallelFailures).toHaveLength(1);
    const parallelFailure = parallelFailures[0] as PromiseRejectedResult;
    expect(parallelFailure.reason).toMatchObject({ status: 402, code: 'LAYERED_SPEND_POLICY_DENIED' });
    const parallelSuccess = parallelSuccesses[0]!;
    await settle(authorized(parallelSuccess.result.value), parallelRequests[parallelSuccess.index]!);
    await principal.setSpendPolicyStatus(concurrencyPolicy.policyId, 'disabled');

    const approvalPolicyA = await principal.createSpendPolicy({
      name: 'Policy-change approval A', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'require_approval', purposes: ['policy-change-control'],
    });
    const policyChangeRequest = payment({
      walletId: filtered.walletId, amount: '100', purpose: 'policy-change-control',
    });
    const approvalA = approvalRequired(await first.client.authorizePayment(policyChangeRequest));
    expect(approvalA.policyIds).toEqual([approvalPolicyA.policyId]);
    await principal.decidePaymentApproval(approvalA.approvalRequestId, 'approved');
    const approvalPolicyB = await principal.createSpendPolicy({
      name: 'Policy-change approval B', scopeType: 'wallet', scopeId: filtered.walletId,
      effect: 'require_approval', purposes: ['policy-change-control'],
    });
    const approvalB = approvalRequired(await first.client.authorizePayment({
      ...policyChangeRequest, approvalRequestId: approvalA.approvalRequestId,
    }));
    expect(approvalB.approvalRequestId).not.toBe(approvalA.approvalRequestId);
    expect(new Set(approvalB.policyIds)).toEqual(new Set([approvalPolicyA.policyId, approvalPolicyB.policyId]));
    expect((await principal.listPaymentApprovals()).find(
      (item) => item.approvalRequestId === approvalA.approvalRequestId,
    )).toMatchObject({ status: 'expired', reason: 'Spend policy requirements changed before authorization' });
    await principal.decidePaymentApproval(approvalB.approvalRequestId, 'approved');
    const policyChangeAuthorization = authorized(await first.client.authorizePayment({
      ...policyChangeRequest, approvalRequestId: approvalB.approvalRequestId,
    }));
    await settle(policyChangeAuthorization, policyChangeRequest);
    await principal.setSpendPolicyStatus(approvalPolicyA.policyId, 'disabled');
    await principal.setSpendPolicyStatus(approvalPolicyB.policyId, 'disabled');

    const boundRequest = payment({ walletId: filtered.walletId, amount: '1000' });
    const boundAuthorization = authorized(await first.client.authorizePayment(boundRequest));
    const tampered = envelope(boundAuthorization, { ...boundRequest, purpose: 'hardware' });
    const verify = await json<{ isValid: boolean; invalidReason: string }>(await fetch(`${BASE_URL}/v1/x402/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tampered),
    }));
    expect(verify).toMatchObject({ isValid: false, invalidReason: 'PAYMENT_REQUIREMENTS_MISMATCH' });

    await expectError(principal.createSpendPolicy({
      name: 'Forbidden organization policy', scopeType: 'developer', effect: 'deny',
    }), 403, 'SPEND_POLICY_SCOPE_FORBIDDEN');
    await principal.setSpendPolicyStatus(denyPolicy.policyId, 'disabled');
    const activity = await principal.activity(filtered.walletId);
    expect(activity.policyDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'denied' }),
      expect.objectContaining({ decision: 'allowed' }),
    ]));
    expect(activity.paymentApprovals).toBeDefined();
    expect(activity.reservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: boundAuthorization.reservationId, status: 'released', release_reason: 'layered_spend_policy_changed' }),
    ]));
    expect(await settle(boundAuthorization, boundRequest)).toMatchObject({
      success: false,
      errorReason: 'RESERVATION_NOT_ACTIVE',
    });
  }, 240_000);
});

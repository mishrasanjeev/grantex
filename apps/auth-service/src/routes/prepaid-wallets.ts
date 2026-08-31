import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { checkActiveOAuthAccessToken } from '../lib/active-grant-token.js';
import { DpopError, verifyDpopProof } from '../lib/dpop.js';
import { emitEvent, type EventType } from '../lib/events.js';
import {
  PrepaidWalletError,
  applyWalletSpendPolicyMutation,
  assignWallet,
  createPrepaidWallet,
  createPrincipalReload,
  decideReloadRequest,
  fundApprovedReload,
  listAgentWallets,
  listPrincipalWallets,
  listWalletActivity,
  releaseExpiredWalletReservations,
  releaseReservationByPrincipal,
  requestWalletReload,
  reserveWalletPayment,
  setAgentWalletBlock,
  setAssignmentStatus,
  setWalletStatus,
  settleWalletPayment,
  verifyWalletPayment,
  type AgentWalletIdentity,
  type PaymentRequirementsBinding,
} from '../lib/prepaid-wallet.js';
import { requirePrincipalSession, type AuthenticatedPrincipal } from '../lib/principal-auth.js';
import {
  WalletSpendPolicyError,
  createWalletSpendPolicy,
  decideWalletPaymentApproval,
  listWalletPaymentApprovals,
  listWalletSpendPolicies,
  setWalletSpendPolicyStatus,
  type WalletSpendPolicyInput,
} from '../lib/wallet-spend-policy.js';

const OAUTH_PROTOCOL = 'oauth-agent-grants-03';
const WALLET_RESOURCE_PATH = '/v1/prepaid-wallets';
const X402_VERSION = 2;
const X402_SCHEME = 'exact';
const X402_NETWORK = 'grantex:prepaid';

type Body = Record<string, unknown>;

async function notify(developerId: string, type: EventType, data: Record<string, unknown>) {
  await emitEvent(developerId, type, data).catch(() => undefined);
}

function endpoint(path: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, '')}${path}`;
}

function requestTarget(request: FastifyRequest): string {
  return endpoint(request.url.split('?')[0] ?? request.url);
}

function sendWalletError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof PrepaidWalletError) {
    return reply.status(error.statusCode).send({
      message: error.message,
      code: error.code,
      requestId: request.id,
    });
  }
  if (error instanceof WalletSpendPolicyError) {
    return reply.status(error.statusCode).send({
      message: error.message,
      code: error.code,
      requestId: request.id,
    });
  }
  if (error instanceof DpopError) {
    reply.header('WWW-Authenticate', 'DPoP error="invalid_dpop_proof"');
    return reply.status(401).send({
      message: error.message,
      code: 'INVALID_DPOP_PROOF',
      requestId: request.id,
    });
  }
  throw error;
}

async function agentIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AgentWalletIdentity | null> {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string'
    ? /^DPoP[ \t]+([^\s]+)$/.exec(authorization)
    : null;
  if (!match) {
    reply.header('WWW-Authenticate', 'DPoP error="invalid_token"');
    await reply.status(401).send({
      message: 'Use a DPoP-bound OAuth access token',
      code: 'INVALID_TOKEN',
      requestId: request.id,
    });
    return null;
  }

  const accessToken = match[1]!;
  try {
    const proof = await verifyDpopProof(request.headers.dpop, {
      method: request.method,
      targetUri: requestTarget(request),
      accessToken,
    });
    const checked = await checkActiveOAuthAccessToken(accessToken, OAUTH_PROTOCOL);
    if (!checked.ok) {
      throw new PrepaidWalletError(401, 'INVALID_TOKEN', 'The access token is invalid, expired, or revoked');
    }
    if (checked.claims.aud !== endpoint(WALLET_RESOURCE_PATH)) {
      throw new PrepaidWalletError(401, 'INVALID_TOKEN_AUDIENCE', 'The access token audience does not identify the prepaid-wallet resource');
    }
    if (checked.claims.cnf.jkt !== proof.thumbprint) {
      throw new PrepaidWalletError(401, 'DPOP_KEY_MISMATCH', 'The DPoP key does not match the access token binding');
    }

    const rows = await getSql()`
      SELECT g.developer_id, g.principal_id, g.agent_id
      FROM grants g
      JOIN agents a ON a.id = g.agent_id AND a.developer_id = g.developer_id
      WHERE g.id = ${checked.grantId}
        AND g.principal_id = ${checked.claims.sub}
        AND g.agent_id = ${checked.claims.clientId}
        AND g.status = 'active'
        AND g.expires_at > NOW()
        AND a.status = 'active'
      LIMIT 1
    `;
    const grant = rows[0];
    if (!grant) {
      throw new PrepaidWalletError(401, 'INVALID_TOKEN', 'The access token grant is no longer active');
    }
    return {
      developerId: grant['developer_id'] as string,
      principalId: grant['principal_id'] as string,
      agentId: grant['agent_id'] as string,
      grantId: checked.grantId,
      accessTokenJti: checked.claims.jti,
      scopes: checked.claims.scopes,
    };
  } catch (error) {
    sendWalletError(reply, request, error);
    return null;
  }
}

async function principal(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthenticatedPrincipal | null> {
  return requirePrincipalSession(request, reply);
}

function requiredString(body: Body | null | undefined, name: string): string {
  const value = body?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} is required`);
  }
  return value;
}

function optionalString(body: Body | null | undefined, name: string): string | undefined {
  const value = body?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} must be a string`);
  }
  return value;
}

function optionalBoolean(body: Body | null | undefined, name: string): boolean | undefined {
  const value = body?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} must be a boolean`);
  }
  return value;
}

function optionalNumber(body: Body | null | undefined, name: string): number | undefined {
  const value = body?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} must be a finite number`);
  }
  return value;
}

function optionalStringArray(body: Body | null | undefined, name: string): string[] | undefined {
  const value = body?.[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} must be a string array`);
  }
  return value as string[];
}

function spendPolicyInput(body: Body): WalletSpendPolicyInput {
  const optionalLists = [
    'recipients', 'resourceOrigins', 'actionScopes', 'assets', 'networks',
    'merchantIds', 'purposes', 'projectIds', 'costCenters',
  ] as const;
  const input: WalletSpendPolicyInput = {
    name: requiredString(body, 'name'),
    scopeType: requiredString(body, 'scopeType') as WalletSpendPolicyInput['scopeType'],
    effect: requiredString(body, 'effect') as WalletSpendPolicyInput['effect'],
  };
  const optionalStrings = ['description', 'scopeId', 'onExceed', 'maxAmount', 'windowType', 'validFrom', 'validUntil'] as const;
  for (const key of optionalStrings) {
    const value = optionalString(body, key);
    if (value !== undefined) Object.assign(input, { [key]: value });
  }
  for (const key of optionalLists) {
    const value = optionalStringArray(body, key);
    if (value !== undefined) Object.assign(input, { [key]: value });
  }
  const maxCount = optionalNumber(body, 'maxCount');
  const windowSeconds = optionalNumber(body, 'windowSeconds');
  const priority = optionalNumber(body, 'priority');
  const requireVerifiedMerchant = optionalBoolean(body, 'requireVerifiedMerchant');
  if (maxCount !== undefined) input.maxCount = maxCount;
  if (windowSeconds !== undefined) input.windowSeconds = windowSeconds;
  if (priority !== undefined) input.priority = priority;
  if (requireVerifiedMerchant !== undefined) input.requireVerifiedMerchant = requireVerifiedMerchant;
  return input;
}

function record(value: unknown, name: string): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${name} must be an object`);
  }
  return value as Body;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Body;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function x402Binding(value: unknown): { token: string; binding: PaymentRequirementsBinding } {
  const body = record(value, 'request');
  const payload = record(body['paymentPayload'], 'paymentPayload');
  const requirements = record(body['paymentRequirements'], 'paymentRequirements');
  const accepted = record(payload['accepted'], 'paymentPayload.accepted');
  if (body['x402Version'] !== X402_VERSION
      || payload['x402Version'] !== X402_VERSION
      || stableJson(accepted) !== stableJson(requirements)) {
    throw new PrepaidWalletError(400, 'PAYMENT_REQUIREMENTS_MISMATCH', 'The accepted payment requirements must exactly match the supplied x402 v2 requirements');
  }
  if (requirements['scheme'] !== X402_SCHEME || requirements['network'] !== X402_NETWORK) {
    throw new PrepaidWalletError(400, 'UNSUPPORTED_PAYMENT_SCHEME', 'Only exact payments on grantex:prepaid are supported');
  }
  const resource = record(payload['resource'], 'paymentPayload.resource');
  const schemePayload = record(payload['payload'], 'paymentPayload.payload');
  const extra = record(requirements['extra'], 'paymentRequirements.extra');
  const context = extra['grantexContext'] === undefined
    ? {}
    : record(extra['grantexContext'], 'paymentRequirements.extra.grantexContext');
  const merchantId = optionalString(context, 'merchantId');
  const purpose = optionalString(context, 'purpose');
  const projectId = optionalString(context, 'projectId');
  const costCenter = optionalString(context, 'costCenter');
  return {
    token: requiredString(schemePayload, 'authorization'),
    binding: {
      amount: requiredString(requirements, 'amount'),
      asset: requiredString(requirements, 'asset'),
      network: requiredString(requirements, 'network'),
      recipient: requiredString(requirements, 'payTo'),
      resource: requiredString(resource, 'url'),
      scope: requiredString(extra, 'grantexScope'),
      maxTimeoutSeconds: requirements['maxTimeoutSeconds'] as number,
      ...(merchantId !== undefined ? { merchantId } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(costCenter !== undefined ? { costCenter } : {}),
    },
  };
}

export async function prepaidWalletRoutes(app: FastifyInstance): Promise<void> {
  let expirySweep: ReturnType<typeof setInterval> | undefined;
  if (process.env['NODE_ENV'] !== 'test') {
    app.addHook('onReady', async () => {
      await releaseExpiredWalletReservations(getSql());
      expirySweep = setInterval(() => {
        releaseExpiredWalletReservations(getSql()).catch((error: unknown) => {
          app.log.error({ err: error }, 'prepaid wallet expiry sweep failed');
        });
      }, 30_000);
      expirySweep.unref();
    });
    app.addHook('onClose', async () => {
      if (expirySweep) clearInterval(expirySweep);
    });
  }

  const principalConfig = { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const agentConfig = { config: { skipAuth: true, rateLimit: { max: 240, timeWindow: '1 minute' } } };

  app.post<{ Body: Body }>('/v1/principal/prepaid-wallets', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const provider = optionalString(request.body, 'provider');
      const providerWalletId = optionalString(request.body, 'providerWalletId');
      const walletAddress = optionalString(request.body, 'walletAddress');
      const lowBalanceThreshold = optionalString(request.body, 'lowBalanceThreshold');
      const maxBalance = optionalString(request.body, 'maxBalance');
      const maxReloadAmount = optionalString(request.body, 'maxReloadAmount');
      const reloadCumulativeLimit = optionalString(request.body, 'reloadCumulativeLimit');
      const reloadPeriodSeconds = optionalNumber(request.body, 'reloadPeriodSeconds');
      const reloadCountLimit = optionalNumber(request.body, 'reloadCountLimit');
      const wallet = await createPrepaidWallet(getSql(), owner, {
        name: requiredString(request.body, 'name'),
        custodyMode: requiredString(request.body, 'custodyMode') as 'sandbox_ledger' | 'external',
        network: requiredString(request.body, 'network'),
        asset: requiredString(request.body, 'asset'),
        ...(provider !== undefined ? { provider } : {}),
        ...(providerWalletId !== undefined ? { providerWalletId } : {}),
        ...(walletAddress !== undefined ? { walletAddress } : {}),
        ...(request.body['decimals'] !== undefined ? { decimals: request.body['decimals'] as number } : {}),
        ...(lowBalanceThreshold !== undefined ? { lowBalanceThreshold } : {}),
        ...(maxBalance !== undefined ? { maxBalance } : {}),
        ...(maxReloadAmount !== undefined ? { maxReloadAmount } : {}),
        ...(reloadCumulativeLimit !== undefined ? { reloadCumulativeLimit } : {}),
        ...(reloadPeriodSeconds !== undefined ? { reloadPeriodSeconds } : {}),
        ...(reloadCountLimit !== undefined ? { reloadCountLimit } : {}),
        ...(request.body['metadata'] !== undefined ? { metadata: record(request.body['metadata'], 'metadata') } : {}),
      });
      return reply.status(201).send(wallet);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/principal/prepaid-wallets', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send({ wallets: await listPrincipalWallets(getSql(), owner) });
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get<{ Params: { walletId: string } }>('/v1/principal/prepaid-wallets/:walletId/activity', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send(await listWalletActivity(getSql(), owner, request.params.walletId));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { walletId: string }; Body: Body }>('/v1/principal/prepaid-wallets/:walletId/assignments', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const validUntil = optionalString(request.body, 'validUntil');
      const allowAnyRecipient = optionalBoolean(request.body, 'allowAnyRecipient');
      const allowAnyScope = optionalBoolean(request.body, 'allowAnyScope');
      const allowAnyResource = optionalBoolean(request.body, 'allowAnyResource');
      const budgetGroup = optionalString(request.body, 'budgetGroup');
      const assignment = await assignWallet(getSql(), owner, {
        walletId: request.params.walletId,
        agentId: requiredString(request.body, 'agentId'),
        perTransactionLimit: requiredString(request.body, 'perTransactionLimit'),
        cumulativeLimit: requiredString(request.body, 'cumulativeLimit'),
        cumulativePeriodSeconds: request.body['cumulativePeriodSeconds'] as number,
        ...(request.body['allowedRecipients'] !== undefined ? { allowedRecipients: request.body['allowedRecipients'] as string[] } : {}),
        ...(request.body['allowedScopes'] !== undefined ? { allowedScopes: request.body['allowedScopes'] as string[] } : {}),
        ...(request.body['allowedResourceOrigins'] !== undefined ? { allowedResourceOrigins: request.body['allowedResourceOrigins'] as string[] } : {}),
        ...(allowAnyRecipient !== undefined ? { allowAnyRecipient } : {}),
        ...(allowAnyScope !== undefined ? { allowAnyScope } : {}),
        ...(allowAnyResource !== undefined ? { allowAnyResource } : {}),
        ...(budgetGroup !== undefined ? { budgetGroup } : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
      });
      return reply.status(201).send(assignment);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.patch<{ Params: { assignmentId: string }; Body: Body }>('/v1/principal/prepaid-wallet-assignments/:assignmentId', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const status = requiredString(request.body, 'status');
      if (!['active', 'blocked', 'revoked'].includes(status)) {
        throw new PrepaidWalletError(400, 'INVALID_STATUS', 'status must be active, blocked, or revoked');
      }
      return reply.send(await setAssignmentStatus(getSql(), owner, request.params.assignmentId, status as 'active' | 'blocked' | 'revoked', optionalString(request.body, 'reason')));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.patch<{ Params: { walletId: string }; Body: Body }>('/v1/principal/prepaid-wallets/:walletId/status', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const status = requiredString(request.body, 'status');
      if (!['active', 'blocked', 'closed'].includes(status)) {
        throw new PrepaidWalletError(400, 'INVALID_STATUS', 'status must be active, blocked, or closed');
      }
      return reply.send(await setWalletStatus(getSql(), owner, request.params.walletId, status as 'active' | 'blocked' | 'closed', optionalString(request.body, 'reason')));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.put<{ Params: { agentId: string }; Body: Body }>('/v1/principal/prepaid-wallet-agents/:agentId/block', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      if (typeof request.body?.['blocked'] !== 'boolean') {
        throw new PrepaidWalletError(400, 'INVALID_REQUEST', 'blocked must be a boolean');
      }
      return reply.send(await setAgentWalletBlock(getSql(), owner, request.params.agentId, request.body['blocked'], optionalString(request.body, 'reason')));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { walletId: string }; Body: Body }>('/v1/principal/prepaid-wallets/:walletId/reloads', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.status(201).send(await createPrincipalReload(
        getSql(),
        owner,
        request.params.walletId,
        requiredString(request.body, 'amount'),
        requiredString(request.body, 'idempotencyKey'),
        optionalString(request.body, 'externalReference'),
      ));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { requestId: string }; Body: Body }>('/v1/principal/prepaid-wallet-reload-requests/:requestId/decision', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const decision = requiredString(request.body, 'decision');
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new PrepaidWalletError(400, 'INVALID_DECISION', 'decision must be approved or rejected');
      }
      return reply.send(await decideReloadRequest(getSql(), owner, request.params.requestId, decision));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { requestId: string }; Body: Body }>('/v1/principal/prepaid-wallet-reload-requests/:requestId/fund', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send(await fundApprovedReload(getSql(), owner, request.params.requestId, optionalString(request.body, 'externalReference')));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { reservationId: string }; Body: Body }>('/v1/principal/prepaid-wallet-reservations/:reservationId/release', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send(await releaseReservationByPrincipal(getSql(), owner, request.params.reservationId, requiredString(request.body, 'reason')));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Body: Body }>('/v1/principal/prepaid-wallet-spend-policies', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const policy = await applyWalletSpendPolicyMutation(
        getSql(), owner, (tx) => createWalletSpendPolicy(tx, owner, spendPolicyInput(request.body)),
      );
      await notify(owner.developerId, 'wallet.spend_policy.changed', {
        policyId: policy.policyId, principalId: owner.principalId, status: policy.status, action: 'created',
      });
      return reply.status(201).send(policy);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/principal/prepaid-wallet-spend-policies', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send({ policies: await listWalletSpendPolicies(getSql(), owner) });
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.patch<{ Params: { policyId: string }; Body: Body }>('/v1/principal/prepaid-wallet-spend-policies/:policyId/status', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const policy = await applyWalletSpendPolicyMutation(
        getSql(), owner, (tx) => setWalletSpendPolicyStatus(
          tx, owner, request.params.policyId,
          requiredString(request.body, 'status') as 'active' | 'disabled' | 'revoked',
        ),
      );
      await notify(owner.developerId, 'wallet.spend_policy.changed', {
        policyId: policy.policyId, principalId: owner.principalId, status: policy.status, action: 'status_changed',
      });
      return reply.send(policy);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/principal/prepaid-wallet-payment-approvals', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      return reply.send({ approvals: await listWalletPaymentApprovals(getSql(), owner) });
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { approvalRequestId: string }; Body: Body }>('/v1/principal/prepaid-wallet-payment-approvals/:approvalRequestId/decision', principalConfig, async (request, reply) => {
    const owner = await principal(request, reply);
    if (!owner) return;
    try {
      const decision = requiredString(request.body, 'decision');
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new PrepaidWalletError(400, 'INVALID_DECISION', 'decision must be approved or rejected');
      }
      const approval = await decideWalletPaymentApproval(
        getSql(), owner, request.params.approvalRequestId, decision, optionalString(request.body, 'reason'),
      );
      await notify(owner.developerId, decision === 'approved'
        ? 'wallet.payment.approval_approved'
        : 'wallet.payment.approval_rejected', {
        approvalRequestId: approval.approvalRequestId,
        walletId: approval.walletId,
        agentId: approval.agentId,
        principalId: owner.principalId,
      });
      return reply.send(approval);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Body: Body }>('/v1/prepaid-wallet-spend-policies', async (request, reply) => {
    const actor = { developerId: request.developer.id, principalId: null };
    try {
      const policy = await applyWalletSpendPolicyMutation(
        getSql(), actor, (tx) => createWalletSpendPolicy(tx, actor, spendPolicyInput(request.body)),
      );
      await notify(actor.developerId, 'wallet.spend_policy.changed', {
        policyId: policy.policyId, status: policy.status, action: 'created', scope: 'developer',
      });
      return reply.status(201).send(policy);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/prepaid-wallet-spend-policies', async (request, reply) => {
    try {
      return reply.send({ policies: await listWalletSpendPolicies(getSql(), { developerId: request.developer.id, principalId: null }) });
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.patch<{ Params: { policyId: string }; Body: Body }>('/v1/prepaid-wallet-spend-policies/:policyId/status', async (request, reply) => {
    const actor = { developerId: request.developer.id, principalId: null };
    try {
      const policy = await applyWalletSpendPolicyMutation(
        getSql(), actor, (tx) => setWalletSpendPolicyStatus(
          tx, actor, request.params.policyId,
          requiredString(request.body, 'status') as 'active' | 'disabled' | 'revoked',
        ),
      );
      await notify(actor.developerId, 'wallet.spend_policy.changed', {
        policyId: policy.policyId, status: policy.status, action: 'status_changed', scope: 'developer',
      });
      return reply.send(policy);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/prepaid-wallets', agentConfig, async (request, reply) => {
    const identity = await agentIdentity(request, reply);
    if (!identity) return;
    try {
      return reply.send({ wallets: await listAgentWallets(getSql(), identity) });
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Body: Body }>('/v1/prepaid-wallets/authorizations', agentConfig, async (request, reply) => {
    const identity = await agentIdentity(request, reply);
    if (!identity) return;
    try {
      const walletId = optionalString(request.body, 'walletId');
      const approvalRequestId = optionalString(request.body, 'approvalRequestId');
      const merchantId = optionalString(request.body, 'merchantId');
      const purpose = optionalString(request.body, 'purpose');
      const projectId = optionalString(request.body, 'projectId');
      const costCenter = optionalString(request.body, 'costCenter');
      const authorization = await reserveWalletPayment(getSql(), identity, {
        ...(walletId !== undefined ? { walletId } : {}),
        amount: requiredString(request.body, 'amount'),
        asset: requiredString(request.body, 'asset'),
        network: requiredString(request.body, 'network'),
        recipient: requiredString(request.body, 'recipient'),
        resource: requiredString(request.body, 'resource'),
        scope: requiredString(request.body, 'scope'),
        maxTimeoutSeconds: request.body['maxTimeoutSeconds'] as number,
        idempotencyKey: requiredString(request.body, 'idempotencyKey'),
        ...(approvalRequestId !== undefined ? { approvalRequestId } : {}),
        ...(merchantId !== undefined ? { merchantId } : {}),
        ...(purpose !== undefined ? { purpose } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(costCenter !== undefined ? { costCenter } : {}),
      });
      return reply.status('status' in authorization ? 202 : 201).send(authorization);
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Params: { walletId: string }; Body: Body }>('/v1/prepaid-wallets/:walletId/reload-requests', agentConfig, async (request, reply) => {
    const identity = await agentIdentity(request, reply);
    if (!identity) return;
    try {
      return reply.status(201).send(await requestWalletReload(
        getSql(),
        identity,
        request.params.walletId,
        requiredString(request.body, 'amount'),
        requiredString(request.body, 'idempotencyKey'),
        optionalString(request.body, 'reason'),
      ));
    } catch (error) {
      return sendWalletError(reply, request, error);
    }
  });

  app.get('/v1/x402/supported', { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (_request, reply) => {
    return reply.send({ kinds: [{ x402Version: X402_VERSION, scheme: X402_SCHEME, network: X402_NETWORK }] });
  });

  app.post<{ Body: Body }>('/v1/x402/verify', agentConfig, async (request, reply) => {
    try {
      const { token, binding } = x402Binding(request.body);
      const verified = await verifyWalletPayment(getSql(), token, binding);
      return reply.send({ isValid: true, payer: verified.payer });
    } catch (error) {
      if (error instanceof PrepaidWalletError) {
        return reply.send({ isValid: false, invalidReason: error.code });
      }
      return sendWalletError(reply, request, error);
    }
  });

  app.post<{ Body: Body }>('/v1/x402/settle', agentConfig, async (request, reply) => {
    try {
      const { token, binding } = x402Binding(request.body);
      const settled = await settleWalletPayment(getSql(), token, binding);
      return reply.send({
        success: true,
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer,
      });
    } catch (error) {
      if (error instanceof PrepaidWalletError) {
        return reply.send({
          success: false,
          errorReason: error.code,
          transaction: '',
          network: X402_NETWORK,
        });
      }
      return sendWalletError(reply, request, error);
    }
  });
}

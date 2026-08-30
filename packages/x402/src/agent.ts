/**
 * Official x402 v2 fetch integration for Grantex-managed prepaid wallets.
 *
 * The scheme never fabricates a payment proof. It asks the Grantex
 * authorization service to reserve real prepaid balance, then places the
 * returned signed authorization in the standard PAYMENT-SIGNATURE payload.
 */

import { randomUUID } from 'node:crypto';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  ResourceInfo,
  SchemeNetworkClient,
} from '@x402/core/types';

export const GRANTEX_PREPAID_NETWORK = 'grantex:prepaid' as Network;
export const GRANTEX_PREPAID_SCHEME = 'exact';

/** Canonical x402 v2 HTTP headers. */
export const HEADERS = {
  PAYMENT_REQUIRED: 'PAYMENT-REQUIRED',
  PAYMENT_SIGNATURE: 'PAYMENT-SIGNATURE',
  PAYMENT_RESPONSE: 'PAYMENT-RESPONSE',
} as const;

export interface PrepaidAuthorizationRequest {
  walletId?: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  resource: string;
  scope: string;
  maxTimeoutSeconds: number;
  idempotencyKey: string;
}

export interface PrepaidAuthorizationResponse {
  authorization: string;
  reservationId: string;
  walletId: string;
  expiresAt: string;
  remainingAvailable: string;
  remainingCumulative: string;
}

export interface X402AgentConfig {
  /**
   * Reserve prepaid funds and return a server-signed one-time authorization.
   * Use OAuthAgentClient.fetch() when calling the Grantex endpoint so this
   * operation is protected by the agent's DPoP-bound OAuth token.
   */
  authorizePayment: (request: PrepaidAuthorizationRequest) => Promise<PrepaidAuthorizationResponse>;
  /** Pin payments to one assigned wallet. Omit to let Grantex choose an eligible wallet. */
  walletId?: string;
  /** Native fetch implementation, injectable for tests and non-browser runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface X402FetchOptions extends RequestInit {
  /** Pin this request to one assigned wallet, overriding the config default. */
  walletId?: string;
  /**
   * Stable key for recovering the same reservation after a caller/network
   * response loss. Reuse it only for an identical logical payment.
   */
  idempotencyKey?: string;
}

interface PaymentCreationContext {
  paymentRequired: PaymentRequired;
  selectedRequirements: PaymentRequirements;
}

class GrantexPrepaidScheme implements SchemeNetworkClient {
  readonly scheme = GRANTEX_PREPAID_SCHEME;
  readonly #resources = new WeakMap<object, ResourceInfo>();

  readonly schemeHooks = {
    onBeforePaymentCreation: async (context: PaymentCreationContext) => {
      this.#resources.set(context.selectedRequirements, context.paymentRequired.resource);
    },
  };

  constructor(
    private readonly authorizePayment: X402AgentConfig['authorizePayment'],
    private readonly walletId?: string,
    private readonly idempotencyKey?: string,
  ) {}

  async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
    if (x402Version !== 2) throw new Error('Grantex prepaid wallets require x402 v2');
    if (requirements.scheme !== GRANTEX_PREPAID_SCHEME
        || requirements.network !== GRANTEX_PREPAID_NETWORK) {
      throw new Error('Unsupported Grantex prepaid payment requirements');
    }
    if (!/^\d+$/.test(requirements.amount) || requirements.amount === '0') {
      throw new Error('x402 amount must be a positive integer string in atomic units');
    }
    if (!Number.isSafeInteger(requirements.maxTimeoutSeconds)
        || requirements.maxTimeoutSeconds < 1 || requirements.maxTimeoutSeconds > 300) {
      throw new Error('Grantex prepaid maxTimeoutSeconds must be between 1 and 300');
    }
    const extra = requirements.extra;
    const scope = extra && typeof extra['grantexScope'] === 'string'
      ? extra['grantexScope']
      : undefined;
    if (!scope) throw new Error('x402 requirements must include extra.grantexScope');
    const resource = this.#resources.get(requirements)?.url;
    if (!resource) throw new Error('x402 resource URL is unavailable during payment creation');

    const authorization = await this.authorizePayment({
      ...(this.walletId ? { walletId: this.walletId } : {}),
      amount: requirements.amount,
      asset: requirements.asset,
      network: requirements.network,
      recipient: requirements.payTo,
      resource,
      scope,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      idempotencyKey: this.idempotencyKey ?? randomUUID(),
    });
    if (!authorization || typeof authorization.authorization !== 'string'
        || authorization.authorization.length === 0) {
      throw new Error('Grantex authorization service returned an invalid wallet authorization');
    }
    return {
      x402Version: 2,
      payload: { authorization: authorization.authorization },
    };
  }
}

function prepaidClient(
  authorizePayment: X402AgentConfig['authorizePayment'],
  walletId?: string,
  idempotencyKey?: string,
) {
  if (idempotencyKey !== undefined
      && (idempotencyKey.trim().length < 16 || idempotencyKey.length > 256)) {
    throw new Error('x402 idempotencyKey must contain 16 to 256 characters');
  }
  // Asset and amount policy is enforced atomically by the Grantex wallet
  // authorization service. The generic x402 client's static $1/default-asset
  // cap cannot represent per-assignment rolling policies, so it is disabled
  // only for this registered network and replaced by the server decision.
  return new x402Client()
    .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false })
    .register(
      GRANTEX_PREPAID_NETWORK,
      new GrantexPrepaidScheme(authorizePayment, walletId, idempotencyKey),
    );
}

/** Build a fetch-compatible x402 v2 client backed by a Grantex prepaid wallet. */
export function createX402Agent(config: X402AgentConfig) {
  if (!config || typeof config.authorizePayment !== 'function') {
    throw new Error('createX402Agent requires authorizePayment; fake payment proofs are not supported');
  }
  const client = prepaidClient(config.authorizePayment, config.walletId);
  const paymentFetch = wrapFetchWithPayment(config.fetch ?? globalThis.fetch, client);

  return {
    client,
    fetch(input: RequestInfo | URL, options: X402FetchOptions = {}) {
      const { walletId, idempotencyKey, ...requestInit } = options;
      if (idempotencyKey !== undefined || (walletId !== undefined && walletId !== config.walletId)) {
        const requestClient = prepaidClient(config.authorizePayment, walletId ?? config.walletId, idempotencyKey);
        return wrapFetchWithPayment(config.fetch ?? globalThis.fetch, requestClient)(input, requestInit);
      }
      return paymentFetch(input, requestInit);
    },
  };
}

/** Convenience wrapper returning only the payment-enabled fetch function. */
export function x402AgentFetch(config: X402AgentConfig) {
  return createX402Agent(config).fetch;
}

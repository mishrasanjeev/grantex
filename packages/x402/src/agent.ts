/**
 * x402 Agent — fetch wrapper that handles HTTP 402 → pay → retry with GDT authorization.
 *
 * Drop-in replacement for fetch() that:
 * 1. Attaches X-Grantex-GDT header with the delegation token
 * 2. Handles 402 Payment Required responses
 * 3. Extracts payment details from the 402 response
 * 4. Pays via the configured payment handler (Base L2 stub by default)
 * 5. Retries the request with payment proof + GDT
 */

import { getAuditLog } from './audit.js';
import type { X402AgentConfig, X402FetchOptions, X402PaymentDetails } from './types.js';

/** Header names used in the x402 + GDT flow. */
export const HEADERS = {
  GDT: 'X-Grantex-GDT',
  PAYMENT_REQUIRED: 'X-Payment-Required',
  PAYMENT_PROOF: 'X-Payment-Proof',
  PAYMENT_AMOUNT: 'X-Payment-Amount',
  PAYMENT_CURRENCY: 'X-Payment-Currency',
  PAYMENT_CHAIN: 'X-Payment-Chain',
  PAYMENT_RECIPIENT: 'X-Payment-Recipient',
} as const;

/**
 * Default stub payment handler.
 * In production, this would sign a Base L2 USDC transfer.
 * Returns a mock payment proof string.
 */
async function stubPaymentHandler(details: X402PaymentDetails): Promise<string> {
  // Simulate payment processing
  const proof = {
    txHash: `0x${randomHex(64)}`,
    chain: details.chain,
    amount: details.amount,
    currency: details.currency,
    recipient: details.recipientAddress,
    timestamp: Date.now(),
    ...(details.memo !== undefined ? { memo: details.memo } : {}),
  };
  return Buffer.from(JSON.stringify(proof)).toString('base64url');
}

/**
 * Parse x402 payment details from a 402 response.
 */
function parsePaymentDetails(response: Response): X402PaymentDetails {
  // Try JSON body first, fall back to headers
  const amount = parseFloat(
    response.headers.get(HEADERS.PAYMENT_AMOUNT) ?? '0',
  );
  const currency = (response.headers.get(HEADERS.PAYMENT_CURRENCY) ?? 'USDC') as 'USDC' | 'USDT';
  const recipientAddress = response.headers.get(HEADERS.PAYMENT_RECIPIENT) ?? '';
  const chain = response.headers.get(HEADERS.PAYMENT_CHAIN) ?? 'base';
  const memo = response.headers.get('X-Payment-Memo') ?? undefined;

  if (!recipientAddress) {
    throw new Error('402 response missing X-Payment-Recipient header');
  }

  return { amount, currency, recipientAddress, chain, ...(memo !== undefined ? { memo } : {}) };
}

/**
 * Create an x402 agent with a configured GDT and payment handler.
 *
 * @example
 * ```ts
 * const agent = createX402Agent({
 *   gdt: gdtToken,
 *   paymentHandler: async (details) => {
 *     // Sign and submit Base L2 USDC transfer
 *     return paymentProof;
 *   },
 * });
 *
 * const response = await agent.fetch('https://api.weather.xyz/forecast');
 * ```
 */
export function createX402Agent(config: X402AgentConfig = {}) {
  const paymentHandler = config.paymentHandler ?? stubPaymentHandler;

  /**
   * Fetch a URL with x402 payment and GDT authorization handling.
   */
  async function x402Fetch(url: string | URL, options: X402FetchOptions = {}): Promise<Response> {
    const gdt = options.gdt ?? config.gdt;

    // Build headers
    const headers = new Headers(options.headers);
    if (gdt) {
      headers.set(HEADERS.GDT, gdt);
    }

    // Initial request
    const response = await fetch(url, { ...options, headers });

    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }

    // Parse payment details from 402 response
    let paymentDetails: X402PaymentDetails;
    try {
      // Try to parse from JSON body first
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = await response.json() as Record<string, unknown>;
        paymentDetails = {
          amount: (body['amount'] as number) ?? 0,
          currency: ((body['currency'] as string) ?? 'USDC') as 'USDC' | 'USDT',
          recipientAddress: (body['recipientAddress'] as string) ?? '',
          chain: (body['chain'] as string) ?? 'base',
          ...(body['memo'] !== undefined ? { memo: body['memo'] as string } : {}),
        };

        if (!paymentDetails.recipientAddress) {
          paymentDetails = parsePaymentDetails(response);
        }
      } else {
        paymentDetails = parsePaymentDetails(response);
      }
    } catch {
      paymentDetails = parsePaymentDetails(response);
    }

    // Log payment event
    try {
      const auditLog = getAuditLog();
      await auditLog.log({
        eventType: 'payment',
        agentDID: '',
        principalDID: '',
        scope: [],
        tokenId: '',
        details: {
          url: url.toString(),
          amount: paymentDetails.amount,
          currency: paymentDetails.currency,
          chain: paymentDetails.chain,
          recipient: paymentDetails.recipientAddress,
        },
      });
    } catch {
      // Audit logging should never break the payment flow
    }

    // Execute payment
    const paymentProof = await paymentHandler(paymentDetails);

    // Retry with payment proof + GDT
    const retryHeaders = new Headers(options.headers);
    if (gdt) {
      retryHeaders.set(HEADERS.GDT, gdt);
    }
    retryHeaders.set(HEADERS.PAYMENT_PROOF, paymentProof);

    return fetch(url, { ...options, headers: retryHeaders });
  }

  return { fetch: x402Fetch };
}

/**
 * Convenience: create an agent and return its fetch function directly.
 *
 * @example
 * ```ts
 * const x402Fetch = x402AgentFetch({ gdt: token });
 * const res = await x402Fetch('https://api.example.com/data');
 * ```
 */
export function x402AgentFetch(config: X402AgentConfig = {}) {
  return createX402Agent(config).fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

/**
 * x402 settlement receipts, read from a paid response and shaped for
 * Grantex OACP commitment evidence.
 *
 * x402 v2 returns the facilitator's SettlementResponse base64-encoded in the
 * `PAYMENT-RESPONSE` header (`{success, transaction, network, payer,
 * errorReason?}`); v1 used `X-PAYMENT-RESPONSE`. `readSettlementResponse`
 * reads either. `settlementReceiptEvidence` builds the `receipt` member of
 * `POST /v1/commerce/oacp/commitment-evidence/settlement-receipts`, which
 * binds a successful settlement to a commitment as a signed
 * `commitment_evidence` artifact. Neither form is signed; Grantex records it
 * as reported, not verified.
 */
import { decodePaymentResponseHeader } from '@x402/core/http';
import { HEADERS } from './agent.js';

export const X402_V1_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export interface X402SettlementReceipt {
  x402Version: 1 | 2;
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

function headerOf(source: Response | Headers | Record<string, string | undefined>, name: string): string | null {
  if (typeof Headers !== 'undefined' && source instanceof Headers) return source.get(name);
  if (typeof Response !== 'undefined' && source instanceof Response) return source.headers.get(name);
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(source)) if (key.toLowerCase() === lower && typeof value === 'string') return value;
  return null;
}

function normalise(value: unknown, version: 1 | 2): X402SettlementReceipt {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || typeof v['success'] !== 'boolean'
      || typeof v['transaction'] !== 'string' || typeof v['network'] !== 'string') {
    throw new Error('x402 payment response is not a SettlementResponse {success, transaction, network}');
  }
  return {
    x402Version: version,
    success: v['success'],
    transaction: v['transaction'],
    network: v['network'],
    ...(typeof v['payer'] === 'string' ? { payer: v['payer'] } : {}),
    ...(typeof v['errorReason'] === 'string' ? { errorReason: v['errorReason'] } : {}),
  };
}

/** The settlement receipt of a paid response (v2 PAYMENT-RESPONSE, else v1 X-PAYMENT-RESPONSE), or null. */
export function readSettlementResponse(source: Response | Headers | Record<string, string | undefined>): X402SettlementReceipt | null {
  const v2 = headerOf(source, HEADERS.PAYMENT_RESPONSE);
  if (v2 !== null) return normalise(decodePaymentResponseHeader(v2), 2);
  const v1 = headerOf(source, X402_V1_PAYMENT_RESPONSE_HEADER);
  if (v1 !== null) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(v1, 'base64').toString('utf8'));
    } catch {
      throw new Error('X-PAYMENT-RESPONSE is not base64 JSON');
    }
    return normalise(decoded, 1);
  }
  return null;
}

/**
 * The `receipt` member Grantex binds into commitment evidence. Refuses a
 * failed settlement: only a successful one is evidence of a commitment.
 * `gdtJti` names the Grantex delegation token that authorized the payment.
 */
export function settlementReceiptEvidence(receipt: X402SettlementReceipt, options: { gdtJti?: string } = {}) {
  if (!receipt.success) throw new Error('only a successful x402 settlement is bound as commitment evidence');
  return {
    protocol: 'x402' as const,
    x402_version: receipt.x402Version,
    settlement: {
      success: true as const,
      transaction: receipt.transaction,
      network: receipt.network,
      ...(receipt.payer !== undefined ? { payer: receipt.payer } : {}),
    },
    ...(options.gdtJti !== undefined ? { gdt_jti: options.gdtJti } : {}),
  };
}

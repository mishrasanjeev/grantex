// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Settlement receipts bound into OACP `commitment_evidence` artifacts (G59).
 *
 * A relying party that saw a payment settle over an HTTP 402 flow posts the
 * receipt it received; Grantex issues a signed `commitment_evidence`
 * artifact that names the commitment, the artifacts it relied on, and a
 * reference to the receipt. Two receipt forms are read:
 *
 *   x402   the SettlementResponse of the PAYMENT-RESPONSE header (x402 v2,
 *          base64 JSON `{success, transaction, network, payer, errorReason?}`;
 *          v1 sends the same object in X-PAYMENT-RESPONSE). The Grantex
 *          prepaid wallet answers settlements in this shape, and a GDT
 *          (Grantex delegation token) that authorized the payment can be
 *          named by its `jti`.
 *   mpp    the Payment-Receipt of the "Payment" HTTP authentication scheme
 *          (draft-ryan-httpauth-payment-01 section 5.3): base64url JSON
 *          `{status: "success", method, timestamp, reference}`.
 *
 * Only a successful settlement is bound. Neither receipt form is signed, so
 * Grantex cannot verify one: the artifact says so
 * (`receipt_verification: "reported_not_verified_by_grantex"`) and carries
 * the receipt's SHA-256 over its RFC 8785 form, the network or method, and
 * the transaction or reference, never the payer. A commitment_evidence
 * artifact is evidence, never execution authority: Grantex executes nothing
 * here.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../evidence/canonical.js';

export const SETTLEMENT_RECEIPT_COMMITMENT_TYPE = 'settlement_receipt_reference';
export const RECEIPT_VERIFICATION = 'reported_not_verified_by_grantex';

export class SettlementReceiptError extends Error {
  constructor(readonly code: 'settlement_receipt_invalid' | 'settlement_not_successful', message: string) {
    super(message);
    this.name = 'SettlementReceiptError';
  }
}

export type SettlementReceipt =
  | {
      protocol: 'x402';
      x402_version: 1 | 2;
      settlement: { success: true; transaction: string; network: string; payer?: string | undefined };
      gdt_jti?: string | undefined;
    }
  | {
      protocol: 'mpp';
      receipt: { status: 'success'; method: string; timestamp: string; reference: string };
    };

/** What the artifact carries about the receipt: public-safe, no payer. */
export interface SettlementReceiptRef {
  protocol: 'x402' | 'mpp';
  /** `sha-256:` and the base64url SHA-256 of the RFC 8785 receipt. */
  receipt_hash: string;
  receipt_verification: typeof RECEIPT_VERIFICATION;
  x402_version?: 1 | 2;
  network?: string;
  transaction?: string;
  gdt_jti?: string;
  method?: string;
  reference?: string;
  settled_at?: string;
}

const TEXT = /^[\x21-\x7e]{1,256}$/;
const METHOD = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function bad(message: string): never {
  throw new SettlementReceiptError('settlement_receipt_invalid', message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TEXT.test(value)) bad(`${name} must be 1 to 256 printable characters`);
  return value;
}

/** Parses a posted receipt; a failed settlement is refused (`settlement_not_successful`). */
export function parseSettlementReceipt(value: unknown): SettlementReceipt {
  if (!isObject(value)) bad('receipt must be an object');
  if (value['protocol'] === 'x402') {
    const version = value['x402_version'];
    if (version !== 1 && version !== 2) bad('x402_version must be 1 or 2');
    const settlement = value['settlement'];
    if (!isObject(settlement)) bad('settlement must be the x402 SettlementResponse object');
    if (settlement['success'] !== true) {
      throw new SettlementReceiptError('settlement_not_successful', 'only a successful x402 settlement is bound as commitment evidence');
    }
    const payer = settlement['payer'];
    const jti = value['gdt_jti'];
    return {
      protocol: 'x402',
      x402_version: version,
      settlement: {
        success: true,
        transaction: text(settlement['transaction'], 'settlement.transaction'),
        network: text(settlement['network'], 'settlement.network'),
        ...(payer !== undefined ? { payer: text(payer, 'settlement.payer') } : {}),
      },
      ...(jti !== undefined ? { gdt_jti: text(jti, 'gdt_jti') } : {}),
    };
  }
  if (value['protocol'] === 'mpp') {
    const receipt = value['receipt'];
    if (!isObject(receipt)) bad('receipt.receipt must be the Payment-Receipt object');
    if (receipt['status'] !== 'success') {
      throw new SettlementReceiptError('settlement_not_successful', 'a Payment-Receipt is sent on success only; status must be success');
    }
    const method = receipt['method'];
    if (typeof method !== 'string' || !METHOD.test(method)) bad('receipt.method must be a lowercase payment method id');
    const timestamp = receipt['timestamp'];
    if (typeof timestamp !== 'string' || !RFC3339.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
      bad('receipt.timestamp must be RFC 3339');
    }
    return {
      protocol: 'mpp',
      receipt: { status: 'success', method, timestamp, reference: text(receipt['reference'], 'receipt.reference') },
    };
  }
  return bad('protocol must be x402 or mpp');
}

/** The public-safe reference: the receipt hash and what identifies the settlement, never the payer. */
export function settlementReceiptRef(receipt: SettlementReceipt): SettlementReceiptRef {
  const body = receipt.protocol === 'x402' ? receipt.settlement : receipt.receipt;
  const hash = createHash('sha256').update(canonicalize(body), 'utf8').digest('base64url');
  const base = { protocol: receipt.protocol, receipt_hash: `sha-256:${hash}`, receipt_verification: RECEIPT_VERIFICATION } as const;
  if (receipt.protocol === 'x402') {
    return {
      ...base,
      x402_version: receipt.x402_version,
      network: receipt.settlement.network,
      transaction: receipt.settlement.transaction,
      ...(receipt.gdt_jti !== undefined ? { gdt_jti: receipt.gdt_jti } : {}),
    };
  }
  return { ...base, method: receipt.receipt.method, reference: receipt.receipt.reference, settled_at: receipt.receipt.timestamp };
}

/** The commitment_evidence payload binding one receipt to a commitment. */
export function settlementCommitmentEvidencePayload(input: {
  commitment_id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  merchant_id: string;
  artifact_refs_used: string[];
  receipt: SettlementReceiptRef;
}): Record<string, unknown> {
  return {
    commitment_id: input.commitment_id,
    commitment_type: SETTLEMENT_RECEIPT_COMMITMENT_TYPE,
    buyer_agent_id: input.buyer_agent_id,
    seller_agent_id: input.seller_agent_id,
    merchant_id: input.merchant_id,
    artifact_refs_used: [...input.artifact_refs_used],
    policy_decision: 'evidence_only_settled_by_provider',
    offline_commitment_mode: false,
    forbidden_execution_claims: [],
    settlement_receipt: input.receipt,
    allowed_to_execute: false,
    no_payment_execution: true,
  };
}

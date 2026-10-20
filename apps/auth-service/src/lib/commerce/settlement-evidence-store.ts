// SPDX-License-Identifier: Apache-2.0
/**
 * Issue and persist a `commitment_evidence` artifact that binds a settlement
 * receipt (G59; lib/commerce/settlement-receipt-evidence.ts) to a
 * commitment, in one transaction with its status-list entry, like every
 * other OACP artifact (oacp-artifact-store.ts).
 *
 * Idempotent on (tenant_id, commitment_id): the same receipt again returns
 * the artifact already issued; another receipt for the same commitment is a
 * conflict. The artifacts the commitment relied on must be issued, live
 * artifacts of the same tenant and merchant.
 */
import type postgres from 'postgres';
import { config } from '../../config.js';
import type { TxSql } from '../../db/client.js';
import { newOacpArtifactId } from './ids.js';
import { getActiveOacpSigner } from './oacp-issuer-keys.js';
import { issueOacpArtifact, verifyOacpArtifact } from './oacp-jws.js';
import { COLUMNS, getOacpArtifact, insertIssued, rowToRecord, type OacpArtifactRecord } from './oacp-artifact-store.js';
import { allocateOacpStatusEntry, assertOacpStatusBaseUsable } from './oacp-status.js';
import { OACP_ARTIFACT_TTLS_SECONDS, type OacpArtifactSafety } from './oacp-trust-artifacts.js';
import {
  SettlementReceiptError,
  parseSettlementReceipt,
  settlementCommitmentEvidencePayload,
  settlementReceiptRef,
} from './settlement-receipt-evidence.js';

type Sql = ReturnType<typeof postgres>;

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_REFS = 32;

export class SettlementEvidenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'settlement_evidence_invalid' | 'settlement_receipt_invalid' | 'settlement_not_successful'
      | 'artifact_ref_unknown' | 'commitment_receipt_conflict',
    message: string,
  ) {
    super(message);
    this.name = 'SettlementEvidenceError';
  }
}

const SAFETY: OacpArtifactSafety = {
  public_safe: true,
  contains_private_data: false,
  allowed_agent_uses: ['commitment_evidence_review', 'audit'],
  forbidden_agent_uses: ['checkout_payment_execution', 'payment_capture', 'refund_execution', 'settlement', 'payout'],
  commitment_allowed: false,
  offline_commitment_allowed: false,
  requires_online_confirmation: true,
  requires_provider_direct_verification: true,
  requires_merchant_system_confirmation: true,
  stale_behavior: 'non_binding_only',
  refusal_code_if_invalid: 'oacp_commitment_evidence_invalid',
};

export interface SettlementEvidenceRequest {
  tenant_id: string;
  merchant_id: string;
  seller_agent_id: string;
  buyer_agent_id: string;
  commitment_id: string;
  artifact_refs_used: string[];
  policy_version: string;
  receipt: unknown;
}

function invalid(message: string): never {
  throw new SettlementEvidenceError(400, 'settlement_evidence_invalid', message);
}

/** Validates the posted body; the receipt itself is parsed later. */
export function parseSettlementEvidenceRequest(body: unknown): SettlementEvidenceRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const allowed = ['tenant_id', 'merchant_id', 'seller_agent_id', 'buyer_agent_id', 'commitment_id', 'artifact_refs_used', 'policy_version', 'receipt'];
  for (const name of Object.keys(b)) if (!allowed.includes(name)) invalid(`${name} is not a member of the request`);
  for (const name of ['tenant_id', 'merchant_id', 'seller_agent_id', 'buyer_agent_id', 'commitment_id', 'policy_version']) {
    if (typeof b[name] !== 'string' || !ID.test(b[name] as string)) invalid(`${name} must be an id of 1 to 128 characters`);
  }
  const refs = b['artifact_refs_used'];
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_REFS || refs.some((r) => typeof r !== 'string' || !ID.test(r))) {
    invalid(`artifact_refs_used must list 1 to ${MAX_REFS} artifact ids`);
  }
  if (new Set(refs).size !== refs.length) invalid('artifact_refs_used lists an artifact twice');
  return { ...(b as unknown as SettlementEvidenceRequest), artifact_refs_used: [...refs] as string[] };
}

/**
 * Issue (or return the already issued) commitment_evidence artifact for a
 * settlement receipt.
 */
export async function issueSettlementCommitmentEvidence(
  sql: Sql,
  body: unknown,
  options: { now?: Date } = {},
): Promise<{ artifact: OacpArtifactRecord; created: boolean }> {
  const request = parseSettlementEvidenceRequest(body);
  let ref;
  try {
    ref = settlementReceiptRef(parseSettlementReceipt(request.receipt));
  } catch (error) {
    if (error instanceof SettlementReceiptError) {
      throw new SettlementEvidenceError(error.code === 'settlement_not_successful' ? 422 : 400, error.code, error.message);
    }
    throw error;
  }
  assertOacpStatusBaseUsable();
  const signer = await getActiveOacpSigner(sql);
  const now = options.now ?? new Date();
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    // One commitment, one receipt: serialise issuance per commitment.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`oacp-settlement:${request.tenant_id}:${request.commitment_id}`}, 59))`;
    const existing = await tx.unsafe(
      `SELECT ${COLUMNS} FROM oacp_artifacts
       WHERE family = 'commitment_evidence' AND tenant_id = $1 AND status <> 'refused'
         AND payload->>'commitment_id' = $2
       ORDER BY created_at DESC LIMIT 1`,
      [request.tenant_id, request.commitment_id],
    );
    if (existing[0]) {
      const record = rowToRecord(existing[0] as Record<string, unknown>);
      const stored = (record.payload['settlement_receipt'] as { receipt_hash?: unknown } | undefined)?.receipt_hash;
      if (stored !== ref.receipt_hash) {
        throw new SettlementEvidenceError(409, 'commitment_receipt_conflict', 'This commitment is already bound to another receipt');
      }
      return { artifact: record, created: false };
    }

    const refs = await tx`
      SELECT artifact_id FROM oacp_artifacts
      WHERE artifact_id = ANY(${request.artifact_refs_used}) AND status = 'issued'
        AND tenant_id = ${request.tenant_id} AND merchant_id = ${request.merchant_id}`;
    if (refs.length !== request.artifact_refs_used.length) {
      throw new SettlementEvidenceError(422, 'artifact_ref_unknown',
        'artifact_refs_used must name issued, unrevoked artifacts of this tenant and merchant');
    }

    const artifactId = newOacpArtifactId();
    const statusList = await allocateOacpStatusEntry(tx, artifactId);
    const nowIso = now.toISOString();
    const payload = settlementCommitmentEvidencePayload({
      commitment_id: request.commitment_id,
      buyer_agent_id: request.buyer_agent_id,
      seller_agent_id: request.seller_agent_id,
      merchant_id: request.merchant_id,
      artifact_refs_used: request.artifact_refs_used,
      receipt: ref,
    });
    const envelope = issueOacpArtifact({
      artifact_id: artifactId,
      artifact_type: 'commitment_evidence',
      issuer: config.jwtIssuer,
      signer,
      subject_type: 'commitment',
      subject_id: request.commitment_id,
      tenant_id: request.tenant_id,
      merchant_id: request.merchant_id,
      seller_agent_id: request.seller_agent_id,
      buyer_agent_id: request.buyer_agent_id,
      issued_at: nowIso,
      expires_at: new Date(now.getTime() + OACP_ARTIFACT_TTLS_SECONDS.commitment_evidence * 1000).toISOString(),
      source_observed_at: ref.settled_at ?? nowIso,
      policy_version: request.policy_version,
      status_list: statusList,
      evidence_refs: request.artifact_refs_used,
      payload,
      safety: SAFETY,
    });
    const check = verifyOacpArtifact({ envelope, payload, jwks: { keys: [signer.publicJwk] }, now_iso: nowIso, status: 0 });
    if (!check.valid) throw new Error(`commitment evidence failed self-verification: ${check.refusal_code}`);
    await insertIssued(tx, { family: 'commitment_evidence', envelope, payload, request_id: null });
    return { artifact: (await getOacpArtifact(tx, artifactId))!, created: true };
  }) as { artifact: OacpArtifactRecord; created: boolean };
}

// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Settlement receipts as OACP commitment evidence (G59), without a
 * database: the receipt forms read, the refusals, the public-safe reference
 * (hash, no payer) and the payload's place in the commitment_evidence schema.
 * The route against real Postgres is in
 * agent-network-identity-postgres.integration.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/lib/evidence/canonical.js';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  hashOacpPayload,
  validateOacpArtifactSchema,
} from '../src/lib/commerce/oacp-trust-artifacts.js';
import {
  SettlementReceiptError,
  parseSettlementReceipt,
  settlementCommitmentEvidencePayload,
  settlementReceiptRef,
} from '../src/lib/commerce/settlement-receipt-evidence.js';
import { parseSettlementEvidenceRequest, SettlementEvidenceError } from '../src/lib/commerce/settlement-evidence-store.js';

const SETTLEMENT = { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:84532', payer: '0x' + '12'.repeat(20) };

function refused(value: unknown): SettlementReceiptError {
  try {
    parseSettlementReceipt(value);
  } catch (error) {
    expect(error).toBeInstanceOf(SettlementReceiptError);
    return error as SettlementReceiptError;
  }
  throw new Error('expected a refusal');
}

describe('settlement receipts', () => {
  it('references an x402 receipt by the SHA-256 of its RFC 8785 form, without the payer', () => {
    const ref = settlementReceiptRef(parseSettlementReceipt({ protocol: 'x402', x402_version: 2, settlement: SETTLEMENT, gdt_jti: 'gdt_01' }));
    expect(ref).toEqual({
      protocol: 'x402',
      receipt_hash: `sha-256:${createHash('sha256').update(canonicalize(SETTLEMENT)).digest('base64url')}`,
      receipt_verification: 'reported_not_verified_by_grantex',
      x402_version: 2,
      network: 'eip155:84532',
      transaction: SETTLEMENT.transaction,
      gdt_jti: 'gdt_01',
    });
    expect(JSON.stringify(ref)).not.toContain(SETTLEMENT.payer);
  });

  it('references an MPP Payment-Receipt with its method, reference and time', () => {
    const receipt = { status: 'success', method: 'tempo', timestamp: '2026-10-20T12:00:00Z', reference: 'mpp-ref-1' };
    expect(settlementReceiptRef(parseSettlementReceipt({ protocol: 'mpp', receipt }))).toMatchObject({
      protocol: 'mpp', method: 'tempo', reference: 'mpp-ref-1', settled_at: '2026-10-20T12:00:00Z',
    });
  });

  it('refuses a failed settlement and anything outside the two forms', () => {
    expect(refused({ protocol: 'x402', x402_version: 2, settlement: { ...SETTLEMENT, success: false } }).code).toBe('settlement_not_successful');
    expect(refused({ protocol: 'mpp', receipt: { status: 'failed', method: 'tempo', timestamp: '2026-10-20T12:00:00Z', reference: 'r' } }).code).toBe('settlement_not_successful');
    expect(refused({ protocol: 'x402', x402_version: 3, settlement: SETTLEMENT }).code).toBe('settlement_receipt_invalid');
    expect(refused({ protocol: 'x402', x402_version: 2, settlement: { ...SETTLEMENT, transaction: '' } }).code).toBe('settlement_receipt_invalid');
    expect(refused({ protocol: 'mpp', receipt: { status: 'success', method: 'Tempo', timestamp: '2026-10-20T12:00:00Z', reference: 'r' } }).code).toBe('settlement_receipt_invalid');
    expect(refused({ protocol: 'ap2' }).code).toBe('settlement_receipt_invalid');
  });

  it('is a commitment_evidence payload the schema accepts, never implying execution', () => {
    const fixture = OACP_C6W3_VALID_ARTIFACT_FIXTURES.commitment_evidence;
    const payload = settlementCommitmentEvidencePayload({
      commitment_id: 'commitment_C6W3', buyer_agent_id: 'buyer_C6W3', seller_agent_id: 'seller_C6W3', merchant_id: 'mch_C6W3',
      artifact_refs_used: ['price_C6W3'],
      receipt: settlementReceiptRef(parseSettlementReceipt({ protocol: 'x402', x402_version: 2, settlement: SETTLEMENT })),
    });
    expect(payload['forbidden_execution_claims']).toEqual([]);
    expect(payload['allowed_to_execute']).toBe(false);
    const envelope = { ...(fixture.envelope as Record<string, unknown>), payload_hash: hashOacpPayload(payload) };
    expect(validateOacpArtifactSchema({ envelope, payload, now_iso: '2026-06-11T00:00:00.000Z' })).toMatchObject({ valid: true });
  });

  it('the request body is closed and its ids bounded', () => {
    const body = {
      tenant_id: 't', merchant_id: 'm', seller_agent_id: 's', buyer_agent_id: 'b', commitment_id: 'c',
      artifact_refs_used: ['a1'], policy_version: 'p', receipt: {},
    };
    expect(parseSettlementEvidenceRequest(body).artifact_refs_used).toEqual(['a1']);
    expect(() => parseSettlementEvidenceRequest({ ...body, extra: 1 })).toThrow(SettlementEvidenceError);
    expect(() => parseSettlementEvidenceRequest({ ...body, artifact_refs_used: [] })).toThrow(/artifact_refs_used/);
    expect(() => parseSettlementEvidenceRequest({ ...body, artifact_refs_used: ['a', 'a'] })).toThrow(/twice/);
    expect(() => parseSettlementEvidenceRequest({ ...body, commitment_id: 'has space' })).toThrow(/commitment_id/);
  });
});

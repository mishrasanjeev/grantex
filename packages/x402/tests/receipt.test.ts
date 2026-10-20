/**
 * x402 settlement receipts read from PAYMENT-RESPONSE (v2) and
 * X-PAYMENT-RESPONSE (v1), and the commitment-evidence receipt built from
 * them (G59).
 */
import { encodePaymentResponseHeader } from '@x402/core/http';
import { describe, expect, it } from 'vitest';
import { HEADERS, X402_V1_PAYMENT_RESPONSE_HEADER, readSettlementResponse, settlementReceiptEvidence } from '../src/index.js';

const SETTLED = {
  success: true,
  transaction: '0x' + 'ab'.repeat(32),
  network: 'eip155:84532',
  payer: '0x' + '12'.repeat(20),
};

describe('x402 settlement receipts', () => {
  it('reads the v2 PAYMENT-RESPONSE header', () => {
    const headers = new Headers({ [HEADERS.PAYMENT_RESPONSE]: encodePaymentResponseHeader(SETTLED as never) });
    expect(readSettlementResponse(headers)).toEqual({ x402Version: 2, ...SETTLED });
    expect(readSettlementResponse(new Response(null, { headers }))).toEqual({ x402Version: 2, ...SETTLED });
  });

  it('reads the v1 X-PAYMENT-RESPONSE header, and nothing when neither is present', () => {
    const v1 = Buffer.from(JSON.stringify({ ...SETTLED, network: 'base-sepolia' })).toString('base64');
    expect(readSettlementResponse({ [X402_V1_PAYMENT_RESPONSE_HEADER.toLowerCase()]: v1 })).toMatchObject({ x402Version: 1, network: 'base-sepolia' });
    expect(readSettlementResponse(new Headers())).toBeNull();
  });

  it('refuses a payment response that is not a SettlementResponse', () => {
    expect(() => readSettlementResponse({ [X402_V1_PAYMENT_RESPONSE_HEADER]: Buffer.from('{"ok":1}').toString('base64') })).toThrow(/SettlementResponse/);
    expect(() => readSettlementResponse({ [X402_V1_PAYMENT_RESPONSE_HEADER]: '%%%' })).toThrow();
  });

  it('shapes a successful settlement as the commitment-evidence receipt, never a failed one', () => {
    const receipt = readSettlementResponse(new Headers({ [HEADERS.PAYMENT_RESPONSE]: encodePaymentResponseHeader(SETTLED as never) }))!;
    expect(settlementReceiptEvidence(receipt, { gdtJti: 'gdt_01' })).toEqual({
      protocol: 'x402', x402_version: 2, settlement: { success: true, transaction: SETTLED.transaction, network: SETTLED.network, payer: SETTLED.payer }, gdt_jti: 'gdt_01',
    });
    expect(() => settlementReceiptEvidence({ ...receipt, success: false, errorReason: 'insufficient_funds' })).toThrow(/successful/);
  });
});

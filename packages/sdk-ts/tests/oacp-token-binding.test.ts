// SPDX-License-Identifier: Apache-2.0
/**
 * The shared scheme token binding type (G52), as relying parties import it
 * from @grantex/sdk. The auth service runs the same refusals and keeps its
 * copy equal to this one (apps/auth-service/tests/commerce-scheme-token-binding.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  TOKEN_BINDING_SCHEMES,
  TokenBindingError,
  checkTokenBindingWithinCapability,
  parseSchemeTokenBinding,
  type SchemeTokenBinding,
} from '../src/index.js';

const BINDING: SchemeTokenBinding = {
  scheme: 'upi_autopay',
  token_ref: 'upi-mandate-ref-0001',
  agent_id: 'shopper-01',
  merchant_scope: ['merchant.example'],
  limits: { max_amount: 150000, currency: 'INR', expires_at: '2026-11-01T00:00:00Z' },
};

describe('scheme token binding', () => {
  it('parses the shared shape for each scheme', () => {
    expect(TOKEN_BINDING_SCHEMES).toEqual(['visa', 'mastercard', 'upi_autopay', 'plural']);
    expect(parseSchemeTokenBinding(BINDING)).toEqual(BINDING);
  });

  it('refuses an account number and anything outside the capability', () => {
    expect(() => parseSchemeTokenBinding({ ...BINDING, token_ref: '4000000000000002' })).toThrow(TokenBindingError);
    const binding = parseSchemeTokenBinding(BINDING);
    expect(() => checkTokenBindingWithinCapability(binding, {
      buyer_agent_id: 'shopper-01', merchant_scope: ['merchant.example'], max_amount: 100000, currency: 'INR',
    })).toThrow(/max_amount/);
  });
});

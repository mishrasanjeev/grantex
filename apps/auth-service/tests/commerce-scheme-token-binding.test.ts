// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Scheme token binding on the payment capability (G52): the shared shape,
 * its refusals, its place inside the mandate_capability artifact it rides
 * on, and parity with the @grantex/sdk copy. Grantex never executes a
 * binding; nothing here calls a provider.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OACP_C6W3_VALID_ARTIFACT_FIXTURES,
  hashOacpPayload,
  validateOacpArtifactSchema,
} from '../src/lib/commerce/oacp-trust-artifacts.js';
import {
  TokenBindingError,
  checkTokenBindingWithinCapability,
  parseSchemeTokenBinding,
} from '../src/lib/commerce/scheme-token-binding.js';

const BINDING = {
  scheme: 'visa',
  token_ref: 'tokref_C6W3_0001',
  agent_id: 'buyer_C6W3',
  merchant_scope: ['mch_C6W3'],
  limits: { max_amount: 250000, currency: 'INR' },
};

function refused(value: unknown): string {
  try {
    parseSchemeTokenBinding(value);
  } catch (error) {
    expect(error).toBeInstanceOf(TokenBindingError);
    expect((error as TokenBindingError).code).toBe('token_binding_invalid');
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('parseSchemeTokenBinding', () => {
  it('accepts {scheme, token_ref, agent_id, merchant_scope, limits} for every scheme', () => {
    for (const scheme of ['visa', 'mastercard', 'upi_autopay', 'provider_token']) {
      expect(parseSchemeTokenBinding({ ...BINDING, scheme })).toEqual({ ...BINDING, scheme });
    }
    expect(parseSchemeTokenBinding({ ...BINDING, limits: { ...BINDING.limits, expires_at: '2026-06-11T00:02:00Z' } }).limits.expires_at).toBe('2026-06-11T00:02:00Z');
  });

  it('refuses an account number, a raw token or anything outside the shape', () => {
    expect(refused({ ...BINDING, token_ref: '4111111111111111' })).toMatch(/never an account number/);
    expect(refused({ ...BINDING, token_ref: 'ref-4111111111111111-x' })).toMatch(/never an account number/);
    expect(refused({ ...BINDING, token_ref: 'eyJ.raw token with spaces' })).toMatch(/opaque reference/);
    expect(refused({ ...BINDING, token: 'x' })).toMatch(/no member token/);
    expect(refused({ ...BINDING, scheme: 'other' })).toMatch(/scheme must be one of/);
    expect(refused({ ...BINDING, merchant_scope: [] })).toMatch(/merchant_scope/);
    expect(refused({ ...BINDING, merchant_scope: ['m', 'm'] })).toMatch(/twice/);
    expect(refused({ ...BINDING, limits: { max_amount: 1.5, currency: 'INR' } })).toMatch(/minor units/);
    expect(refused({ ...BINDING, limits: { max_amount: 0, currency: 'INR' } })).toMatch(/minor units/);
    expect(refused({ ...BINDING, limits: { max_amount: 10, currency: 'inr' } })).toMatch(/ISO 4217/);
    expect(refused({ ...BINDING, limits: { max_amount: 10, currency: 'INR', per_day: 1 } })).toMatch(/no member per_day/);
    expect(refused({ ...BINDING, limits: { max_amount: 10, currency: 'INR', expires_at: 'tomorrow' } })).toMatch(/RFC 3339/);
    const { agent_id: _agent, ...missing } = BINDING;
    expect(refused(missing)).toMatch(/agent_id is required/);
    expect(refused(null)).toMatch(/must be an object/);
  });

  it('must sit inside its capability', () => {
    const capability = { buyer_agent_id: 'buyer_C6W3', merchant_scope: ['mch_C6W3'], max_amount: 500000, currency: 'INR' };
    const binding = parseSchemeTokenBinding(BINDING);
    expect(() => checkTokenBindingWithinCapability(binding, capability)).not.toThrow();
    expect(() => checkTokenBindingWithinCapability(binding, { ...capability, buyer_agent_id: 'other' })).toThrow(/buyer_agent_id/);
    expect(() => checkTokenBindingWithinCapability(binding, { ...capability, merchant_scope: ['other'] })).toThrow(/merchant_scope/);
    expect(() => checkTokenBindingWithinCapability(binding, { ...capability, max_amount: 1000 })).toThrow(/max_amount/);
    expect(() => checkTokenBindingWithinCapability(binding, { ...capability, currency: 'EUR' })).toThrow(/currency/);
    const late = parseSchemeTokenBinding({ ...BINDING, limits: { ...BINDING.limits, expires_at: '2026-06-12T00:00:00Z' } });
    expect(() => checkTokenBindingWithinCapability(late, capability, '2026-06-11T00:02:00.000Z')).toThrow(/expires_at/);
  });
});

describe('token_binding on a mandate_capability artifact', () => {
  const fixture = OACP_C6W3_VALID_ARTIFACT_FIXTURES.mandate_capability;
  const withBinding = (binding: unknown) => {
    const payload = { ...(fixture.payload as Record<string, unknown>), token_binding: binding };
    const envelope = { ...(fixture.envelope as Record<string, unknown>), payload_hash: hashOacpPayload(payload) };
    return validateOacpArtifactSchema({ envelope, payload, now_iso: '2026-06-11T00:00:00.000Z' });
  };

  it('a capability without a binding validates as before', () => {
    expect(validateOacpArtifactSchema({ envelope: fixture.envelope, payload: fixture.payload, now_iso: '2026-06-11T00:00:00.000Z' }))
      .toMatchObject({ valid: true });
  });

  it('accepts a binding inside the capability and refuses one outside it', () => {
    expect(withBinding(BINDING)).toMatchObject({ valid: true, artifact_type: 'mandate_capability' });
    expect(withBinding({ ...BINDING, agent_id: 'someone_else' })).toMatchObject({ valid: false, refusal_code: 'token_binding_invalid' });
    expect(withBinding({ ...BINDING, limits: { max_amount: 999999999, currency: 'INR' } })).toMatchObject({ valid: false, refusal_code: 'token_binding_invalid' });
    expect(withBinding({ ...BINDING, token_ref: '5555555555554444' })).toMatchObject({ valid: false, refusal_code: 'token_binding_invalid' });
  });
});

describe('@grantex/sdk parity', () => {
  it('the SDK copy is this module, line for line, below its header comment', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = (path: string) => readFileSync(path, 'utf8').split(String.fromCharCode(13)).join('').split('\n */\n').slice(1).join('\n */\n');
    const service = body(join(here, '../src/lib/commerce/scheme-token-binding.ts'));
    const sdk = body(join(here, '../../../packages/sdk-ts/src/oacp/token-binding.ts'));
    expect(service.length).toBeGreaterThan(1000);
    expect(sdk).toBe(service);
  });
});

import { describe, expect, it } from 'vitest';
import {
  Any, PaymentPayloadSchema, PaymentRequiredSchema, PaymentRequirementsSchema,
} from '@x402/core/schemas';

const requirementV1 = {
  scheme: 'exact', network: 'synthetic-test', maxAmountRequired: '100',
  resource: 'https://merchant.example/resource', description: 'Synthetic resource',
  payTo: 'merchant:example', maxTimeoutSeconds: 60, asset: 'TEST',
  extra: { synthetic: true, nested: { value: 1 } },
};
const requirementV2 = {
  scheme: 'exact', network: 'grantex:prepaid', amount: '100', asset: 'TEST',
  payTo: 'merchant:example', maxTimeoutSeconds: 60,
  extra: { synthetic: true, nested: { value: 1 } },
};
const resource = { url: 'https://merchant.example/resource', tags: ['synthetic'] };
const requiredV1 = { x402Version: 1, accepts: [requirementV1] };
const requiredV2 = { x402Version: 2, resource, accepts: [requirementV2], extensions: { synthetic: true } };
const payloadV1 = { x402Version: 1, scheme: 'exact', network: 'synthetic-test', payload: { authorization: 'synthetic' } };
const payloadV2 = { x402Version: 2, resource, accepted: requirementV2, payload: { authorization: 'synthetic' }, extensions: { synthetic: true } };

describe('patched schema dependency compatibility', () => {
  it('retains the upstream single-argument dictionary schema contract', () => {
    const value = { synthetic: true, nested: { value: 1 }, list: ['example'] };
    expect(Any.parse(value)).toEqual(value);
    expect(Any.safeParse(null).success).toBe(false);
    expect(Any.safeParse('invalid').success).toBe(false);
  });

  it.each([requirementV1, requirementV2])('preserves v1/v2 requirement parsing: %j', value => {
    expect(PaymentRequirementsSchema.parse(value)).toEqual(value);
  });

  it.each([requiredV1, requiredV2])('preserves v1/v2 challenge parsing: %j', value => {
    expect(PaymentRequiredSchema.parse(value)).toEqual(value);
  });

  it.each([payloadV1, payloadV2])('preserves v1/v2 payload parsing: %j', value => {
    expect(PaymentPayloadSchema.parse(value)).toEqual(value);
  });

  it.each([
    { ...requiredV2, x402Version: 3 },
    { ...requiredV2, accepts: [] },
    { ...requiredV2, accepts: [{ ...requirementV2, network: 'invalid' }] },
    { ...requiredV2, accepts: [{ ...requirementV2, amount: '' }] },
    { ...requiredV2, accepts: [{ ...requirementV2, maxTimeoutSeconds: 0 }] },
    { ...requiredV2, resource: { ...resource, tags: Array(6).fill('synthetic') } },
    { ...requiredV2, resource: { ...resource, url: '' } },
  ])('still rejects malformed payment challenges: %j', value => {
    expect(PaymentRequiredSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { ...payloadV1, x402Version: 0 },
    { ...payloadV1, payload: null },
    { ...payloadV2, payload: 'invalid' },
    { ...payloadV2, accepted: { ...requirementV2, asset: '' } },
  ])('still rejects malformed payment payloads: %j', value => {
    expect(PaymentPayloadSchema.safeParse(value).success).toBe(false);
  });
});

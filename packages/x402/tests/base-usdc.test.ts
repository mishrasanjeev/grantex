import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import { createX402Agent, HEADERS, PrepaidPaymentApprovalRequiredError } from '../src/agent.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/uk-taxi-phv-base-mainnet-402.json', import.meta.url), 'utf8'));
const challenge = () => decodePaymentRequiredHeader(fixture.paymentRequiredHeader);
const key = 'external-preflight-stable-key-0001';
function authorization() {
  const req = challenge().accepts[0]!;
  const validBefore = String(Math.floor(Date.now() / 1000) + 290);
  return { authorization: 'internal-grantex-jwt-never-to-merchant', reservationId: 'wres_test', walletId: 'pwal_test',
    expiresAt: new Date(Number(validBefore) * 1000).toISOString(), remainingAvailable: '980000', remainingCumulative: '80000',
    evmPayment: { signature: `0x${'ab'.repeat(65)}`, authorization: { from: `0x${'11'.repeat(20)}`,
      to: req.payTo, value: req.amount, validAfter: '0', validBefore, nonce: `0x${'cd'.repeat(32)}` } } };
}
function setup(required = challenge(), result = authorization()) {
  const network = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 402,
    headers: { 'payment-required': Buffer.from(JSON.stringify(required)).toString('base64') } }))
    .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
  const authorizePayment = vi.fn().mockResolvedValue(result);
  return { network, authorizePayment, agent: createX402Agent({ authorizePayment, fetch: network,
    baseUsdc: { scope: 'licensing:preflight', purpose: 'compatibility' } }) };
}

describe('opt-in governed Base USDC x402', () => {
  it('retries the captured merchant challenge without changing its schema, POST body or accepted terms', async () => {
    const { network, authorizePayment, agent } = setup();
    expect((await agent.fetch(fixture.endpoint, { method: 'POST', body: JSON.stringify(fixture.requestBody), idempotencyKey: key })).status).toBe(200);
    const retry = network.mock.calls[1]![0] as Request;
    expect(await retry.clone().json()).toEqual(fixture.requestBody);
    expect(retry.redirect).toBe('error');
    expect(retry.headers.get('Idempotency-Key')).toBe(key);
    const payload = decodePaymentSignatureHeader(retry.headers.get(HEADERS.PAYMENT_SIGNATURE)!);
    expect(payload.accepted).toEqual(challenge().accepts[0]);
    expect(payload.resource).toEqual(challenge().resource);
    expect(Object.keys(payload.payload).sort()).toEqual(['authorization', 'signature']);
    expect(JSON.stringify(payload)).not.toContain('internal-grantex');
    expect(authorizePayment).toHaveBeenCalledWith(expect.objectContaining({ amount: '20000', network: 'eip155:8453',
      resource: fixture.endpoint, scope: 'licensing:preflight', purpose: 'compatibility', idempotencyKey: key }));
  });
  it.each(['asset', 'domain', 'method', 'amount', 'timeout', 'recipient', 'resource'])('rejects %s mismatch before contacting custody', async field => {
    const required = challenge();
    const req = required.accepts[0]!;
    if (field === 'asset') req.asset = `0x${'22'.repeat(20)}`;
    if (field === 'domain') req.extra!['name'] = 'Fake USDC';
    if (field === 'method') req.extra!['assetTransferMethod'] = 'permit2';
    if (field === 'amount') req.amount = '0';
    if (field === 'timeout') req.maxTimeoutSeconds = 301;
    if (field === 'recipient') req.payTo = 'not-an-address';
    if (field === 'resource') required.resource.url = 'https://attacker.example/paid';
    const { agent, authorizePayment, network } = setup(required);
    await expect(agent.fetch(fixture.endpoint, { idempotencyKey: key })).rejects.toThrow();
    expect(authorizePayment).not.toHaveBeenCalled();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each(['value', 'to', 'validBefore', 'signature'])('rejects a mismatched signer response: %s', async field => {
    const result = authorization();
    if (field === 'value') result.evmPayment.authorization.value = '99999';
    if (field === 'to') result.evmPayment.authorization.to = `0x${'33'.repeat(20)}`;
    if (field === 'validBefore') result.evmPayment.authorization.validBefore = '1';
    if (field === 'signature') result.evmPayment.signature = 'invalid';
    const { agent, network } = setup(challenge(), result);
    await expect(agent.fetch(fixture.endpoint, { idempotencyKey: key })).rejects.toThrow(/invalid or mismatched/);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('refuses missing/conflicting retry keys and unsafe URLs without making requests', () => {
    const { agent, network } = setup();
    expect(() => agent.fetch(fixture.endpoint)).toThrow('stable idempotencyKey');
    expect(() => agent.fetch(fixture.endpoint, { idempotencyKey: key, headers: { 'Idempotency-Key': 'different' } })).toThrow('must match');
    expect(() => agent.fetch('http://merchant.example/paid', { idempotencyKey: key })).toThrow('HTTPS');
    expect(network).not.toHaveBeenCalled();
  });
  it('preserves the typed approval challenge without a paid retry', async () => {
    const { agent, authorizePayment, network } = setup();
    authorizePayment.mockResolvedValueOnce({ status: 'approval_required', approvalRequestId: 'wapr_test', walletId: 'pwal_test',
      assignmentId: 'wa_test', policyIds: ['limit'], expiresAt: new Date(Date.now() + 300000).toISOString() });
    await expect(agent.fetch(fixture.endpoint, { idempotencyKey: key })).rejects.toBeInstanceOf(PrepaidPaymentApprovalRequiredError);
    expect(network).toHaveBeenCalledTimes(1);
  });
});

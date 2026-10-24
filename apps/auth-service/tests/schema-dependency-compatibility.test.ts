import { afterEach, expect, it, vi } from 'vitest';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

afterEach(() => vi.unstubAllGlobals());

it('retains offline EVM payload creation and schema validation without provider calls', async () => {
  const networkFetch = vi.fn(() => { throw new Error('Network access is forbidden in this compatibility test'); });
  vi.stubGlobal('fetch', networkFetch);
  const account = privateKeyToAccount(generatePrivateKey());
  const accepted = {
    scheme: 'exact', network: 'eip155:84532' as const,
    asset: '0x0000000000000000000000000000000000000001', amount: '1',
    payTo: '0x0000000000000000000000000000000000000002', maxTimeoutSeconds: 30,
    extra: { name: 'Synthetic Test Token', version: '1' },
  };
  const payload = await new ExactEvmScheme(account).createPaymentPayload(2, accepted);
  const result = PaymentPayloadV2Schema.safeParse({
    ...payload, accepted, resource: { url: 'https://merchant.example/synthetic' },
  });
  expect(result.success).toBe(true);
  expect(payload.payload).toMatchObject({ authorization: { from: account.address, value: '1' } });
  expect(networkFetch).not.toHaveBeenCalled();
});

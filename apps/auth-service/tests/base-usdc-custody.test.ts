import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_NETWORK, BASE_USDC, baseUsdcCustody } from '../src/lib/base-usdc-custody.js';

const privateKey = `0x${'11'.repeat(32)}` as const; // Public test fixture, never funded.
const binding = { developerId: 'dev_test', principalId: 'principal_test', providerWalletId: 'test',
  walletAddress: privateKeyToAccount(privateKey).address, network: BASE_NETWORK, asset: BASE_USDC };

describe('operator-provisioned Base custody boundary', () => {
  beforeEach(() => {
    vi.stubEnv('BASE_USDC_RPC_URL', 'https://rpc.example.invalid');
    vi.stubEnv('BASE_USDC_WALLETS', JSON.stringify({ test: { privateKey, developerId: binding.developerId, principalId: binding.principalId } }));
  });
  afterEach(() => vi.unstubAllEnvs());
  it('binds the configured signer to exactly one principal and developer', () => {
    expect(baseUsdcCustody(binding).address).toBe(binding.walletAddress);
    expect(() => baseUsdcCustody({ ...binding, developerId: 'other' })).toThrow('not assigned to this principal');
    expect(() => baseUsdcCustody({ ...binding, principalId: 'other' })).toThrow('not assigned to this principal');
  });
  it.each([
    { network: 'eip155:1' }, { asset: `0x${'22'.repeat(20)}` }, { walletAddress: `0x${'22'.repeat(20)}` },
  ])('refuses a mismatched wallet binding %j', change => {
    expect(() => baseUsdcCustody({ ...binding, ...change })).toThrow('does not match');
  });
  it('fails closed when custody is absent', () => {
    vi.stubEnv('BASE_USDC_WALLETS', '');
    expect(() => baseUsdcCustody(binding)).toThrow('not configured');
  });
  it.each(['null', '{}', 'invalid json', JSON.stringify({ test: { privateKey: 'secret-invalid-key' } })])('sanitizes malformed configuration', raw => {
    vi.stubEnv('BASE_USDC_WALLETS', raw);
    expect(() => baseUsdcCustody(binding)).toThrow('configuration is invalid');
  });
  it('requires HTTPS for production RPCs', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_USDC_RPC_URL', 'http://localhost:8545');
    expect(() => baseUsdcCustody(binding)).toThrow('configuration is invalid');
  });
});

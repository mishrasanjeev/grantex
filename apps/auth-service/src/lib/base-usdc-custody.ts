import { ExactEvmScheme } from '@x402/evm/exact/client';
import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const BASE_USDC_PROVIDER = 'base_usdc';
export const BASE_NETWORK = 'eip155:8453';
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const USDC_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

export interface EvmPayment {
  signature: Hex;
  authorization: {
    from: Hex; to: Hex; value: string; validAfter: string; validBefore: string; nonce: Hex;
  };
}

export class BaseUsdcError extends Error {
  override readonly name = 'BaseUsdcError';
  constructor(readonly code: string, message: string, readonly statusCode = 503) { super(message); }
}

export function canonicalEvmAddress(value: string): string {
  try { return getAddress(value).toLowerCase(); }
  catch { throw new BaseUsdcError('INVALID_EVM_ADDRESS', 'Invalid EVM address', 400); }
}

interface WalletBinding {
  developerId: string;
  principalId: string;
  providerWalletId: string;
  walletAddress: string;
  network: string;
  asset: string;
}

// These bindings are operator-provisioned secrets, never supplied by an agent.
export function baseUsdcCustody(binding: WalletBinding) {
  const raw = process.env['BASE_USDC_WALLETS'];
  const rpcUrl = process.env['BASE_USDC_RPC_URL'];
  if (!raw || !rpcUrl) {
    throw new BaseUsdcError('CUSTODY_ADAPTER_UNAVAILABLE', 'Base USDC custody is not configured');
  }
  let wallet: { privateKey: Hex; developerId: string; principalId: string };
  try {
    const url = new URL(rpcUrl);
    if (url.username || url.password || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && process.env['NODE_ENV'] !== 'production'))) {
      throw new Error('Invalid RPC URL');
    }
    const wallets = JSON.parse(raw) as Record<string, typeof wallet>;
    if (!Object.hasOwn(wallets, binding.providerWalletId)) throw new Error('Unknown custody wallet');
    wallet = wallets[binding.providerWalletId]!;
    if (!/^0x[0-9a-fA-F]{64}$/.test(wallet.privateKey)) throw new Error('Invalid key');
  } catch {
    throw new BaseUsdcError('CUSTODY_CONFIGURATION_INVALID', 'Base USDC custody configuration is invalid');
  }
  if (wallet.developerId !== binding.developerId || wallet.principalId !== binding.principalId) {
    throw new BaseUsdcError('CUSTODY_OWNER_MISMATCH', 'Custody wallet is not assigned to this principal', 403);
  }
  let account: ReturnType<typeof privateKeyToAccount>;
  try { account = privateKeyToAccount(wallet.privateKey); }
  catch { throw new BaseUsdcError('CUSTODY_CONFIGURATION_INVALID', 'Base USDC signing key is invalid'); }
  if (binding.network !== BASE_NETWORK || binding.asset.toLowerCase() !== BASE_USDC
      || canonicalEvmAddress(binding.walletAddress) !== account.address.toLowerCase()) {
    throw new BaseUsdcError('CUSTODY_WALLET_MISMATCH', 'Wallet network, asset, or address does not match custody configuration', 403);
  }
  const rpc = createPublicClient({ transport: http(rpcUrl, { timeout: 8_000, retryCount: 0 }) });
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (await rpc.getChainId() !== 8453) {
        throw new BaseUsdcError('CUSTODY_CHAIN_MISMATCH', 'Custody RPC is not Base');
      }
      return await operation();
    } catch (error) {
      if (error instanceof BaseUsdcError) throw error;
      // RPC errors can contain API keys in URLs. Keep them out of logs and API responses.
      throw new BaseUsdcError('CUSTODY_PROVIDER_UNAVAILABLE', 'Base USDC provider operation failed; funds remain reserved where applicable');
    }
  }
  async function freshBlock() {
    const block = await rpc.getBlock({ blockTag: 'latest' });
    if (Math.abs(Number(block.timestamp) - Math.floor(Date.now() / 1000)) > 90) {
      throw new BaseUsdcError('CUSTODY_RPC_STALE', 'Base RPC chain time is stale');
    }
    return block;
  }

  return {
    address: account.address,
    sign: (amount: string, recipient: string, expiresAt: Date, alreadyReserved: string) => guarded(async () => {
      const block = await freshBlock();
      const balance = await rpc.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] });
      if (balance < BigInt(alreadyReserved) + BigInt(amount)) {
        throw new BaseUsdcError('INSUFFICIENT_CUSTODY_FUNDS', 'On-chain USDC does not cover outstanding reservations and this payment', 402);
      }
      const seconds = Math.floor(expiresAt.getTime() / 1000) - Math.floor(Date.now() / 1000);
      if (seconds < 10 || seconds > 300) {
        throw new BaseUsdcError('AUTHORIZATION_WINDOW_TOO_SHORT', 'Payment must have 10 to 300 seconds of remaining authority', 409);
      }
      const result = await new ExactEvmScheme(account).createPaymentPayload(2, {
        scheme: 'exact', network: BASE_NETWORK, asset: BASE_USDC, amount,
        payTo: recipient, maxTimeoutSeconds: seconds, extra: { name: 'USD Coin', version: '2' },
      });
      const payment = result.payload as unknown as EvmPayment;
      if (BigInt(payment.authorization.validBefore) > BigInt(Math.floor(expiresAt.getTime() / 1000))) {
        throw new BaseUsdcError('AUTHORIZATION_WINDOW_CHANGED', 'Authorization window changed during signing', 409);
      }
      return { payment, fromBlock: block.number!.toString() };
    }),
    verifyFunding: (amount: string, reference: string, creditedBalance: string) => guarded(async () => {
      const match = /^(0x[0-9a-f]{64}):(0|[1-9][0-9]{0,8})$/.exec(reference);
      if (!match) throw new BaseUsdcError('INVALID_FUNDING_REFERENCE', 'Use a lowercase transactionHash:logIndex funding reference', 400);
      const receipt = await rpc.getTransactionReceipt({ hash: match[1] as Hex });
      const finalized = await rpc.getBlock({ blockTag: 'finalized' });
      const canonical = await rpc.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== 'success' || receipt.blockNumber > finalized.number! || canonical.hash !== receipt.blockHash) {
        throw new BaseUsdcError('FUNDING_NOT_FINAL', 'USDC funding transaction is not successful and finalized', 409);
      }
      const log = receipt.logs.find(item => item.logIndex === Number(match[2]) && item.address.toLowerCase() === BASE_USDC);
      if (!log) throw new BaseUsdcError('FUNDING_MISMATCH', 'Funding transfer log was not found', 400);
      const transfer = decodeEventLog({ abi: USDC_ABI, eventName: 'Transfer', data: log.data, topics: log.topics });
      if (transfer.args.to.toLowerCase() !== account.address.toLowerCase()
          || transfer.args.from.toLowerCase() === account.address.toLowerCase()
          || transfer.args.value !== BigInt(amount)) {
        throw new BaseUsdcError('FUNDING_MISMATCH', 'USDC funding recipient or amount does not match', 400);
      }
      const balance = await rpc.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] });
      if (balance < BigInt(creditedBalance) + BigInt(amount)) {
        throw new BaseUsdcError('FUNDING_BALANCE_MISMATCH', 'On-chain funds do not cover the credited wallet balance', 409);
      }
    }),
    reconcile: (payment: EvmPayment, fromBlock: string) => guarded(async () => {
      await freshBlock();
      const finalized = await rpc.getBlock({ blockTag: 'finalized' });
      const start = BigInt(fromBlock);
      const used = await rpc.readContract({ address: BASE_USDC, abi: USDC_ABI, functionName: 'authorizationState',
        args: [account.address, payment.authorization.nonce], blockNumber: finalized.number! });
      if (!used) {
        return { status: finalized.timestamp > BigInt(payment.authorization.validBefore) ? 'expired' as const : 'reserved' as const };
      }
      const scanEnd = start + 9_999n < finalized.number! ? start + 9_999n : finalized.number!;
      if (finalized.number! >= start) {
        // Bound each log query for providers that limit eth_getLogs ranges.
        for (let cursor = start; cursor <= scanEnd; cursor += 2_000n) {
          const end = cursor + 1_999n < scanEnd ? cursor + 1_999n : scanEnd;
          const logs = await rpc.getLogs({
            address: BASE_USDC, event: USDC_ABI[3],
            args: { authorizer: account.address, nonce: payment.authorization.nonce },
            fromBlock: cursor, toBlock: end, strict: true,
          });
          for (const log of logs) {
            const receipt = await rpc.getTransactionReceipt({ hash: log.transactionHash });
            const canonical = await rpc.getBlock({ blockNumber: receipt.blockNumber });
            if (receipt.status !== 'success' || canonical.hash !== receipt.blockHash || receipt.blockNumber > finalized.number!) continue;
            const transfer = receipt.logs.some(item => {
              if (item.address.toLowerCase() !== BASE_USDC) return false;
              try {
                const decoded = decodeEventLog({ abi: USDC_ABI, eventName: 'Transfer', data: item.data, topics: item.topics });
                return decoded.args.from.toLowerCase() === account.address.toLowerCase()
                  && decoded.args.to.toLowerCase() === payment.authorization.to.toLowerCase()
                  && decoded.args.value === BigInt(payment.authorization.value);
              } catch { return false; }
            });
            if (transfer) return { status: 'settled' as const, transaction: receipt.transactionHash };
          }
        }
      }
      // A consumed/cancelled nonce without complete settlement evidence stays reserved.
      return { status: 'reserved' as const, nextBlock: (scanEnd + 1n > start ? scanEnd + 1n : start).toString() };
    }),
  };
}

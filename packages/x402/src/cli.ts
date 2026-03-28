#!/usr/bin/env node
/**
 * grantex-x402 CLI — Issue, verify, and revoke Grantex Delegation Tokens.
 *
 * Usage:
 *   grantex-x402 keygen                         Generate an Ed25519 key pair
 *   grantex-x402 issue --agent <DID> --scope <scopes> --limit <amount> --expiry <duration>
 *   grantex-x402 verify <token> --resource <scope> --amount <n>
 *   grantex-x402 revoke <tokenId>
 *   grantex-x402 decode <token>                  Decode a GDT without verification
 *   grantex-x402 inspect <token>                 Alias for decode
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPair } from './crypto.js';
import { issueGDT } from './gdt.js';
import { verifyGDT, decodeGDT } from './verify.js';
import { getRevocationRegistry } from './revocation.js';
import { getAuditLog } from './audit.js';
import type { SpendPeriod, Currency } from './types.js';

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.log(`
grantex-x402 — Agent Spend Authorization for x402

Commands:
  keygen                      Generate an Ed25519 key pair
  issue                       Issue a Grantex Delegation Token (GDT)
  verify <token>              Verify a GDT against a context
  revoke <tokenId>            Revoke a GDT by its token ID
  decode <token>              Decode a GDT JWT (no verification)
  audit                       Show recent audit log entries

Issue options:
  --agent <DID>               Agent DID to delegate to (required)
  --scope <scopes>            Comma-separated scopes (required)
  --limit <amount>            Spend limit amount (required)
  --currency <USDC|USDT>      Currency (default: USDC)
  --period <1h|24h|7d|30d>    Spend period (default: 24h)
  --expiry <duration>         Expiry (e.g. 24h, 7d, PT1H) (required)
  --key <path>                Path to private key file (hex)
  --chain <string>            Payment chain (default: base)

Verify options:
  --resource <scope>          Resource scope to check (required)
  --amount <number>           Spend amount (required)
  --currency <USDC|USDT>      Currency (default: USDC)

Examples:
  grantex-x402 keygen > keys.json
  grantex-x402 issue --agent did:key:z6Mk... --scope weather:read --limit 10 --expiry 24h --key principal.key
  grantex-x402 verify eyJ... --resource weather:read --amount 0.001
  grantex-x402 revoke 550e8400-e29b-41d4-a716-446655440000
  grantex-x402 decode eyJ...
`);
}

async function main(): Promise<void> {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case 'keygen':
      await cmdKeygen();
      break;
    case 'issue':
      await cmdIssue();
      break;
    case 'verify':
      await cmdVerify();
      break;
    case 'revoke':
      await cmdRevoke();
      break;
    case 'decode':
    case 'inspect':
      await cmdDecode();
      break;
    case 'audit':
      await cmdAudit();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

async function cmdKeygen(): Promise<void> {
  const keyPair = generateKeyPair();
  const output = {
    did: keyPair.did,
    publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
    privateKey: Buffer.from(keyPair.privateKey).toString('hex'),
  };

  const outFile = getFlag('out');
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.log(`Key pair written to ${outFile}`);
    console.log(`DID: ${keyPair.did}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

async function cmdIssue(): Promise<void> {
  const agentDID = getFlag('agent');
  const scopeStr = getFlag('scope');
  const limitStr = getFlag('limit');
  const expiry = getFlag('expiry');
  const keyPath = getFlag('key');
  const currency = (getFlag('currency') ?? 'USDC') as Currency;
  const period = (getFlag('period') ?? '24h') as SpendPeriod;
  const chain = getFlag('chain') ?? 'base';

  if (!agentDID || !scopeStr || !limitStr || !expiry) {
    console.error('Missing required flags: --agent, --scope, --limit, --expiry');
    process.exit(1);
  }

  let privateKey: Uint8Array;
  if (keyPath) {
    const hex = readFileSync(keyPath, 'utf8').trim();
    privateKey = hexToBytes(hex);
  } else {
    // Check for GRANTEX_PRIVATE_KEY env var
    const envKey = process.env['GRANTEX_PRIVATE_KEY'];
    if (envKey) {
      privateKey = hexToBytes(envKey);
    } else {
      console.error('No signing key provided. Use --key <path> or set GRANTEX_PRIVATE_KEY env var.');
      process.exit(1);
    }
  }

  const scope = scopeStr.split(',').map((s) => s.trim());
  const amount = parseFloat(limitStr);

  const token = await issueGDT({
    agentDID,
    scope,
    spendLimit: { amount, currency, period },
    expiry,
    signingKey: privateKey,
    paymentChain: chain,
  });

  console.log(token);
}

async function cmdVerify(): Promise<void> {
  const token = args[1];
  const resource = getFlag('resource');
  const amountStr = getFlag('amount');
  const currency = (getFlag('currency') ?? 'USDC') as Currency;

  if (!token || !resource || !amountStr) {
    console.error('Usage: grantex-x402 verify <token> --resource <scope> --amount <number>');
    process.exit(1);
  }

  const result = await verifyGDT(token, {
    resource,
    amount: parseFloat(amountStr),
    currency,
  });

  if (result.valid) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

async function cmdRevoke(): Promise<void> {
  const tokenId = args[1];
  if (!tokenId) {
    console.error('Usage: grantex-x402 revoke <tokenId>');
    process.exit(1);
  }

  const reason = getFlag('reason') ?? 'CLI revocation';
  const registry = getRevocationRegistry();
  await registry.revoke(tokenId, reason);
  console.log(`Token ${tokenId} has been revoked.`);
}

async function cmdDecode(): Promise<void> {
  const token = args[1];
  if (!token) {
    console.error(`Usage: grantex-x402 ${command} <token>`);
    process.exit(1);
  }

  try {
    const decoded = decodeGDT(token);
    console.log(JSON.stringify(decoded, null, 2));
  } catch (err) {
    console.error(`Failed to decode token: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function cmdAudit(): Promise<void> {
  const limit = parseInt(getFlag('limit') ?? '20', 10);
  const eventType = getFlag('type') as 'issuance' | 'verification' | undefined;
  const agentDID = getFlag('agent');

  const auditLog = getAuditLog();
  const entries = await auditLog.query({
    ...(eventType !== undefined ? { eventType } : {}),
    ...(agentDID !== undefined ? { agentDID } : {}),
    limit,
  });

  if (entries.length === 0) {
    console.log('No audit entries found.');
  } else {
    console.log(JSON.stringify(entries, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '').replace(/\s+/g, '');
  if (clean.length !== 64) {
    throw new Error(`Expected 64 hex characters (32 bytes), got ${clean.length}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

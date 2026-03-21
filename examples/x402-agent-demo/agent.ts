/**
 * x402 Agent Demo — AI agent that uses GDT + x402 to fetch weather data.
 *
 * Demonstrates the full flow:
 * 1. Generate principal and agent key pairs
 * 2. Issue a Grantex Delegation Token (GDT)
 * 3. Create an x402 agent with the GDT
 * 4. Fetch weather data (handles 402 → pay → retry automatically)
 *
 * Prerequisites: Start the weather API server first:
 *   cd ../x402-weather-api && npm start
 *
 * Then run: npm start
 */

import {
  generateKeyPair,
  issueGDT,
  verifyGDT,
  decodeGDT,
  createX402Agent,
} from '@grantex/x402';

const API_URL = 'http://localhost:3402/api/weather/forecast';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════');
  console.log('   Grantex x402 Agent Demo');
  console.log('   Agent Spend Authorization for x402 Payments');
  console.log('═══════════════════════════════════════════════\n');

  // ── Step 1: Generate Key Pairs ──────────────────────────────────
  console.log('Step 1: Generate Ed25519 key pairs\n');

  const principal = generateKeyPair();
  console.log(`  Principal DID: ${principal.did}`);
  console.log(`  Principal key: ${Buffer.from(principal.publicKey).toString('hex').slice(0, 16)}...`);

  const agent = generateKeyPair();
  console.log(`  Agent DID:     ${agent.did}`);
  console.log(`  Agent key:     ${Buffer.from(agent.publicKey).toString('hex').slice(0, 16)}...`);
  console.log('');

  // ── Step 2: Issue a GDT ─────────────────────────────────────────
  console.log('Step 2: Issue Grantex Delegation Token (GDT)\n');

  const gdt = await issueGDT({
    agentDID: agent.did,
    scope: ['weather:read'],
    spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
    expiry: '24h',
    signingKey: principal.privateKey,
    paymentChain: 'base',
  });

  console.log(`  GDT issued: ${gdt.slice(0, 60)}...`);
  console.log(`  Length: ${gdt.length} chars`);
  console.log('');

  // ── Step 3: Inspect the GDT ─────────────────────────────────────
  console.log('Step 3: Decode & inspect the GDT\n');

  const decoded = decodeGDT(gdt);
  console.log('  Claims:');
  console.log(`    Issuer (iss):    ${decoded.iss}`);
  console.log(`    Subject (sub):   ${decoded.sub}`);
  console.log(`    Token ID (jti):  ${decoded.jti}`);
  console.log(`    Issued at:       ${new Date(decoded.iat * 1000).toISOString()}`);
  console.log(`    Expires at:      ${new Date(decoded.exp * 1000).toISOString()}`);
  console.log('  Credential Subject:');
  console.log(`    Scopes:          ${decoded.vc.credentialSubject.scope.join(', ')}`);
  console.log(`    Spend Limit:     $${decoded.vc.credentialSubject.spendLimit.amount} ${decoded.vc.credentialSubject.spendLimit.currency}/${decoded.vc.credentialSubject.spendLimit.period}`);
  console.log(`    Payment Chain:   ${decoded.vc.credentialSubject.paymentChain}`);
  console.log('');

  // ── Step 4: Verify the GDT standalone ───────────────────────────
  console.log('Step 4: Verify GDT standalone\n');

  const verifyResult = await verifyGDT(gdt, {
    resource: 'weather:read',
    amount: 0.001,
    currency: 'USDC',
  });

  console.log(`  Valid:            ${verifyResult.valid ? 'YES' : 'NO'}`);
  console.log(`  Agent DID:        ${verifyResult.agentDID}`);
  console.log(`  Principal DID:    ${verifyResult.principalDID}`);
  console.log(`  Remaining Limit:  $${verifyResult.remainingLimit} USDC`);
  console.log(`  Scopes:           ${verifyResult.scopes.join(', ')}`);
  console.log('');

  // ── Step 5: Fetch weather data via x402 ─────────────────────────
  console.log('Step 5: Fetch weather data via x402 + GDT\n');
  console.log(`  Target API: ${API_URL}`);

  const x402 = createX402Agent({
    gdt,
    paymentHandler: async (details) => {
      console.log(`\n  [Payment Handler]`);
      console.log(`    Amount:    ${details.amount} ${details.currency}`);
      console.log(`    Chain:     ${details.chain}`);
      console.log(`    Recipient: ${details.recipientAddress}`);
      console.log(`    Status:    Simulating Base L2 USDC transfer...`);

      // Simulate payment (in production, sign + submit Base L2 tx)
      const proof = {
        txHash: `0x${randomHex(64)}`,
        chain: details.chain,
        amount: details.amount,
        currency: details.currency,
        recipient: details.recipientAddress,
        timestamp: Date.now(),
      };

      console.log(`    TX Hash:   ${proof.txHash.slice(0, 18)}...`);
      console.log(`    Status:    Payment confirmed\n`);

      return Buffer.from(JSON.stringify(proof)).toString('base64url');
    },
  });

  try {
    const response = await x402.fetch(API_URL);

    if (response.ok) {
      const data = await response.json();
      console.log('  Response received:');
      console.log(JSON.stringify(data, null, 4).split('\n').map(l => `    ${l}`).join('\n'));
    } else {
      console.log(`  Error: ${response.status} ${response.statusText}`);
      const body = await response.text();
      console.log(`  Body: ${body}`);
    }
  } catch (err) {
    console.log(`  Connection error: ${err instanceof Error ? err.message : err}`);
    console.log('  Make sure the weather API is running: cd ../x402-weather-api && npm start');
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log('   Demo complete');
  console.log('═══════════════════════════════════════════════\n');
}

function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

main().catch(console.error);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { OAuthAgentClient, generateOAuthAgentKey, PrincipalPrepaidWalletClient, PrepaidWalletAgentClient } from '../../packages/sdk-ts/dist/index.js';
import { createX402Agent, HEADERS } from '../../packages/x402/dist/agent.js';

const require = createRequire(new URL('../../apps/auth-service/package.json', import.meta.url));
const { createPublicClient, createWalletClient, http, parseSignature } = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { base } = require('viem/chains');
const { ExactEvmScheme } = require('@x402/evm/exact/facilitator');
const { toFacilitatorEvmSigner } = require('@x402/evm');
const API = 'http://localhost:3349';
const RPC = 'http://127.0.0.1:8549';
const RESOURCE = `${API}/v1/prepaid-wallets`;
const ASSET = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PRINCIPAL = 'base-usdc-local-test-principal';
// Ephemeral payer and public fixture relayer keys. Never use on a funded network.
const TEST_KEY = generatePrivateKey();
const payer = privateKeyToAccount(TEST_KEY);
const relayer = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const merchantAddress = privateKeyToAccount(`0x${'33'.repeat(32)}`).address;
const root = fileURLToPath(new URL('../../', import.meta.url));
const composeArgs = ['compose', '-p', 'grantex-base-compat', '-f', 'tests/base-usdc/compose.yml'];
const compose = (...args) => execFileSync('docker', [...composeArgs, ...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
const rpc = createPublicClient({ chain: base, transport: http(RPC, { retryCount: 0 }), cacheTime: 0 });
const writer = createWalletClient({ chain: base, account: relayer, transport: http(RPC) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthy() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${API}/health`)).ok) return; } catch { /* startup */ }
    await sleep(500);
  }
  throw new Error('Isolated Docker auth-service did not become healthy');
}
async function json(response) {
  const body = await response.text();
  assert.ok(response.ok, `${response.status}: ${body}`);
  return JSON.parse(body);
}
const errorCode = code => error => { assert.equal(error.code, code, error.message); return true; };

test('Docker: governed Base USDC with official x402 facilitator and real EVM execution',
  { skip: process.env.GRANTEX_BASE_DOCKER_TEST !== '1', timeout: 180000 }, async t => {
    await healthy();
    assert.equal(await rpc.getChainId(), 8453);
    await rpc.request({ method: 'anvil_reset', params: [] });
    const signup = await json(await fetch(`${API}/v1/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `base-compat-${Date.now()}`, mode: 'sandbox' }) }));
    const developerApi = (path, body) => fetch(`${API}${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${signup.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
    process.env.BASE_USDC_WALLETS = JSON.stringify({ local_test: { privateKey: TEST_KEY,
      developerId: signup.developerId, principalId: PRINCIPAL } });
    process.env.BASE_TEST_RSA_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
    compose('up', '-d', '--no-deps', '--force-recreate', 'auth-service');
    await healthy();

    const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
      'TestUSDC.sol': { content: readFileSync(new URL('./TestUSDC.sol', import.meta.url), 'utf8') } },
      settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } } })));
    assert.ok(!compiled.errors?.some(error => error.severity === 'error'), JSON.stringify(compiled.errors));
    const contract = compiled.contracts['TestUSDC.sol'].TestUSDC;
    await rpc.request({ method: 'anvil_setCode', params: [ASSET, `0x${contract.evm.deployedBytecode.object}`] });
    await rpc.request({ method: 'anvil_setBalance', params: [relayer.address, '0x56bc75e2d63100000'] });
    await rpc.request({ method: 'evm_setNextBlockTimestamp', params: [Math.floor(Date.now() / 1000)] });
    const mine = async () => { await rpc.request({ method: 'anvil_mine', params: ['0x42', '0x0'] }); };
    await mine();
    const ticker = setInterval(() => { rpc.request({ method: 'evm_mine', params: [] }).catch(() => {}); }, 5000);
    t.after(() => clearInterval(ticker));
    const balance = address => rpc.readContract({ address: ASSET, abi: contract.abi, functionName: 'balanceOf', args: [address] });
    async function mint(amount) {
      const hash = await writer.writeContract({ address: ASSET, abi: contract.abi, functionName: 'mint', args: [payer.address, BigInt(amount)] });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      await mine();
      return `${hash}:${receipt.logs[0].logIndex}`;
    }

    const key = await generateOAuthAgentKey();
    const scopes = ['wallet:read', 'wallet:spend', 'wallet:reload:request', 'licensing:preflight'];
    const registration = await developerApi('/v1/agents', { name: 'Base compatibility local agent', scopes,
      redirectUris: ['https://local-test.example/callback'], resourceServers: [RESOURCE], publicJwk: key.publicJwk });
    const agentId = registration.agentId;
    const oauth = await OAuthAgentClient.create({ issuer: API, clientId: agentId, redirectUri: 'https://local-test.example/callback',
      resource: RESOURCE, privateKey: key.privateKey, publicJwk: key.publicJwk, allowInsecureLoopback: true });
    const pending = await oauth.beginAuthorization({ scopes, principalHint: PRINCIPAL });
    const approval = await fetch(pending.authorizationUrl, { redirect: 'manual' });
    assert.equal(approval.status, 303);
    const tokens = await oauth.completeAuthorization(approval.headers.get('location'));
    const session = await developerApi('/v1/principal-sessions', { principalId: PRINCIPAL, expiresIn: '1h' });
    const principal = new PrincipalPrepaidWalletClient({ baseUrl: API, sessionToken: session.sessionToken });
    const agent = new PrepaidWalletAgentClient({ oauthClient: oauth, accessToken: tokens.access_token });
    let wallet;
    let assignment;
    const merchantUrl = 'http://localhost:3459/api/v1/preflight';
    const baseRequest = overrides => ({ walletId: wallet.walletId, amount: '20000', asset: ASSET, network: 'eip155:8453',
      recipient: merchantAddress, resource: merchantUrl, scope: 'licensing:preflight', maxTimeoutSeconds: 300,
      idempotencyKey: randomUUID(), ...overrides });
    const createParams = { name: 'Local Base test wallet', custodyMode: 'external', provider: 'base_usdc', providerWalletId: 'local_test',
      walletAddress: payer.address, network: 'eip155:8453', asset: ASSET, decimals: 6 };

    await t.test('operator ownership, native asset and unique custody address are enforced', async () => {
      await assert.rejects(principal.create({ ...createParams, walletAddress: relayer.address }), errorCode('CUSTODY_WALLET_MISMATCH'));
      await assert.rejects(principal.create({ ...createParams, decimals: 18 }), errorCode('INVALID_BASE_WALLET'));
      wallet = await principal.create(createParams);
      await assert.rejects(principal.create(createParams), errorCode('PROVIDER_WALLET_EXISTS'));
      const otherPending = await oauth.beginAuthorization({ scopes, principalHint: 'different-principal' });
      const otherApproval = await fetch(otherPending.authorizationUrl, { redirect: 'manual' });
      await oauth.completeAuthorization(otherApproval.headers.get('location'));
      const otherSession = await developerApi('/v1/principal-sessions', { principalId: 'different-principal', expiresIn: '1h' });
      const other = new PrincipalPrepaidWalletClient({ baseUrl: API, sessionToken: otherSession.sessionToken });
      await assert.rejects(other.create(createParams), errorCode('CUSTODY_OWNER_MISMATCH'));
      assignment = await principal.assign(wallet.walletId, { agentId, perTransactionLimit: '30000', cumulativeLimit: '60000',
        cumulativePeriodSeconds: 60, allowedRecipients: [merchantAddress], allowedScopes: ['licensing:preflight'],
        allowedResourceOrigins: ['http://localhost:3459'] });
    });
    await t.test('only a finalized exact USDC transfer can credit funds, once', async () => {
      const proof = await mint('1000000');
      await assert.rejects(principal.reload(wallet.walletId, '999999', randomUUID(), proof), errorCode('FUNDING_MISMATCH'));
      await principal.reload(wallet.walletId, '1000000', randomUUID(), proof);
      await assert.rejects(principal.reload(wallet.walletId, '1000000', randomUUID(), proof), errorCode('EXTERNAL_REFERENCE_CONFLICT'));
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).availableAmount, '1000000');
    });
    await t.test('per-transaction, recipient, resource and OAuth scopes fail before a signature or reservation', async () => {
      for (const [changes, code] of [[{ amount: '30001' }, 'PER_TRANSACTION_LIMIT_EXCEEDED'],
        [{ recipient: relayer.address }, 'RECIPIENT_NOT_ALLOWED'], [{ resource: 'https://wrong.example/paid' }, 'RESOURCE_NOT_ALLOWED'],
        [{ scope: 'not:granted' }, 'PAYMENT_SCOPE_NOT_GRANTED']]) {
        await assert.rejects(agent.authorizePayment(baseRequest(changes)), errorCode(code));
      }
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '0');
    });

    let reservation;
    let paidPayload;
    let accepted;
    let settlement;
    const facilitator = new ExactEvmScheme(toFacilitatorEvmSigner({ ...rpc, ...writer, address: relayer.address }, { confirmationTimeoutMs: 10000 }));
    const fixture = JSON.parse(readFileSync(new URL('../../packages/x402/tests/fixtures/uk-taxi-phv-base-mainnet-402.json', import.meta.url)));
    const captured = JSON.parse(Buffer.from(fixture.paymentRequiredHeader, 'base64').toString());
    const requestBodies = [];
    const merchant = createServer(async (req, res) => {
      try {
        let body = ''; for await (const chunk of req) body += chunk;
        requestBodies.push(body);
        const header = req.headers['payment-signature'];
        if (!header) {
          const required = structuredClone(captured);
          required.resource.url = merchantUrl;
          required.accepts[0].payTo = merchantAddress;
          accepted = required.accepts[0];
          res.writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(required)).toString('base64') });
          res.end('{}'); return;
        }
        paidPayload = JSON.parse(Buffer.from(header, 'base64').toString());
        const verification = await facilitator.verify(paidPayload, accepted);
        assert.equal(verification.isValid, true, JSON.stringify(verification));
        settlement = await facilitator.settle(paidPayload, accepted);
        assert.equal(settlement.success, true, JSON.stringify(settlement));
        res.writeHead(200, { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify(settlement)).toString('base64') });
        res.end('{"compatible":true}');
      } catch (error) { res.writeHead(500); res.end(error.message); }
    });
    await new Promise(resolve => merchant.listen(3459, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => merchant.close(resolve)));
    await t.test('402 -> governed signing -> official facilitator verify/settle -> 200 with actual token transfer', async () => {
      const x402 = createX402Agent({ walletId: wallet.walletId, baseUsdc: { scope: 'licensing:preflight' },
        authorizePayment: async request => {
          reservation = await agent.authorizePayment(request);
          return reservation;
        } });
      const response = await x402.fetch(merchantUrl, { method: 'POST', body: JSON.stringify(fixture.requestBody),
        headers: { 'Content-Type': 'application/json' }, idempotencyKey: randomUUID() });
      assert.deepEqual(await json(response), { compatible: true });
      assert.deepEqual(requestBodies, [JSON.stringify(fixture.requestBody), JSON.stringify(fixture.requestBody)]);
      assert.equal(await balance(merchantAddress), 20000n);
      assert.equal(await balance(payer.address), 980000n);
      assert.ok(!JSON.stringify(paidPayload).includes(reservation.authorization));
      await mine();
      assert.deepEqual(await agent.reconcileReservation(reservation.reservationId), {
        reservationId: reservation.reservationId, status: 'settled', transaction: settlement.transaction });
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '0');
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).availableAmount, '980000');
      assert.equal((await principal.reconcileReservation(reservation.reservationId)).status, 'settled');
    });
    await t.test('cryptographic tampering and replay do not transfer money twice', async () => {
      const tampered = structuredClone(paidPayload);
      tampered.payload.authorization.value = '20001';
      assert.equal((await facilitator.verify(tampered, accepted)).isValid, false);
      const auth = paidPayload.payload.authorization;
      const sig = parseSignature(paidPayload.payload.signature);
      const args = [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, Number(sig.v), sig.r, sig.s];
      await assert.rejects(rpc.simulateContract({ address: ASSET, abi: contract.abi, functionName: 'transferWithAuthorization', args, account: relayer }));
      assert.equal(await balance(merchantAddress), 20000n);
    });

    let held;
    let late;
    const heldRequest = baseRequest({ amount: '30000', maxTimeoutSeconds: 60 });
    await t.test('response loss, service restart and concurrent retries recover exactly one persisted nonce and hold', async () => {
      held = await agent.authorizePayment(heldRequest);
      compose('restart', 'auth-service');
      await healthy();
      const retry = await Promise.all([agent.authorizePayment(heldRequest), agent.authorizePayment(heldRequest)]);
      for (const item of retry) {
        assert.deepEqual(item.evmPayment, held.evmPayment);
        assert.equal(item.reservationId, held.reservationId);
      }
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '30000');
      await assert.rejects(agent.authorizePayment({ ...heldRequest, amount: '29999' }), errorCode('IDEMPOTENCY_CONFLICT'));
      await assert.rejects(agent.authorizePayment(baseRequest()), errorCode('CUMULATIVE_LIMIT_EXCEEDED'));
    });
    await t.test('outstanding signed exposure still counts after the rolling window advances', async () => {
      late = await agent.authorizePayment(baseRequest({ amount: '10000', maxTimeoutSeconds: 60 }));
      const sql = require('postgres')('postgres://grantex:local-base-test-only@127.0.0.1:5549/grantex', { max: 1 });
      try {
        // Advance only test record ages, not the workstation or production clock.
        await sql`UPDATE wallet_payment_reservations SET created_at = NOW() - INTERVAL '1 hour' WHERE wallet_id = ${wallet.walletId}`;
      } finally { await sql.end(); }
      await assert.rejects(agent.authorizePayment(baseRequest({ amount: '30000' })), errorCode('CUMULATIVE_LIMIT_EXCEEDED'));
    });
    await t.test('blocking prevents new signatures but cannot release already signed on-chain exposure', async () => {
      await principal.setAgentBlocked(agentId, true, 'Local test block');
      await assert.rejects(agent.authorizePayment(baseRequest()), errorCode('WALLET_BLOCKED'));
      await assert.rejects(principal.releaseReservation(held.reservationId, 'unsafe early release'), errorCode('PAYMENT_RECONCILIATION_REQUIRED'));
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '40000');
      assert.equal((await principal.reconcileReservation(held.reservationId)).status, 'reserved');
    });
    await t.test('a signature issued before a block can settle and is accounted for without reauthorizing', async () => {
      const requirements = { ...accepted, amount: '10000', maxTimeoutSeconds: 60 };
      const payload = { x402Version: 2, resource: { url: merchantUrl }, accepted: requirements, payload: late.evmPayment };
      assert.equal((await facilitator.verify(payload, requirements)).isValid, true);
      const settled = await facilitator.settle(payload, requirements);
      assert.equal(settled.success, true);
      await mine();
      assert.equal((await principal.reconcileReservation(late.reservationId)).status, 'settled');
      assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '30000');
      assert.equal(await balance(merchantAddress), 30000n);
    });
    await t.test('RPC outage cannot release signed funds; finalized unused expiry releases once', async () => {
      compose('pause', 'anvil');
      try {
        await assert.rejects(principal.reconcileReservation(held.reservationId), errorCode('CUSTODY_PROVIDER_UNAVAILABLE'));
        assert.equal((await principal.list()).find(w => w.walletId === wallet.walletId).reservedAmount, '30000');
      } finally { compose('unpause', 'anvil'); }
      const expiry = Number(held.evmPayment.authorization.validBefore);
      await rpc.request({ method: 'evm_setNextBlockTimestamp', params: [expiry + 1] });
      await mine();
      assert.equal((await principal.reconcileReservation(held.reservationId)).status, 'expired');
      assert.equal((await principal.reconcileReservation(held.reservationId)).status, 'expired');
      const final = (await principal.list()).find(w => w.walletId === wallet.walletId);
      assert.equal(final.reservedAmount, '0');
      assert.equal(final.availableAmount, '970000');
      assert.equal(await balance(payer.address), 970000n);
    });
  });

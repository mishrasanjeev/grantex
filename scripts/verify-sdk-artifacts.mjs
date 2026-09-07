import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.argv[2], 'Pass the clean consumer directory containing installed SDK packages');
const root = resolve(process.argv[2]);
const pkg = name => resolve(root, 'node_modules', ...name.split('/'));
const read = name => JSON.parse(readFileSync(resolve(pkg(name), 'package.json'), 'utf8'));
assert.equal(read('@grantex/sdk').version, '0.6.0');
assert.equal(read('@grantex/x402').version, '0.4.0');
const sdk = await import(pathToFileURL(resolve(pkg('@grantex/sdk'), 'dist/index.js')).href);
const x402 = await import(pathToFileURL(resolve(pkg('@grantex/x402'), 'dist/index.js')).href);
for (const name of ['Grantex', 'OAuthAgentClient', 'generateOAuthAgentKey', 'PrincipalPrepaidWalletClient', 'PrepaidWalletAgentClient']) {
  assert.equal(typeof sdk[name], 'function', `Missing packaged SDK export ${name}`);
}
assert.equal(typeof x402.createX402Agent, 'function');
assert.throws(() => x402.createX402Agent({ walletId: 'wal_test', authorizePayment: async () => ({}), baseUsdc: { scope: '' } }), /scope/);
const guarded = x402.createX402Agent({ walletId: 'wal_test', authorizePayment: async () => ({}), baseUsdc: { scope: 'licensing:preflight' } });
await assert.rejects(() => guarded.fetch('https://merchant.example/test'), /idempotencyKey/);

const seen = [];
const result = { reservationId: 'wres_artifact', status: 'reserved', transaction: null };
const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, dpop: req.headers.dpop });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const principal = new sdk.PrincipalPrepaidWalletClient({ baseUrl, sessionToken: 'artifact-test-only' });
  assert.deepEqual(await principal.reconcileReservation('wres_artifact'), result);
  const key = await sdk.generateOAuthAgentKey();
  const agent = new sdk.PrepaidWalletAgentClient({ accessToken: 'artifact-test-only', privateKey: key.privateKey,
    publicJwk: key.publicJwk, resourceUrl: `${baseUrl}/v1/prepaid-wallets` });
  assert.deepEqual(await agent.reconcileReservation('wres_artifact'), result);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/v1/principal/prepaid-wallets/reservations/wres_artifact/reconcile');
  assert.equal(seen[0].authorization, 'Bearer artifact-test-only');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].url, '/v1/prepaid-wallets/reservations/wres_artifact/reconcile');
  assert.equal(seen[1].authorization, 'DPoP artifact-test-only');
  assert.equal(seen[1].dpop.split('.').length, 3);
} finally {
  await new Promise(resolve => server.close(resolve));
}
console.log('SDK artifact verification passed: exact versions, exports, Base safety gates and authenticated reconciliation wire contracts.');

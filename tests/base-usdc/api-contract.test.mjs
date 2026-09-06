import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const spec = parse(readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'));
const routes = readFileSync(new URL('../../apps/auth-service/src/routes/prepaid-wallets.ts', import.meta.url), 'utf8');

test('hosted principal-client examples use the API origin, not the marketing rewrite host', () => {
  for (const file of ['docs/integrations/x402.mdx', 'docs/guides/base-usdc-custody.mdx',
    'packages/sdk-ts/README.md', 'packages/sdk-py/README.md']) {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(text, /base(?:Url|_url)\s*[:=]\s*['"]https:\/\/api\.grantex\.dev['"]/);
    assert.doesNotMatch(text, /base(?:Url|_url)\s*[:=]\s*['"]https:\/\/grantex\.dev['"]/);
  }
});

test('Base reconciliation API references resolve and match authenticated server routes', () => {
  for (const [prefix, auth] of [['/v1/prepaid-wallets', 'dpopAuth'], ['/v1/principal/prepaid-wallets', 'principalSessionAuth']]) {
    const path = `${prefix}/reservations/{reservationId}/reconcile`;
    const operation = spec.paths[path].post;
    assert.deepEqual(operation.security, [{ [auth]: [] }]);
    assert.ok(spec.components.securitySchemes[auth]);
    assert.ok(routes.includes(`${prefix}/reservations/:id/reconcile`));
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/WalletReconciliation');
  }
  const schemas = spec.components.schemas;
  assert.equal(schemas.WalletAuthorization.properties.evmPayment.$ref, '#/components/schemas/WalletEvmPayment');
  assert.deepEqual(schemas.WalletEvmPayment.required, ['signature', 'authorization']);
  assert.deepEqual(schemas.WalletReconciliation.properties.status.enum, ['reserved', 'settled', 'expired']);
});

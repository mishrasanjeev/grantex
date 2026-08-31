/** Managed prepaid-wallet x402 v2 agent example. */

import { randomUUID } from 'node:crypto';
import { importJWK, type JWK } from 'jose';
import { OAuthAgentClient, PrepaidWalletAgentClient } from '@grantex/sdk';
import { createX402Agent, PrepaidPaymentApprovalRequiredError } from '@grantex/x402';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function privateAndPublicJwk(): { privateJwk: JWK; publicJwk: JWK } {
  const parsed = JSON.parse(required('GRANTEX_OAUTH_PRIVATE_JWK')) as JWK;
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || !parsed.d || !parsed.x || !parsed.y) {
    throw new Error('GRANTEX_OAUTH_PRIVATE_JWK must be an ES256 P-256 private JWK');
  }
  const { d: _privateMaterial, ...publicJwk } = parsed;
  return { privateJwk: parsed, publicJwk };
}

async function main(): Promise<void> {
  const issuer = (process.env['GRANTEX_ISSUER'] ?? 'http://localhost:3001').replace(/\/$/, '');
  const resource = `${issuer}/v1/prepaid-wallets`;
  const { privateJwk, publicJwk } = privateAndPublicJwk();
  const privateKey = await importJWK(privateJwk, 'ES256');
  if (privateKey instanceof Uint8Array) throw new Error('Expected an ES256 CryptoKey');
  const issuerUrl = new URL(issuer);
  const allowInsecureLoopback = issuerUrl.hostname === 'localhost' || issuerUrl.hostname === '127.0.0.1';

  const oauthClient = await OAuthAgentClient.create({
    issuer,
    clientId: required('GRANTEX_OAUTH_CLIENT_ID'),
    redirectUri: required('GRANTEX_OAUTH_REDIRECT_URI'),
    resource,
    privateKey,
    publicJwk,
    allowInsecureLoopback,
  });
  const walletAgent = new PrepaidWalletAgentClient({
    oauthClient,
    accessToken: required('GRANTEX_ACCESS_TOKEN'),
  });
  const wallets = await walletAgent.list();
  if (wallets.length === 0) throw new Error('The agent has no active prepaid-wallet assignment');

  const logicalPaymentId = `weather_${randomUUID()}`;
  const x402 = createX402Agent({
    authorizePayment: walletAgent.x402Authorizer,
    ...(process.env['GRANTEX_WALLET_ID'] ? { walletId: process.env['GRANTEX_WALLET_ID'] } : {}),
  });

  try {
    const response = await x402.fetch(
      process.env['WEATHER_API_URL'] ?? 'http://localhost:3402/api/weather/forecast',
      {
        headers: { 'Idempotency-Key': logicalPaymentId },
        idempotencyKey: logicalPaymentId,
      },
    );
    if (!response.ok) throw new Error(`Weather API returned HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    if (error instanceof PrepaidPaymentApprovalRequiredError) {
      console.error(`Principal approval required: ${error.approval.approvalRequestId}`);
      console.error(`Retry with the same idempotency key after approval: ${error.idempotencyKey}`);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

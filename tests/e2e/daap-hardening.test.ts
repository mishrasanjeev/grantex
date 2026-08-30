import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';
const ISSUER = process.env.E2E_ISSUER ?? BASE_URL;

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Grant token is not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('E2E: DAAP security hardening', () => {
  it('binds authorization and recovers an exact committed refresh response', async () => {
    const apiKey = process.env.E2E_API_KEY ?? (await Grantex.signup(
      { name: `daap-e2e-${Date.now()}`, mode: 'sandbox' },
      { baseUrl: BASE_URL },
    )).apiKey;
    const client = new Grantex({ apiKey, baseUrl: BASE_URL });

    const { publicKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const redirectUri = 'https://client.example/callback';
    const resource = 'https://resource.example/api';
    const scope = 'records:read';
    const agent = await client.agents.register({
      name: `daap-bound-agent-${Date.now()}`,
      scopes: [scope],
      redirectUris: [redirectUri],
      resourceServers: [resource],
      publicJwk,
    });

    expect(agent.did).toContain(`:agents:${agent.agentId}`);
    expect(agent.keyBindingConfigured).toBe(true);
    expect(agent.redirectUris).toEqual([redirectUri]);
    expect(agent.resourceServers).toEqual([resource]);

    const didResponse = await fetch(`${BASE_URL}/agents/${agent.agentId}/did.json`);
    expect(didResponse.status).toBe(200);
    const didDocument = await didResponse.json() as Record<string, unknown>;
    expect(didDocument['id']).toBe(agent.did);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    const authorization = await client.authorize({
      agentId: agent.agentId,
      userId: `principal-${Date.now()}`,
      scopes: [scope],
      audience: resource,
      redirectUri,
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    expect(authorization.sandbox).toBe(true);
    expect(authorization.code).toEqual(expect.any(String));

    const issued = await client.tokens.exchange({
      code: authorization.code!,
      agentId: agent.agentId,
      codeVerifier: verifier,
      redirectUri,
    });
    const claims = decodePayload(issued.grantToken);
    expect(claims['aud']).toBe(resource);
    expect(claims['client_id']).toBe(agent.agentId);
    expect(claims['scope']).toBe(scope);
    expect(claims['cnf']).toEqual({ jkt: agent.keyThumbprint });

    const recoveryKey = process.env.E2E_RECOVERY_KEY
      ?? `daap-refresh-${randomBytes(16).toString('hex')}`;
    const refreshed = await client.tokens.refresh({
      refreshToken: issued.refreshToken,
      agentId: agent.agentId,
      idempotencyKey: recoveryKey,
    });
    const recovered = await client.tokens.refresh({
      refreshToken: issued.refreshToken,
      agentId: agent.agentId,
      idempotencyKey: recoveryKey,
    });
    expect(recovered).toEqual(refreshed);

    await expect(client.tokens.refresh({
      refreshToken: issued.refreshToken,
      agentId: agent.agentId,
      idempotencyKey: `different-${randomBytes(16).toString('hex')}`,
    })).rejects.toThrow(/already used/i);

    const entry = await client.audit.log({
      agentId: agent.agentId,
      agentDid: agent.did,
      grantId: issued.grantId,
      principalId: String(claims['sub']),
      action: 'authorization.refresh.recovered',
      metadata: { test: 'daap-hardening' },
    });
    const checkpoint = await client.audit.checkpoint();
    expect(checkpoint.headEntryId).toBe(entry.entryId);
    expect(checkpoint.signedCheckpoint.split('.')).toHaveLength(3);
    expect(checkpoint.witnessRequired).toBe(true);

    const metadataResponse = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    expect(metadata['authorization_endpoint']).toBe(`${ISSUER}/oauth/authorize`);
    expect(metadata['token_endpoint']).toBe(`${ISSUER}/oauth/token`);
    expect(metadata['pushed_authorization_request_endpoint']).toBe(`${ISSUER}/oauth/par`);
    expect(metadata['require_pushed_authorization_requests']).toBe(true);
    expect(metadata['authorization_response_iss_parameter_supported']).toBe(true);
    expect(metadata['dpop_signing_alg_values_supported']).toEqual(expect.arrayContaining(['ES256']));
  }, 120_000);
});

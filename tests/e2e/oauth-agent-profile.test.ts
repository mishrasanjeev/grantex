import { afterAll, describe, expect, it } from 'vitest';
import { generateOAuthAgentKey, OAuthAgentClient } from '@grantex/sdk';

const API_BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const ISSUER = (process.env.E2E_ISSUER ?? API_BASE_URL).replace(/\/$/, '');
const RESOURCE = `${ISSUER}/oauth/resource`;
const REDIRECT_URI = 'https://client.example/callback';

let apiKey = '';
let agentId = '';

async function api(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}

async function authorization(client: OAuthAgentClient, includePrincipalHint = true) {
  const authorizationDetails = [{
    type: 'grantex_payment_limit',
    currency: 'USD',
    maximum: '100.00',
  }];
  const pending = await client.beginAuthorization({
    scopes: ['grantex.resource.read', 'payments.read'],
    ...(includePrincipalHint ? { principalHint: `oauth-e2e-principal-${Date.now()}` } : {}),
    authorizationDetails,
  });
  const response = await fetch(pending.authorizationUrl, { redirect: 'manual' });
  expect(response.status).toBe(303);
  const callback = response.headers.get('location');
  expect(callback).toBeTruthy();
  const replay = await fetch(pending.authorizationUrl, { redirect: 'manual' });
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: 'invalid_request_uri' });
  const callbackUrl = new URL(callback!);
  expect(callbackUrl.searchParams.get('state')).toBe(pending.state);
  expect(callbackUrl.searchParams.get('iss')).toBe(ISSUER);
  return { tokens: await client.completeAuthorization(callback!), authorizationDetails };
}

function tokenPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('Access token is not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

afterAll(async () => {
  if (apiKey && agentId) await api(`/v1/agents/${agentId}`, { method: 'DELETE' }).catch(() => undefined);
});

describe('OAuth agent-grants profile E2E', () => {
  it('covers PAR, RFC 9207, DPoP, token exchange, rotation, revocation, and replay response', async () => {
    const signup = await fetch(`${API_BASE_URL}/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `oauth-profile-e2e-${Date.now()}`, mode: 'sandbox' }),
    });
    expect(signup.status).toBe(201);
    apiKey = ((await signup.json()) as { apiKey: string }).apiKey;

    const key = await generateOAuthAgentKey();
    const registration = await api('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'OAuth Profile E2E Agent',
        description: 'Disposable client used by the OAuth profile E2E suite',
        scopes: ['grantex.resource.read', 'payments.read'],
        redirectUris: [REDIRECT_URI],
        resourceServers: [RESOURCE],
        publicJwk: key.publicJwk,
      }),
    });
    const registrationBody = await registration.text();
    expect(registration.status, registrationBody).toBe(201);
    agentId = (JSON.parse(registrationBody) as { agentId: string }).agentId;

    const duplicateKeyRegistration = await api('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Rejected Duplicate OAuth Agent Key',
        scopes: ['grantex.resource.read'],
        redirectUris: [REDIRECT_URI],
        resourceServers: [RESOURCE],
        publicJwk: key.publicJwk,
      }),
    });
    expect(duplicateKeyRegistration.status).toBe(409);
    expect(await duplicateKeyRegistration.json()).toMatchObject({ code: 'AGENT_KEY_CONFLICT' });

    const client = await OAuthAgentClient.create({
      issuer: ISSUER,
      clientId: agentId,
      redirectUri: REDIRECT_URI,
      resource: RESOURCE,
      privateKey: key.privateKey,
      publicJwk: key.publicJwk,
      allowInsecureLoopback: true,
    });

    expect(client.metadata.require_pushed_authorization_requests).toBe(true);
    expect(client.metadata.authorization_response_iss_parameter_supported).toBe(true);

    const { tokens: initial, authorizationDetails } = await authorization(client, false);
    expect(initial.token_type).toBe('DPoP');
    expect(initial.refresh_token).toMatch(/^ref_[A-Za-z0-9_-]{43}$/);
    const initialClaims = tokenPayload(initial.access_token);
    expect(initialClaims['authorization_details']).toEqual(authorizationDetails);
    expect(initialClaims).toMatchObject({
      client_id: agentId,
      scope: 'grantex.resource.read payments.read',
      aud: RESOURCE,
    });
    expect(initialClaims).not.toHaveProperty('scp');
    expect(initialClaims).not.toHaveProperty('agt');
    expect(initialClaims).not.toHaveProperty('dev');
    expect(initialClaims).not.toHaveProperty('grnt');

    const protectedResponse = await client.fetch(RESOURCE, initial.access_token);
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.json()).toMatchObject({ authorized: true, client_id: agentId });
    const bearerDowngrade = await fetch(RESOURCE, {
      headers: { Authorization: `Bearer ${initial.access_token}` },
    });
    expect(bearerDowngrade.status).toBe(401);
    await expect(client.attenuate(initial.access_token, ['payments.write']))
      .rejects.toThrow('invalid_scope');

    const attenuated = await client.attenuate(initial.access_token, ['grantex.resource.read']);
    expect(attenuated.issued_token_type).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(attenuated.scope).toBe('grantex.resource.read');
    expect(tokenPayload(attenuated.access_token)['authorization_details']).toEqual(authorizationDetails);
    expect((await client.fetch(RESOURCE, attenuated.access_token)).status).toBe(200);

    const rotated = await client.refresh(initial.refresh_token!);
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);
    expect(tokenPayload(rotated.access_token)['authorization_details']).toEqual(authorizationDetails);
    await client.revoke(rotated.access_token, 'access_token');
    expect((await client.fetch(RESOURCE, rotated.access_token)).status).toBe(401);

    const afterAccessRevocation = await client.refresh(rotated.refresh_token!);
    await client.revoke(afterAccessRevocation.refresh_token!, 'refresh_token');
    await expect(client.refresh(afterAccessRevocation.refresh_token!)).rejects.toThrow('invalid_grant');

    const { tokens: replayFamily } = await authorization(client);
    const replayChild = await client.refresh(replayFamily.refresh_token!);
    await expect(client.refresh(replayFamily.refresh_token!)).rejects.toThrow('invalid_grant');
    expect((await client.fetch(RESOURCE, replayChild.access_token)).status).toBe(401);

    const { tokens: keyRotationFamily } = await authorization(client);
    const replacementKey = await generateOAuthAgentKey();
    const rotation = await api(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ publicJwk: replacementKey.publicJwk }),
    });
    expect(rotation.status).toBe(200);
    await expect(client.refresh(keyRotationFamily.refresh_token!)).rejects.toThrow('invalid_dpop_proof');

    const deletion = await api(`/v1/agents/${agentId}`, { method: 'DELETE' });
    expect(deletion.status).toBe(204);
    agentId = '';
  }, 120_000);
});

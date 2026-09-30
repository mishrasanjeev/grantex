import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';
const CALLBACK = 'https://client.example/grants/callback';
const SECOND_CALLBACK = 'https://client.example/other/callback';

let client: Grantex;
let agentId: string;

function authorize(redirectUri: string) {
  return client.authorize({
    agentId,
    userId: `principal-${randomBytes(8).toString('hex')}`,
    scopes: ['records:read'],
    redirectUri,
    state: randomBytes(24).toString('hex'),
  });
}

beforeAll(async () => {
  const account = await Grantex.signup(
    { name: `redirect-e2e-${Date.now()}`, mode: 'live' },
    { baseUrl: BASE_URL },
  );
  client = new Grantex({ apiKey: account.apiKey, baseUrl: BASE_URL });
  const agent = await client.agents.register({
    name: 'Callback test agent',
    description: 'Exact redirect registration test',
    scopes: ['records:read'],
  });
  agentId = agent.agentId;
});

describe('live agent callback registration', () => {
  it('rejects an unregistered callback, then accepts exact updated callbacks', async () => {
    expect((await client.agents.get(agentId)).redirectUris).toEqual([]);
    await expect(authorize(CALLBACK)).rejects.toMatchObject({
      statusCode: 400, code: 'REDIRECT_URI_MISMATCH',
    });

    const updated = await client.agents.update(agentId, {
      redirectUris: [CALLBACK, SECOND_CALLBACK],
    });
    expect(updated.redirectUris).toEqual([CALLBACK, SECOND_CALLBACK]);
    expect((await client.agents.get(agentId)).redirectUris).toEqual([CALLBACK, SECOND_CALLBACK]);

    await expect(authorize(`${CALLBACK}/`)).rejects.toMatchObject({
      statusCode: 400, code: 'REDIRECT_URI_MISMATCH',
    });
    const authorization = await authorize(CALLBACK);
    expect(authorization.authRequestId).toEqual(expect.any(String));
    expect(authorization.consentUrl).toContain('/consent?req=');
    expect(authorization.code).toBeUndefined();

    const replaced = await client.agents.update(agentId, { redirectUris: [SECOND_CALLBACK] });
    expect(replaced.redirectUris).toEqual([SECOND_CALLBACK]);
    await expect(authorize(CALLBACK)).rejects.toMatchObject({
      statusCode: 400, code: 'REDIRECT_URI_MISMATCH',
    });
    expect((await authorize(SECOND_CALLBACK)).authRequestId).toEqual(expect.any(String));
  });

  it('rejects an unsafe URI and keeps the existing callback list', async () => {
    await expect(client.agents.update(agentId, {
      redirectUris: ['javascript:alert(1)'],
    })).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    expect((await client.agents.get(agentId)).redirectUris).toEqual([SECOND_CALLBACK]);
  });

  it('refuses another developer access to the agent', async () => {
    const other = await Grantex.signup(
      { name: `redirect-other-${Date.now()}`, mode: 'live' },
      { baseUrl: BASE_URL },
    );
    const otherClient = new Grantex({ apiKey: other.apiKey, baseUrl: BASE_URL });
    await expect(otherClient.agents.update(agentId, {
      redirectUris: [CALLBACK],
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect((await client.agents.get(agentId)).redirectUris).toEqual([SECOND_CALLBACK]);
  });

  it('clears callbacks explicitly and again rejects callback authorization', async () => {
    expect((await client.agents.update(agentId, { redirectUris: [] })).redirectUris).toEqual([]);
    await expect(authorize(SECOND_CALLBACK)).rejects.toMatchObject({
      statusCode: 400, code: 'REDIRECT_URI_MISMATCH',
    });
  });
});

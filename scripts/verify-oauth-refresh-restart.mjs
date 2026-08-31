import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { generateOAuthAgentKey, OAuthAgentClient } from '@grantex/sdk';

const baseUrl = (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const redirectUri = 'https://client.example/restart-callback';
const resource = `${baseUrl}/oauth/resource`;

function dockerCompose(args) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json()).status === 'healthy') return;
    } catch {
      // The service is expected to refuse connections while the container restarts.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('auth-service did not become healthy after restart');
}

async function api(apiKey, path, init) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function authorize(client) {
  const pending = await client.beginAuthorization({
    scopes: ['grantex.resource.read'],
    principalHint: `restart-principal-${Date.now()}`,
  });
  const consent = await fetch(pending.authorizationUrl, { redirect: 'manual' });
  if (consent.status !== 303) throw new Error(`authorization failed with HTTP ${consent.status}`);
  const callback = consent.headers.get('location');
  if (!callback) throw new Error('authorization response omitted Location');
  return client.completeAuthorization(callback);
}

const signup = await fetch(`${baseUrl}/v1/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `oauth-restart-check-${Date.now()}`, mode: 'sandbox' }),
});
if (signup.status !== 201) throw new Error(`signup failed with HTTP ${signup.status}`);
const { apiKey } = await signup.json();

const key = await generateOAuthAgentKey();
const registration = await api(apiKey, '/v1/agents', {
  method: 'POST',
  body: JSON.stringify({
    name: 'OAuth Refresh Restart Check',
    scopes: ['grantex.resource.read'],
    redirectUris: [redirectUri],
    resourceServers: [resource],
    publicJwk: key.publicJwk,
  }),
});
if (registration.status !== 201) throw new Error(`agent registration failed: ${await registration.text()}`);
const { agentId } = await registration.json();

try {
  const options = {
    issuer: baseUrl,
    clientId: agentId,
    redirectUri,
    resource,
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    allowInsecureLoopback: true,
  };
  const client = await OAuthAgentClient.create(options);
  const initial = await authorize(client);
  const recoveryKey = `restart-recovery-${crypto.randomUUID()}`;
  const committed = await client.refresh(initial.refresh_token, { idempotencyKey: recoveryKey });

  const envelope = dockerCompose([
    'exec', '-T', 'postgres', 'psql', '-U', 'grantex', '-d', 'grantex', '-Atc',
    "SELECT replay_grant_token FROM refresh_tokens WHERE replay_grant_token IS NOT NULL ORDER BY created_at DESC LIMIT 1;",
  ]);
  if (!envelope.startsWith('enc:v1:')) throw new Error('refresh replay payload is not an enc:v1 envelope');
  if (envelope.includes(committed.access_token) || envelope.includes(committed.refresh_token)) {
    throw new Error('refresh replay payload contains raw token material');
  }

  dockerCompose(['restart', 'auth-service']);
  await waitForHealth();

  const restartedClient = await OAuthAgentClient.create(options);
  const recovered = await restartedClient.refresh(initial.refresh_token, { idempotencyKey: recoveryKey });
  const { refresh_replay: replayMarker, expires_in: recoveredExpiresIn, ...recoveredTokens } = recovered;
  const { expires_in: committedExpiresIn, ...committedTokens } = committed;
  const lifetimeIsSafe = Number.isInteger(recoveredExpiresIn)
    && recoveredExpiresIn > 0
    && recoveredExpiresIn <= committedExpiresIn;
  if (replayMarker !== true || !lifetimeIsSafe || !isDeepStrictEqual(recoveredTokens, committedTokens)) {
    const fields = new Set([...Object.keys(committedTokens), ...Object.keys(recoveredTokens)]);
    const unequalFields = [...fields].filter((field) => !isDeepStrictEqual(committedTokens[field], recoveredTokens[field]));
    if (!lifetimeIsSafe) unequalFields.push('expires_in');
    throw new Error(`post-restart replay differed in fields: ${unequalFields.join(', ') || 'replay marker'}`);
  }
  console.log('PASS: encrypted OAuth refresh replay survived auth-service restart');
} finally {
  await api(apiKey, `/v1/agents/${agentId}`, { method: 'DELETE' }).catch(() => undefined);
}

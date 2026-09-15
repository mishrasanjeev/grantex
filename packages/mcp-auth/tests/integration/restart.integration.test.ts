import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as jose from 'jose';
import { databaseUrl, redisUrl } from './env.js';

/**
 * PRD G-7 acceptance: "state survives a restart". Each case starts the built
 * server as a separate OS process against real Postgres or Redis, creates
 * every kind of state, kills the process with SIGKILL (no graceful
 * shutdown), starts a fresh process on the same storage and finishes the
 * flows there.
 */

const SERVER = fileURLToPath(new URL('./fixtures/server-process.mjs', import.meta.url));
const REDIRECT_URI = 'https://app.example.com/callback';

let privateKey: jose.CryptoKey;
let jwks: Server;
let grantexIssuer: string;
const children = new Set<ChildProcess>();

beforeAll(async () => {
  const pair = await jose.generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'restart', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  grantexIssuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

interface Running {
  base: string;
  child: ChildProcess;
}

function start(env: Record<string, string>): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env, GRANTEX_ISSUER: grantexIssuer, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 30_000);
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /LISTENING (\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve({ base: `http://127.0.0.1:${match[1]}`, child });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`server exited with ${code}: ${stderr}`));
    });
  });
}

function kill(running: Running): Promise<void> {
  return new Promise((resolve) => {
    running.child.once('exit', () => {
      children.delete(running.child);
      resolve();
    });
    running.child.kill('SIGKILL');
  });
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(base: string) {
  const response = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'] }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret: string };
}

/** Starts an authorization; returns the state Grantex was given. */
async function authorize(base: string, clientId: string, challenge: string, clientState: string): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: clientState,
  });
  const response = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const grantexState = new URL(response.headers.get('location')!).searchParams.get('state');
  expect(grantexState).toBeTruthy();
  return grantexState!;
}

/** Completes upstream consent; returns the client's authorization code. */
async function callback(base: string, grantexState: string, clientState: string): Promise<string> {
  const response = await fetch(
    `${base}/callback?${new URLSearchParams({ code: `upstream-${grantexState.slice(0, 8)}`, state: grantexState })}`,
    { redirect: 'manual' },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe(clientState);
  return location.searchParams.get('code')!;
}

function token(base: string, body: Record<string, string>) {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function signGrant(clientId: string): Promise<string> {
  return new jose.SignJWT({ scp: ['tools:read'], aud: 'https://mcp.example.com/mcp' })
    .setProtectedHeader({ alg: 'RS256', kid: 'restart' })
    .setIssuer(grantexIssuer)
    .setSubject(clientId)
    .setJti(`grnt_${randomBytes(8).toString('hex')}`)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function introspect(base: string, grant: string): Promise<boolean> {
  const response = await fetch(`${base}/introspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: grant }),
  });
  return ((await response.json()) as { active: boolean }).active;
}

const backends: Array<{ name: string; env: () => Record<string, string>; skip: boolean }> = [
  {
    name: 'postgres',
    skip: !databaseUrl,
    env: () => ({ MCP_AUTH_STORAGE: 'postgres', MCP_AUTH_STORAGE_URL: databaseUrl! }),
  },
  {
    name: 'redis',
    skip: !redisUrl,
    env: () => ({
      MCP_AUTH_STORAGE: 'redis',
      MCP_AUTH_STORAGE_URL: redisUrl!,
      MCP_AUTH_REDIS_PREFIX: `grantex:mcp-auth:restart:${randomBytes(4).toString('hex')}:`,
    }),
  },
];

for (const backend of backends) {
  (backend.skip ? describe.skip : describe)(`state survives a server restart (${backend.name})`, () => {
    it('clients, pending consent, codes, refresh bindings and revocations outlive a killed process', async () => {
      const env = backend.env();
      const first = await start(env);

      // Created on the first process.
      const client = await registerClient(first.base);

      const pendingPkce = pkce();
      const pendingState = await authorize(first.base, client.client_id, pendingPkce.challenge, 'pending-state');

      const unredeemedPkce = pkce();
      const unredeemedCode = await callback(
        first.base,
        await authorize(first.base, client.client_id, unredeemedPkce.challenge, 'unredeemed-state'),
        'unredeemed-state',
      );

      const refreshPkce = pkce();
      const refreshCode = await callback(
        first.base,
        await authorize(first.base, client.client_id, refreshPkce.challenge, 'refresh-state'),
        'refresh-state',
      );
      const issued = await token(first.base, {
        grant_type: 'authorization_code',
        code: refreshCode,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: refreshPkce.verifier,
      });
      expect(issued.status).toBe(200);
      const { refresh_token: refreshToken } = (await issued.json()) as { refresh_token: string };

      const revokedGrant = await signGrant(client.client_id);
      const liveGrant = await signGrant(client.client_id);
      const revoke = await fetch(`${first.base}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: revokedGrant, client_id: client.client_id, client_secret: client.client_secret }),
      });
      expect(revoke.status).toBe(200);

      await kill(first);
      const second = await start(env);

      // The consent that was still pending completes on the new process.
      const lateCode = await callback(second.base, pendingState, 'pending-state');
      const late = await token(second.base, {
        grant_type: 'authorization_code',
        code: lateCode,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: pendingPkce.verifier,
      });
      expect(late.status).toBe(200);

      // A code issued before the restart is redeemable once, with its PKCE
      // binding intact: the wrong verifier spends it, so use the right one.
      const redeem = (verifier: string) => token(second.base, {
        grant_type: 'authorization_code',
        code: unredeemedCode,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
      });
      expect((await redeem(unredeemedPkce.verifier)).status).toBe(200);
      expect((await redeem(unredeemedPkce.verifier)).status).toBe(400);

      // The refresh token stays bound to its client.
      const refreshed = await token(second.base, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      });
      expect(refreshed.status).toBe(200);
      const replayedRefresh = await token(second.base, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      });
      expect(replayedRefresh.status).toBe(400);

      // The client secret registered before the restart still authenticates,
      // and a wrong one still does not.
      const wrongSecret = await token(second.base, {
        grant_type: 'refresh_token',
        refresh_token: 'rt_unknown',
        client_id: client.client_id,
        client_secret: 'not-the-secret',
      });
      expect(wrongSecret.status).toBe(401);

      // The revocation recorded before the restart still holds.
      expect(await introspect(second.base, revokedGrant)).toBe(false);
      expect(await introspect(second.base, liveGrant)).toBe(true);

      await kill(second);
    });
  });
}

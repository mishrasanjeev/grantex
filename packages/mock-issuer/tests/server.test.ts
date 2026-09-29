// SPDX-License-Identifier: Apache-2.0
//
// HTTP server mode: loopback only, the JWKS and the status lists with their
// media types, for the registry's REGISTRY_DEV_ISSUER_ORIGIN_MAP.

import { afterEach, describe, expect, it } from 'vitest';
import {
  MockIssuer,
  decodeBitstringStatusList,
  decodeTokenStatusList,
  signPossessionProof,
  startMockIssuerServer,
  type MockIssuerServer,
} from '../src/index.ts';
import { AGENT_DID, PROFILE, agentKeyPair, decodeJws } from './helpers.ts';

const servers: MockIssuerServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(issuer: MockIssuer, options: { rateLimitPerMinute?: number } = {}) {
  const server = await startMockIssuerServer({ issuer, ...options });
  servers.push(server);
  return server;
}

function issue(issuer: MockIssuer) {
  const agent = agentKeyPair();
  const challenge = issuer.createPossessionChallenge({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk });
  const possessionProof = signPossessionProof({ challenge, agentPrivateJwk: agent.privateJwk });
  return issuer.issuePassport({ agentDid: AGENT_DID, agentPublicJwk: agent.publicJwk, possessionProof, ...PROFILE });
}

describe('mock issuer server', () => {
  it('binds 127.0.0.1 only, on an ephemeral port by default', async () => {
    const server = await start(MockIssuer.create());
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.originMapEntry).toBe(`https://mock-issuer.example=http://127.0.0.1:${server.port}`);
  });

  it('refuses any other host', async () => {
    for (const host of ['0.0.0.0', '::', 'localhost', '192.0.2.10']) {
      await expect(
        startMockIssuerServer({ issuer: MockIssuer.create(), host: host as '127.0.0.1' }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('serves the JWKS as application/jwk-set+json', async () => {
    const issuer = MockIssuer.create();
    const server = await start(issuer);
    const response = await fetch(`${server.origin}/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/jwk-set+json');
    expect(await response.json()).toEqual(issuer.jwks());
  });

  it('serves the Token Status List and both Bitstring Status List credentials with their media types', async () => {
    const issuer = MockIssuer.create();
    const issued = issue(issuer);
    const server = await start(issuer);
    const { uri, idx } = issued.status.status_list;
    const path = new URL(uri).pathname; // /status/<n>
    expect(path).toMatch(/^\/status\/\d+$/);

    const tsl = await fetch(`${server.origin}${path}`);
    expect(tsl.status).toBe(200);
    expect(tsl.headers.get('content-type')).toBe('application/statuslist+jwt');
    expect(tsl.headers.get('cache-control')).toBe('public, max-age=1');
    expect(tsl.headers.get('access-control-allow-origin')).toBe('*');
    const tslClaims = decodeJws(await tsl.text()).payload;
    expect(tslClaims.sub).toBe(uri);

    for (const suffix of ['/bitstring', '/bitstring/suspension']) {
      const bsl = await fetch(`${server.origin}${path}${suffix}`);
      expect(bsl.status).toBe(200);
      expect(bsl.headers.get('content-type')).toBe('application/vc+jwt');
      expect(decodeJws(await bsl.text()).payload.id).toBe(`${uri}${suffix}`);
    }

    issuer.suspendPassport(issued.attestationId);
    const after = decodeJws(await (await fetch(`${server.origin}${path}`)).text()).payload;
    expect(decodeTokenStatusList(after.status_list as { bits: number; lst: string }).statusAt(idx)).toBe(2);
    const suspension = decodeJws(await (await fetch(`${server.origin}${path}/bitstring/suspension`)).text()).payload;
    const subject = suspension.credentialSubject as { encodedList: string };
    expect(decodeBitstringStatusList(subject.encodedList).isSet(idx)).toBe(true);
  });

  it('sees changes another process made to the state directory', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mock-issuer-test-'));
    try {
      const serving = MockIssuer.create({ dir });
      const issued = issue(serving);
      const server = await start(serving);
      const path = new URL(issued.status.status_list.uri).pathname;
      // A second instance on the same directory stands in for the CLI.
      MockIssuer.create({ dir }).revokePassport(issued.attestationId);
      const claims = decodeJws(await (await fetch(`${server.origin}${path}`)).text()).payload;
      expect(
        decodeTokenStatusList(claims.status_list as { bits: number; lst: string }).statusAt(issued.status.status_list.idx),
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers 404 for an unknown path or list and 405 for another method', async () => {
    const server = await start(MockIssuer.create());
    for (const path of ['/', '/status/', '/status/1', '/status/abc', '/status/1/bitstring/other', '/.well-known/other']) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
    }
    const post = await fetch(`${server.origin}/.well-known/jwks.json`, { method: 'POST', body: '{}' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('observes same-size revocations even when the file timestamp is unchanged', async () => {
    const { mkdtempSync, openSync, closeSync, readFileSync, rmSync, futimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mock-issuer-stamp-'));
    try {
      const serving = MockIssuer.create({ dir });
      const issued = issue(serving);
      const file = join(dir, 'state.json');
      const unchangedTime = new Date('2026-01-01T00:00:00Z');
      const initial = openSync(file, 'r+');
      let previous;
      try {
        previous = readFileSync(initial, 'utf8');
        futimesSync(initial, unchangedTime, unchangedTime);
      } finally {
        closeSync(initial);
      }
      const server = await start(serving);
      MockIssuer.create({ dir }).revokePassport(issued.attestationId);
      const updated = openSync(file, 'r+');
      try {
        expect(readFileSync(updated, 'utf8').length).toBe(previous.length);
        futimesSync(updated, unchangedTime, unchangedTime);
      } finally {
        closeSync(updated);
      }
      const path = new URL(issued.status.status_list.uri).pathname;
      const claims = decodeJws(await (await fetch(`${server.origin}${path}`)).text()).payload;
      expect(decodeTokenStatusList(claims.status_list as { bits: number; lst: string }).statusAt(issued.status.status_list.idx)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to serve cached active status when loaded state disappears', async () => {
    const { mkdtempSync, rmSync, unlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'mock-issuer-missing-'));
    try {
      const serving = MockIssuer.create({ dir });
      const issued = issue(serving);
      const server = await start(serving);
      unlinkSync(join(dir, 'state.json'));
      const path = new URL(issued.status.status_list.uri).pathname;
      expect((await fetch(`${server.origin}${path}`)).status).toBe(503);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('limits requests per client', async () => {
    const server = await start(MockIssuer.create(), { rateLimitPerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await fetch(`${server.origin}/.well-known/jwks.json`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

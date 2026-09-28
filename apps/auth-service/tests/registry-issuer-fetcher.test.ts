// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's issuer fetcher and its development-only origin override,
 * REGISTRY_DEV_ISSUER_ORIGIN_MAP.
 *
 * The map rewrites an issuer origin such as https://mock-issuer.example to a
 * loopback HTTP server, so tests and local development can serve an issuer's
 * status lists without a network. It is refused at startup, and by the
 * fetcher itself, in production. Without it the fetcher is HTTPS only, public
 * addresses only, bounded in size and time, and never follows a redirect.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IssuerFetchError,
  REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV,
  devIssuerOriginMapConfigError,
  fetchIssuerStatusList,
  parseDevIssuerOriginMap,
  rewriteIssuerUrl,
} from '../src/lib/registry/issuer-fetcher.js';

let server: Server;
let port: number;
let slowDelayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/status/ok') {
      res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
      res.end('a.b.c');
    } else if (req.url === '/status/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    } else if (req.url === '/status/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/status/ok` });
      res.end();
    } else if (req.url === '/status/large') {
      res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
      res.end('a'.repeat(1_048_577));
    } else if (req.url === '/status/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/statuslist+jwt' });
        res.end('a.b.c');
      }, slowDelayMs);
    } else if (req.url === '/status/missing') {
      res.writeHead(404);
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function devEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: `https://mock-issuer.example=http://127.0.0.1:${port}`, ...extra };
}

describe('REGISTRY_DEV_ISSUER_ORIGIN_MAP', () => {
  it('parses comma-separated origin pairs', () => {
    const map = parseDevIssuerOriginMap('https://mock-issuer.example=http://127.0.0.1:56901, https://issuer.example=http://localhost:56902');
    expect([...map.entries()]).toEqual([
      ['https://mock-issuer.example', 'http://127.0.0.1:56901'],
      ['https://issuer.example', 'http://localhost:56902'],
    ]);
  });

  it('is empty when unset or blank', () => {
    expect(parseDevIssuerOriginMap(undefined).size).toBe(0);
    expect(parseDevIssuerOriginMap('  ').size).toBe(0);
  });

  it.each([
    ['a pair without =', 'https://mock-issuer.example'],
    ['an http source', 'http://mock-issuer.example=http://127.0.0.1:56901'],
    ['a source with a path', 'https://mock-issuer.example/status=http://127.0.0.1:56901'],
    ['a target that is not loopback', 'https://mock-issuer.example=http://10.0.0.5:56901'],
    ['a target with a public host', 'https://mock-issuer.example=http://issuer.example:56901'],
    ['a target with a path', 'https://mock-issuer.example=http://127.0.0.1:56901/x'],
    ['a target with credentials', 'https://mock-issuer.example=http://u:p@127.0.0.1:56901'],
    ['the same source twice', 'https://a.example=http://127.0.0.1:1,https://a.example=http://127.0.0.1:2'],
  ])('refuses %s', (_name, value) => {
    expect(() => parseDevIssuerOriginMap(value)).toThrow(REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV);
  });

  it('is refused at startup in production, with a clear error', () => {
    const error = devIssuerOriginMapConfigError({
      NODE_ENV: 'production', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'https://mock-issuer.example=http://127.0.0.1:56901',
    });
    expect(error).toMatch(/REGISTRY_DEV_ISSUER_ORIGIN_MAP/);
    expect(error).toMatch(/production/);
  });

  it('is refused outside development and test (NODE_ENV unset counts as neither)', () => {
    expect(devIssuerOriginMapConfigError({ [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'https://a.example=http://127.0.0.1:1' }))
      .toMatch(/development/);
    expect(devIssuerOriginMapConfigError({ NODE_ENV: 'staging', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'https://a.example=http://127.0.0.1:1' }))
      .toMatch(/development/);
  });

  it('is accepted in development and test, and absent is always fine', () => {
    expect(devIssuerOriginMapConfigError({ NODE_ENV: 'test', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'https://a.example=http://127.0.0.1:1' })).toBeNull();
    expect(devIssuerOriginMapConfigError({ NODE_ENV: 'development', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'https://a.example=http://127.0.0.1:1' })).toBeNull();
    expect(devIssuerOriginMapConfigError({ NODE_ENV: 'production' })).toBeNull();
  });

  it('reports a malformed map at startup', () => {
    expect(devIssuerOriginMapConfigError({ NODE_ENV: 'test', [REGISTRY_DEV_ISSUER_ORIGIN_MAP_ENV]: 'nonsense' }))
      .toMatch(/REGISTRY_DEV_ISSUER_ORIGIN_MAP/);
  });

  it('rewrites only the mapped origin, keeping the path', () => {
    expect(rewriteIssuerUrl('https://mock-issuer.example/status/1', devEnv()))
      .toEqual({ url: `http://127.0.0.1:${port}/status/1`, rewritten: true });
    expect(rewriteIssuerUrl('https://issuer.example/status/1', devEnv()))
      .toEqual({ url: 'https://issuer.example/status/1', rewritten: false });
  });

  it('refuses to rewrite in production even if the map got past startup', () => {
    expect(() => rewriteIssuerUrl('https://mock-issuer.example/status/1', devEnv({ NODE_ENV: 'production' })))
      .toThrow(IssuerFetchError);
  });
});

describe('fetchIssuerStatusList', () => {
  it('fetches a status list through the origin map', async () => {
    await expect(fetchIssuerStatusList('https://mock-issuer.example/status/ok', { env: devEnv() })).resolves.toBe('a.b.c');
  });

  it.each([
    ['a redirect, which it never follows', 'redirect', 'http_status'],
    ['a 404', 'missing', 'http_status'],
    ['another media type', 'json', 'content_type'],
    ['a body over the size limit', 'large', 'too_large'],
  ])('refuses %s', async (_name, path, reason) => {
    const err = await fetchIssuerStatusList(`https://mock-issuer.example/status/${path}`, { env: devEnv() })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(IssuerFetchError);
    expect((err as IssuerFetchError).reason).toBe(reason);
  });

  it('gives up after its timeout', async () => {
    slowDelayMs = 400;
    const err = await fetchIssuerStatusList('https://mock-issuer.example/status/slow', { env: devEnv(), timeoutMs: 100 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(IssuerFetchError);
    expect((err as IssuerFetchError).reason).toBe('unreachable');
  });

  it('refuses plain http and loopback addresses without the map', async () => {
    for (const url of [`http://127.0.0.1:${port}/status/ok`, `https://127.0.0.1:${port}/status/ok`, 'https://localhost/status/ok']) {
      const err = await fetchIssuerStatusList(url, { env: { NODE_ENV: 'test' } }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(IssuerFetchError);
      expect((err as IssuerFetchError).reason).toBe('unreachable');
    }
  });
});

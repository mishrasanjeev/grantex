import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_OUTBOUND_RESPONSE_BYTES,
  safeFetch,
} from '../src/lib/url-security.js';

const servers: http.Server[] = [];

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  return { server, port: address.port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const localPolicy = {
  allowedProtocols: ['http:'],
  allowInsecureHttp: true,
  allowPrivateHosts: true,
} as const;

const localResolver = async () => [{ address: '127.0.0.1', family: 4 as const }];

describe('safeFetch response limits', () => {
  it('rejects a response whose declared Content-Length exceeds the limit', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Length': String(MAX_OUTBOUND_RESPONSE_BYTES + 1),
      });
      res.end();
    });

    await expect(safeFetch(
      `http://outbound.test:${port}/large`,
      {},
      localPolicy,
      localResolver,
    )).rejects.toThrow(/exceeds .* byte limit/);
  });

  it('stops buffering a chunked response once it crosses the limit', async () => {
    const { port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(Buffer.alloc(MAX_OUTBOUND_RESPONSE_BYTES, 0x61));
      res.end(Buffer.from('b'));
    });

    await expect(safeFetch(
      `http://outbound.test:${port}/stream`,
      {},
      localPolicy,
      localResolver,
    )).rejects.toThrow(/exceeds .* byte limit/);
  });

  it('returns responses at or below the limit', async () => {
    const { port } = await startServer((_req, res) => {
      res.end('ok');
    });

    const response = await safeFetch(
      `http://outbound.test:${port}/ok`,
      {},
      localPolicy,
      localResolver,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});

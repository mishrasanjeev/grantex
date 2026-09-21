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

describe('safeFetch request framing', () => {
  /** Records how the server saw one request. */
  async function echoRequest(init: Parameters<typeof safeFetch>[1]): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
    let seen: { headers: http.IncomingHttpHeaders; body: string } | undefined;
    const { port } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen = { headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') };
        res.end('ok');
      });
    });
    await safeFetch(`http://outbound.test:${port}/echo`, init, localPolicy, localResolver);
    if (!seen) throw new Error('the server did not see the request');
    return seen;
  }

  // Without this, node frames the body with Transfer-Encoding: chunked, which
  // is valid HTTP/1.1 but which plenty of servers and gateways refuse on a
  // POST - an OpenID Connect token endpoint among them.
  it('frames a request body by length, not chunked', async () => {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }).toString();
    const seen = await echoRequest({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(seen.headers['transfer-encoding']).toBeUndefined();
    expect(seen.body).toBe(body);
  });

  it('counts bytes, not characters, and leaves an explicit framing alone', async () => {
    const body = 'reason=stra\u00dfe\u00a0\u20ac';
    const seen = await echoRequest({ method: 'POST', body });
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(seen.body).toBe(body);

    const explicit = await echoRequest({
      method: 'POST',
      headers: { 'Content-Length': String(Buffer.byteLength('a=1')) },
      body: 'a=1',
    });
    expect(explicit.headers['content-length']).toBe('3');
  });

  it('sends no framing headers when there is no body', async () => {
    const seen = await echoRequest({ method: 'GET' });
    expect(seen.headers['content-length']).toBeUndefined();
    expect(seen.headers['transfer-encoding']).toBeUndefined();
  });
});

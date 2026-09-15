import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:https';
import type { Server, ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import selfsigned from 'selfsigned';
import { isPublicAddress } from '../src/lib/address-policy.js';
import {
  ClientMetadataError,
  createClientMetadataResolver,
  isClientIdMetadataUrl,
  parseClientMetadataDocument,
} from '../src/lib/client-metadata.js';
import type { ClientIdMetadataDocumentOptions } from '../src/lib/client-metadata.js';

describe('client_id URL shape', () => {
  it('accepts an https URL with a path', () => {
    expect(isClientIdMetadataUrl('https://app.example.com/oauth/client.json')).toBe(true);
    expect(isClientIdMetadataUrl('https://app.example.com/client?v=2')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const value of [
      'http://app.example.com/client.json',
      'https://app.example.com',
      'https://app.example.com/',
      'https://app.example.com/client.json#frag',
      'https://user:pw@app.example.com/client.json',
      'https://app.example.com/a/../client.json',
      'https://app.example.com/./client.json',
      'https://app.example.com/a/%2e%2e/client.json',
      'not a url',
      'test-client-id',
      42,
    ]) {
      expect(isClientIdMetadataUrl(value), String(value)).toBe(false);
    }
  });
});

describe('SSRF address policy', () => {
  it('refuses loopback, private, link-local, CGNAT, multicast, documentation and embedded-IPv4 forms', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9', '198.18.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
      '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1', '[::1]', 'fe80::1%eth0', 'localhost', 'example.com', '',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('allows public unicast addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '[2a00:1450:4001:80e::200e]']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('metadata document validation', () => {
  const id = 'https://app.example.com/oauth/client.json';
  const valid = {
    client_id: id,
    client_name: 'Example MCP client',
    redirect_uris: ['http://127.0.0.1:3000/callback', 'https://app.example.com/callback'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  it('maps a valid document to a public client', () => {
    expect(parseClientMetadataDocument(id, valid, 0)).toMatchObject({
      clientId: id,
      clientName: 'Example MCP client',
      redirectUris: valid.redirect_uris,
      grantTypes: ['authorization_code'],
      tokenEndpointAuthMethod: 'none',
    });
  });

  const cases: Array<[string, unknown, string]> = [
    ['client_id differs by a trailing slash', { ...valid, client_id: `${id}/` }, 'client_id_mismatch'],
    ['client_id missing', { ...valid, client_id: undefined }, 'client_id_mismatch'],
    ['client_name missing', { ...valid, client_name: undefined }, 'invalid_metadata'],
    ['redirect_uris missing', { ...valid, redirect_uris: undefined }, 'invalid_metadata'],
    ['redirect_uris empty', { ...valid, redirect_uris: [] }, 'invalid_metadata'],
    ['plain http redirect on a public host', { ...valid, redirect_uris: ['http://app.example.com/callback'] }, 'invalid_redirect_uri'],
    ['custom scheme redirect', { ...valid, redirect_uris: ['app-example://callback'] }, 'invalid_redirect_uri'],
    ['redirect with fragment', { ...valid, redirect_uris: ['https://app.example.com/cb#x'] }, 'invalid_redirect_uri'],
    ['a client secret', { ...valid, client_secret: 'shared' }, 'unsupported_auth_method'],
    ['client_secret_basic', { ...valid, token_endpoint_auth_method: 'client_secret_basic' }, 'unsupported_auth_method'],
    ['private_key_jwt', { ...valid, token_endpoint_auth_method: 'private_key_jwt' }, 'unsupported_auth_method'],
    ['implicit grant', { ...valid, grant_types: ['implicit'] }, 'invalid_metadata'],
    ['response_types without code', { ...valid, response_types: ['token'] }, 'invalid_metadata'],
    ['a JSON array', [valid], 'invalid_json'],
  ];
  for (const [name, document, reason] of cases) {
    it(`rejects ${name} (${reason})`, () => {
      try {
        parseClientMetadataDocument(id, document, 0);
        expect.unreachable('document should have been rejected');
      } catch (err) {
        expect(err).toBeInstanceOf(ClientMetadataError);
        expect((err as ClientMetadataError).reason).toBe(reason);
      }
    });
  }
});

describe('fetching metadata documents (real https, local server)', () => {
  let server: Server;
  let port: number;
  let ca: string;
  let hits = 0;
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

  beforeAll(async () => {
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      keyType: 'ec',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
    });
    ca = pems.cert;
    server = createServer({ key: pems.private, cert: pems.cert } as ServerOptions, (req, res) => {
      hits += 1;
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const clientId = () => `https://localhost:${port}/oauth/client.json`;
  const documentFor = (id: string) => ({ client_id: id, client_name: 'Local client', redirect_uris: ['http://127.0.0.1:3000/callback'] });

  // Test seams: resolve "localhost" to the local server and allow loopback
  // for this server only. Production uses real DNS and the public-address policy.
  function resolver(options: ClientIdMetadataDocumentOptions = {}, now?: () => number) {
    return createClientMetadataResolver(options, {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isAddressAllowed: (address) => address === '127.0.0.1',
      ca,
      ...(now !== undefined ? { now } : {}),
    });
  }

  async function reason(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof ClientMetadataError) return err.reason;
      throw err;
    }
    return 'resolved';
  }

  it('fetches, validates and caches a document', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(documentFor(clientId())));
    };
    hits = 0;
    const r = resolver();
    const [a, b] = await Promise.all([r.resolve(clientId()), r.resolve(clientId())]);
    expect(a.clientName).toBe('Local client');
    expect(b.redirectUris).toEqual(['http://127.0.0.1:3000/callback']);
    await r.resolve(clientId());
    expect(hits).toBe(1);
  });

  it('honours max-age, capped by maxCacheTtlSeconds, and refetches after expiry', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      res.end(JSON.stringify(documentFor(clientId())));
    };
    hits = 0;
    let clock = 1_000_000;
    const r = resolver({ maxCacheTtlSeconds: 60 }, () => clock);
    await r.resolve(clientId());
    clock += 59_000;
    await r.resolve(clientId());
    expect(hits).toBe(1);
    clock += 2_000;
    await r.resolve(clientId());
    expect(hits).toBe(2);
  });

  it('does not cache no-store responses', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(documentFor(clientId())));
    };
    hits = 0;
    const r = resolver();
    await r.resolve(clientId());
    await r.resolve(clientId());
    expect(hits).toBe(2);
  });

  it('does not follow redirects', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
    };
    expect(await reason(resolver().resolve(clientId()))).toBe('redirect_not_followed');
  });

  it('refuses a non-200 status, a wrong content type and invalid JSON', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); };
    expect(await reason(resolver().resolve(clientId()))).toBe('http_status');
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); };
    expect(await reason(resolver().resolve(clientId()))).toBe('invalid_content_type');
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json'); };
    expect(await reason(resolver().resolve(clientId()))).toBe('invalid_json');
  });

  it('enforces the size limit on declared and streamed bodies', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999' });
      res.end('{}');
    };
    expect(await reason(resolver({ maxBytes: 1024 }).resolve(clientId()))).toBe('too_large');
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"padding":"');
      res.write('x'.repeat(4096));
      res.end('"}');
    };
    expect(await reason(resolver({ maxBytes: 1024 }).resolve(clientId()))).toBe('too_large');
  });

  it('gives up at the deadline on a server that never answers', async () => {
    handler = () => { /* never responds */ };
    const started = Date.now();
    expect(await reason(resolver({ timeoutMs: 300 }).resolve(clientId()))).toBe('fetch_timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('fails closed when the document is for another client_id', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(documentFor('https://attacker.example.org/client.json')));
    };
    expect(await reason(resolver().resolve(clientId()))).toBe('client_id_mismatch');
  });

  it('verifies the TLS certificate', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
    const untrusted = createClientMetadataResolver({}, {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isAddressAllowed: () => true,
    });
    expect(await reason(untrusted.resolve(clientId()))).toBe('fetch_failed');
  });

  it('with the default policy, refuses a name that resolves to a private address before connecting', async () => {
    hits = 0;
    const r = createClientMetadataResolver({}, {
      resolve: async () => [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }],
    });
    expect(await reason(r.resolve('https://app.example.com/client.json'))).toBe('address_not_allowed');
    const literal = createClientMetadataResolver();
    expect(await reason(literal.resolve(`https://127.0.0.1:${port}/client.json`))).toBe('address_not_allowed');
    expect(await reason(literal.resolve('https://[::1]/client.json'))).toBe('address_not_allowed');
    expect(hits).toBe(0);
  });

  it('applies the host trust policy and can be disabled', async () => {
    expect(await reason(resolver({ allowedHosts: ['*.example.com'] }).resolve(clientId()))).toBe('host_not_trusted');
    expect(await reason(resolver({ enabled: false }).resolve(clientId()))).toBe('disabled');
  });

  it('reports DNS failure with a reason', async () => {
    const r = createClientMetadataResolver({}, { resolve: async () => { throw new Error('ENOTFOUND'); } });
    expect(await reason(r.resolve('https://app.example.com/client.json'))).toBe('dns_failed');
  });
});

describe('metadata-document clients at the authorization endpoint', () => {
  it('fails closed with invalid_client when the document host is not public', async () => {
    const { createMcpAuthServer } = await import('../src/server.js');
    const { seededStorage, asGrantex, mockGrantex, TEST_CHALLENGE, TEST_RESOURCE } = await import('./helpers.js');
    const grantex = mockGrantex();
    const app = await createMcpAuthServer({
      grantex: asGrantex(grantex),
      agentId: 'agent-1',
      scopes: ['read'],
      issuer: 'https://auth.example.com',
      resource: TEST_RESOURCE,
      storage: await seededStorage(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        // "localhost" resolves to a loopback address without any network access.
        client_id: 'https://localhost/oauth/client.json',
        redirect_uri: 'http://127.0.0.1:3000/callback',
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_client' });
    expect(response.json().error_description).toMatch(/address_not_allowed/);
    expect(response.headers['location']).toBeUndefined();
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('never looks a URL-shaped client_id up in registered clients', async () => {
    const { createMcpAuthServer } = await import('../src/server.js');
    const { seededStorage, clientRecord, asGrantex, mockGrantex, TEST_CHALLENGE, TEST_RESOURCE } = await import('./helpers.js');
    const storage = await seededStorage(clientRecord({ clientId: 'http://app.example.com/client.json' }));
    const spy = vi.spyOn(storage, 'getClient');
    const app = await createMcpAuthServer({
      grantex: asGrantex(mockGrantex()),
      agentId: 'agent-1',
      scopes: ['read'],
      issuer: 'https://auth.example.com',
      resource: TEST_RESOURCE,
      storage,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/authorize',
      query: {
        response_type: 'code',
        client_id: 'http://app.example.com/client.json',
        redirect_uri: 'https://app.example.com/callback',
        code_challenge: TEST_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_client');
    expect(spy).not.toHaveBeenCalled();
  });
});

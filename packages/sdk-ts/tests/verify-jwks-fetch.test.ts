/**
 * With `boundedJwksFetch: true` the JWKS fetch is bounded, and `issuerDid`
 * must be a usable did:web. Without it (the default), both behave as they did
 * before the option existed.
 *
 * Whoever operates a JWKS endpoint controls the response, so the bounded
 * verifier reads at most 64 KiB of it, only as `application/json` or
 * `application/jwk-set+json`, takes at most 128 keys from it, and gives the
 * whole fetch one deadline. Those checks run against a real HTTP server on the
 * loopback interface with real JOSE, so the streaming read is exercised
 * rather than a mock of it. A `did:web` issuer is checked against the did:web
 * method specification before anything is fetched; those cases stub fetch,
 * since they resolve to HTTPS URLs on example domains.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { clearRemoteJwksCache, verifyGrantToken } from '../src/verify.js';
import { verifyDecisionGrant } from '../src/decisions/verify.js';
import type { DecisionAction } from '../src/decisions/action.js';
import { GrantexTokenError } from '../src/errors.js';

const ISSUER = 'https://issuer.example';

let privateKey: CryptoKey;
let publicJwk: JWK;
let jwksBody: string;

async function token(issuer = ISSUER): Promise<string> {
  return new SignJWT({
    scope: 'catalog:read',
    'urn:grantex:grant': {
      agent_did: 'did:grantex:ag_jwks_fetch',
      developer_id: 'dev_jwks_fetch',
      grant_id: 'grnt_jwks_fetch',
    },
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'ec-1', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setSubject('shopper-01')
    .setJti('tok_jwks_fetch')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

// ─── A JWKS endpoint on the loopback interface ───────────────────────────────

type Route = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Route>();
const requestHeaders: IncomingMessage['headers'][] = [];
let server: Server;
let origin: string;

function respond(
  body: string | Buffer,
  contentType: string | null = 'application/json',
  { status = 200, length = true, headers = {} as Record<string, string> } = {},
): Route {
  return (_req, res) => {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    if (contentType !== null) res.setHeader('Content-Type', contentType);
    if (length) res.setHeader('Content-Length', String(bytes.length));
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.writeHead(status);
    // Without a Content-Length node sends the body chunked, so the client can
    // only find its size by reading it.
    res.end(bytes);
  };
}

/**
 * Send the headers at once, then the body a little at a time: each read
 * completes quickly, so only a deadline on the whole fetch stops it.
 */
function drip(body: string, pieces: number, intervalMs: number): Route {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    res.flushHeaders();
    const step = Math.max(1, Math.ceil(body.length / pieces));
    let offset = 0;
    const timer = setInterval(() => {
      if (offset >= body.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(body.slice(offset, offset + step));
      offset += step;
    }, intervalMs);
    res.on('close', () => clearInterval(timer));
  };
}

function stall(body: string, pauseMs: number): Route {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
    res.flushHeaders();
    const timer = setTimeout(() => res.end(body), pauseMs);
    res.on('close', () => clearTimeout(timer));
  };
}

const url = (path: string): string => `${origin}${path}`;

function keySet(count: number): string {
  const decoys = Array.from({ length: count - 1 }, (_, n) => ({ ...publicJwk, kid: `decoy-${n}` }));
  return JSON.stringify({ keys: [...decoys, publicJwk] });
}

/** The option that turns the bounds and the did:web checks on. */
const BOUNDED = { boundedJwksFetch: true } as const;

const verify = async (jwksUri: string, options: { boundedJwksFetch?: boolean } = {}) =>
  verifyGrantToken(await token(), { jwksUri, issuer: ISSUER, ...options });

/** A valid key set padded past the 64 KiB cap. */
function oversizedKeySet(): string {
  return JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(70 * 1024) });
}

type DecisionFixture = { now: number; action: DecisionAction; base_claims: Record<string, unknown> };

function loadDecisionFixture(): DecisionFixture {
  return JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'decision-grant', 'verification.json'),
    'utf-8',
  )) as DecisionFixture;
}

async function decisionGrant(decisions: DecisionFixture): Promise<string> {
  return new SignJWT({ ...decisions.base_claims, iss: ISSUER })
    .setProtectedHeader({ alg: 'ES256', kid: 'ec-1', typ: 'decision+jwt' })
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'ec-1', alg: 'ES256', use: 'sig' };
  jwksBody = JSON.stringify({ keys: [publicJwk] });
  server = createServer((req, res) => {
    requestHeaders.push(req.headers);
    const route = routes.get(req.url ?? '');
    if (typeof route !== 'function') {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  routes.clear();
  clearRemoteJwksCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bounded JWKS fetch', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/jwk-set+json',
    'Application/JWK-Set+JSON; charset="UTF-8"',
  ])('reads a key set served as %s and verifies the token', async (contentType) => {
    routes.set('/jwks', respond(jwksBody, contentType));
    await expect(verify(url('/jwks'), BOUNDED)).resolves.toMatchObject({ principalId: 'shopper-01' });
  });

  it('asks for a JSON key set', async () => {
    routes.set('/jwks', respond(jwksBody));
    await verify(url('/jwks'), BOUNDED);
    expect(requestHeaders.at(-1)?.['accept']).toBe('application/json, application/jwk-set+json');
  });

  it('refuses a response declaring more than 64 KiB', async () => {
    routes.set('/big', respond(JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(64 * 1024) })));
    await expect(verify(url('/big'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*larger than 65536 bytes/);
  });

  it('cuts off a response without a length at 64 KiB', async () => {
    // One MiB of valid JSON with no Content-Length: the size is only known by
    // reading, and the read has to stop at the cap.
    routes.set('/unbounded', respond(JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(1024 * 1024) }), 'application/json', { length: false }));
    await expect(verify(url('/unbounded'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*larger than 65536 bytes/);
  });

  it('measures a compressed response by its decoded size', async () => {
    // A few KiB on the wire that decode past the cap.
    const padded = JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(1024 * 1024) });
    routes.set('/gzip', respond(gzipSync(padded), 'application/json', { headers: { 'Content-Encoding': 'gzip' } }));
    await expect(verify(url('/gzip'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*larger than 65536 bytes/);
  });

  it('reads a response of exactly 64 KiB', async () => {
    const empty = JSON.stringify({ keys: [publicJwk], padding: '' });
    const body = JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(64 * 1024 - empty.length) });
    expect(body.length).toBe(64 * 1024);
    routes.set('/edge', respond(body));
    await expect(verify(url('/edge'), BOUNDED)).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it.each([
    'text/html',
    'text/plain',
    'application/octet-stream',
    'application/jwk+json',
    'application/json-seq',
    'application/jsonx',
    'application/json; charset=iso-8859-1',
    'application/json; profile=x',
    null,
  ])('refuses a response served as %s', async (contentType) => {
    routes.set('/typed', respond(jwksBody, contentType));
    await expect(verify(url('/typed'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*Content-Type/);
  });

  it('refuses more than 128 keys', async () => {
    routes.set('/many', respond(keySet(129)));
    await expect(verify(url('/many'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*129 keys; the limit is 128/);
  });

  it('reads 128 keys', async () => {
    routes.set('/max', respond(keySet(128)));
    await expect(verify(url('/max'), BOUNDED)).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it('abandons a response that trickles past the deadline', async () => {
    // Every piece arrives well inside any per-read timeout; only a deadline on
    // the whole fetch ends it. The deadline is shortened for the test.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(Math.min(ms, 500)));
    routes.set('/drip', drip(jwksBody, 20, 150));
    const started = Date.now();
    await expect(verify(url('/drip'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*within 5000 ms/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('abandons a response that stalls past the deadline', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(Math.min(ms, 500)));
    routes.set('/stall', stall(jwksBody, 3000));
    const started = Date.now();
    await expect(verify(url('/stall'), BOUNDED)).rejects.toThrow(/Failed to fetch JWKS .*within 5000 ms/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('does not cache a failed fetch', async () => {
    routes.set('/flaky', respond(jwksBody, 'text/html'));
    await expect(verify(url('/flaky'), BOUNDED)).rejects.toThrow(/Content-Type/);
    routes.set('/flaky', respond(jwksBody));
    await expect(verify(url('/flaky'), BOUNDED)).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it.each([203, 302, 404, 503])('refuses HTTP %i', async (status) => {
    routes.set('/status', respond(jwksBody, 'application/json', { status, headers: { Location: '/jwks' } }));
    routes.set('/jwks', respond(jwksBody));
    await expect(verify(url('/status'), BOUNDED)).rejects.toThrow(new RegExp(`Failed to fetch JWKS .*HTTP ${status}`));
  });

  it('refuses a body that is not a key set', async () => {
    routes.set('/list', respond('[1, 2, 3]'));
    await expect(verify(url('/list'), BOUNDED)).rejects.toThrow(/JWKS/);
  });

  it('fetches decision-grant keys with the same bounds', async () => {
    const decisions = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'decision-grant', 'verification.json'),
      'utf-8',
    )) as { now: number; action: DecisionAction; base_claims: Record<string, unknown> };
    const grant = await new SignJWT({ ...decisions.base_claims, iss: ISSUER })
      .setProtectedHeader({ alg: 'ES256', kid: 'ec-1', typ: 'decision+jwt' })
      .sign(privateKey);
    routes.set('/decision-keys', respond(JSON.stringify({ keys: [publicJwk], padding: 'x'.repeat(64 * 1024) })));
    await expect(verifyDecisionGrant(grant, decisions.action, 'v7', {
      issuer: ISSUER,
      jwksUri: url('/decision-keys'),
      now: decisions.now,
      boundedJwksFetch: true,
    })).rejects.toThrow(/larger than 65536 bytes/);
  });
});

describe('did:web issuerDid', () => {
  function serveJwksAnywhere() {
    const fetchMock = vi.fn(async () => new Response(jwksBody, { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each([
    ['did:web:issuer.example', 'https://issuer.example/.well-known/jwks.json', 'https://issuer.example'],
    ['did:web:issuer.example%3A8443', 'https://issuer.example:8443/.well-known/jwks.json', 'https://issuer.example:8443'],
    ['did:web:issuer.example:tenants:acme', 'https://issuer.example/tenants/acme/.well-known/jwks.json', 'https://issuer.example/tenants/acme'],
    [
      'did:web:auth.issuer.example%3a8443:t-01:acme_kyb',
      'https://auth.issuer.example:8443/t-01/acme_kyb/.well-known/jwks.json',
      'https://auth.issuer.example:8443/t-01/acme_kyb',
    ],
    // An internationalized domain in its IDNA A-label form (did:web §3.5).
    ['did:web:xn--bcher-kva.example', 'https://xn--bcher-kva.example/.well-known/jwks.json', 'https://xn--bcher-kva.example'],
  ])('resolves %s to its JWKS', async (issuerDid, jwksUri, issuer) => {
    const fetchMock = serveJwksAnywhere();
    const grant = await verifyGrantToken(await token(issuer), {
      jwksUri: 'https://unused.example/jwks.json',
      issuerDid,
      boundedJwksFetch: true,
    });
    expect(grant.principalId).toBe('shopper-01');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(jwksUri);
  });

  it.each([
    // did:web §2.3: the identifier MUST NOT include IP addresses.
    ['did:web:127.0.0.1', 'IP address'],
    ['did:web:10.0.0.8', 'IP address'],
    ['did:web:169.254.169.254', 'IP address'],
    ['did:web:0x7f.0.0.1', 'IP address'],
    ['did:web:2130706433', 'IP address'],
    ['did:web:[::1]', 'IP address'],
    ['did:web:%5B%3A%3A1%5D', 'IP address'],
    // Names that only mean something on this host or this network.
    ['did:web:localhost', 'local'],
    ['did:web:LOCALHOST%3A3000', 'local'],
    ['did:web:api.localhost', 'local'],
    ['did:web:printer.local', 'local'],
    ['did:web:nas.home.arpa', 'local'],
    ['did:web:vault.internal', 'local'],
    // A fully qualified domain name, not a single label.
    ['did:web:intranet', 'fully qualified'],
    // No user information.
    ['did:web:user@issuer.example', 'user information'],
    ['did:web:user%40issuer.example', 'user information'],
    ['did:web:shopper-01:secret@issuer.example', 'user information'],
    // A percent-encoded colon introduces a port, and only a port.
    ['did:web:issuer.example%3A0', 'port'],
    ['did:web:issuer.example%3A65536', 'port'],
    ['did:web:issuer.example%3A0443', 'port'],
    ['did:web:issuer.example%3Ahttps', 'port'],
    ['did:web:issuer.example%3A', 'port'],
    // Path segments are plain DID characters, never traversal.
    ['did:web:issuer.example:..:admin', 'path'],
    ['did:web:issuer.example:.', 'path'],
    ['did:web:issuer.example::acme', 'path'],
    ['did:web:issuer.example:', 'path'],
    ['did:web:issuer.example:%2e%2e', 'path'],
    ['did:web:issuer.example:a%2Fb', 'path'],
    // Host names are letters, digits and hyphens.
    ['did:web:', 'domain name'],
    ['did:web:-issuer.example', 'domain name'],
    ['did:web:issuer_.example', 'domain name'],
    ['did:web:issuer.example.', 'domain name'],
    ['did:web:iss%75er.example', 'domain name'],
    ['did:web:issuer.example/jwks', 'domain name'],
    ['did:web:issuer.example?x=1', 'domain name'],
    ['did:web:issuer.example#frag', 'domain name'],
    [`did:web:${'a'.repeat(64)}.example`, 'domain name'],
    ['did:web:b%C3%BCcher.example', 'domain name'],
    // did:web §3.5: no Unicode in the identifier. IDNA would map each of
    // these to another ASCII host, or fail, so none is mapped: the Kelvin
    // sign, dotless i, dotted capital I, long s, a U-label, an ideographic
    // full stop, and non-ASCII in a path segment and in a port.
    ['did:web:Keys.example', 'ASCII'],
    ['did:web:ıssuer.example', 'ASCII'],
    ['did:web:İssuer.example', 'ASCII'],
    ['did:web:ſecure.example', 'ASCII'],
    ['did:web:bücher.example', 'ASCII'],
    ['did:web:issuer。example', 'ASCII'],
    ['did:web:issuer.example:tenänt', 'ASCII'],
    ['did:web:issuer.example%3A８４４３', 'ASCII'],
    // Only did:web can be resolved; another method is not quietly ignored.
    ['did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp', 'did:web'],
    ['DID:WEB:issuer.example', 'did:web'],
    ['https://issuer.example', 'did:web'],
    ['', 'did:web'],
  ])('refuses %s before any fetch', async (issuerDid, reason) => {
    const fetchMock = serveJwksAnywhere();
    const attempt = verifyGrantToken(await token(), {
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
      issuerDid,
      boundedJwksFetch: true,
    });
    await expect(attempt).rejects.toBeInstanceOf(GrantexTokenError);
    await expect(attempt).rejects.toThrow(/issuerDid/);
    await expect(attempt).rejects.toThrow(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats issuerDid: null as no DID, as the Python SDK treats None', async () => {
    const fetchMock = serveJwksAnywhere();
    const grant = await verifyGrantToken(await token(), {
      jwksUri: 'https://issuer.example/.well-known/jwks.json',
      issuerDid: null,
      boundedJwksFetch: true,
    });
    expect(grant.principalId).toBe('shopper-01');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://issuer.example/.well-known/jwks.json');
  });
});

// ─── Without boundedJwksFetch (the default) ──────────────────────────────────
//
// Until a major release turns the option on by default, leaving it out, or
// setting it to false, keeps the fetch and the issuerDid handling of earlier
// releases: each case here is refused by the bounded verifier above.

describe('without boundedJwksFetch, the JWKS fetch is unchanged', () => {
  it.each([
    ['left out', {}],
    ['false', { boundedJwksFetch: false }],
  ])('reads a key set larger than 64 KiB when the option is %s', async (_, options) => {
    routes.set('/big', respond(oversizedKeySet()));
    await expect(verify(url('/big'), options)).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it('reads a key set larger than 64 KiB sent without a length', async () => {
    routes.set('/unbounded', respond(oversizedKeySet(), 'application/json', { length: false }));
    await expect(verify(url('/unbounded'))).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it.each(['text/plain', 'text/html', null])('reads a key set served as %s', async (contentType) => {
    routes.set('/typed', respond(jwksBody, contentType));
    await expect(verify(url('/typed'))).resolves.toMatchObject({ principalId: 'shopper-01' });
  });

  it('reads more than 128 keys', async () => {
    routes.set('/many', respond(keySet(129)));
    await expect(verify(url('/many'))).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
  });

  it('reads decision-grant keys larger than 64 KiB', async () => {
    const decisions = loadDecisionFixture();
    routes.set('/decision-keys-default', respond(oversizedKeySet()));
    await expect(verifyDecisionGrant(await decisionGrant(decisions), decisions.action, 'v7', {
      issuer: ISSUER,
      jwksUri: url('/decision-keys-default'),
      now: decisions.now,
    })).resolves.toMatchObject({ iss: ISSUER });
  });
});

describe('without boundedJwksFetch, issuerDid is read as before', () => {
  function serveJwksAnywhere() {
    // text/plain: the bounded fetch would refuse it, the earlier one does not.
    const fetchMock = vi.fn(async () => new Response(jwksBody, { status: 200, headers: { 'content-type': 'text/plain' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each([
    // Hosts the did:web checks refuse are fetched as written.
    ['did:web:127.0.0.1', 'https://127.0.0.1/.well-known/jwks.json', 'https://127.0.0.1'],
    ['did:web:localhost', 'https://localhost/.well-known/jwks.json', 'https://localhost'],
    ['did:web:vault.internal', 'https://vault.internal/.well-known/jwks.json', 'https://vault.internal'],
    ['did:web:intranet', 'https://intranet/.well-known/jwks.json', 'https://intranet'],
    ['did:web:issuer.example:tenants:acme', 'https://issuer.example/tenants/acme/.well-known/jwks.json', 'https://issuer.example/tenants/acme'],
  ])('fetches %s from its host as written', async (issuerDid, jwksUri, issuer) => {
    const fetchMock = serveJwksAnywhere();
    const grant = await verifyGrantToken(await token(issuer), {
      jwksUri: 'https://unused.example/jwks.json',
      issuerDid,
    });
    expect(grant.principalId).toBe('shopper-01');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(jwksUri);
  });

  it('does not decode a percent-encoded port', async () => {
    // did:web:<host>%3A<port> becomes https://<host>%3A<port>/..., which is
    // not a valid URL: the error is the URL parser's, and nothing is fetched.
    const fetchMock = serveJwksAnywhere();
    const attempt = verifyGrantToken(await token(), {
      jwksUri: url('/jwks'),
      issuerDid: `did:web:127.0.0.1%3A${new URL(origin).port}`,
    });
    await expect(attempt).rejects.toThrow(TypeError);
    await expect(attempt).rejects.not.toBeInstanceOf(GrantexTokenError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://elsewhere.example',
    'DID:WEB:elsewhere.example',
    'did:example:elsewhere',
    '',
  ])('ignores %j, which is not a did:web identifier, and reads jwksUri', async (issuerDid) => {
    routes.set('/jwks', respond(jwksBody));
    const before = requestHeaders.length;
    const grant = await verifyGrantToken(await token(), { jwksUri: url('/jwks'), issuer: ISSUER, issuerDid });
    expect(grant.principalId).toBe('shopper-01');
    // The key set came from jwksUri, on the loopback server.
    expect(requestHeaders).toHaveLength(before + 1);
  });

  it('treats issuerDid: null as no DID', async () => {
    routes.set('/jwks', respond(jwksBody));
    const grant = await verifyGrantToken(await token(), { jwksUri: url('/jwks'), issuer: ISSUER, issuerDid: null });
    expect(grant.principalId).toBe('shopper-01');
  });
});

describe('bounded and unbounded key sets for one URL are cached apart', () => {
  it('gives a grant token each mode its own fetch, in either order', async () => {
    routes.set('/shared', respond(oversizedKeySet()));
    await expect(verify(url('/shared'))).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
    await expect(verify(url('/shared'), BOUNDED)).rejects.toThrow(/larger than 65536 bytes/);
    await expect(verify(url('/shared'))).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });

    routes.set('/shared-bounded-first', respond(oversizedKeySet()));
    await expect(verify(url('/shared-bounded-first'), BOUNDED)).rejects.toThrow(/larger than 65536 bytes/);
    await expect(verify(url('/shared-bounded-first'))).resolves.toMatchObject({ tokenId: 'tok_jwks_fetch' });
    await expect(verify(url('/shared-bounded-first'), BOUNDED)).rejects.toThrow(/larger than 65536 bytes/);
  });

  it('gives a decision grant each mode its own fetch, in either order', async () => {
    const decisions = loadDecisionFixture();
    const grant = await decisionGrant(decisions);
    const check = (path: string, boundedJwksFetch: boolean) => verifyDecisionGrant(grant, decisions.action, 'v7', {
      issuer: ISSUER,
      jwksUri: url(path),
      now: decisions.now,
      boundedJwksFetch,
    });

    routes.set('/decision-shared', respond(oversizedKeySet()));
    await expect(check('/decision-shared', false)).resolves.toMatchObject({ iss: ISSUER });
    await expect(check('/decision-shared', true)).rejects.toThrow(/larger than 65536 bytes/);

    routes.set('/decision-shared-bounded-first', respond(oversizedKeySet()));
    await expect(check('/decision-shared-bounded-first', true)).rejects.toThrow(/larger than 65536 bytes/);
    await expect(check('/decision-shared-bounded-first', false)).resolves.toMatchObject({ iss: ISSUER });
  });
});

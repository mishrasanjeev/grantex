import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as jose from 'jose';
import { requireMcpAuth } from '../src/middleware/express.js';
import { requireMcpAuth as requireMcpAuthHono } from '../src/middleware/hono.js';
import type { McpAuthRequest } from '../src/middleware/express.js';

let rsaPrivateKey: jose.CryptoKey;
let rsaPublicJwk: jose.JWK;
let jwksServer: Server;
let jwksPort: number;
let issuer: string;
// requireMcpAuth requires an audience in 3.0 (MCP authorization, Token Handling).
const AUDIENCE = 'https://mcp.example.com';

beforeAll(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  rsaPrivateKey = privateKey;
  rsaPublicJwk = await jose.exportJWK(publicKey);
  rsaPublicJwk.kid = 'test-key-1';
  rsaPublicJwk.alg = 'RS256';
  rsaPublicJwk.use = 'sig';

  jwksServer = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [rsaPublicJwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    jwksServer.listen(0, '127.0.0.1', () => {
      const addr = jwksServer.address();
      if (typeof addr === 'object' && addr) {
        jwksPort = addr.port;
      }
      resolve();
    });
  });

  issuer = `http://127.0.0.1:${jwksPort}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((err) => (err ? reject(err) : resolve()));
  });
});

async function signTestJwt(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string; issuer?: string },
): Promise<string> {
  // Audience-bound to the fixture MCP server unless a test sets aud itself
  // (aud: undefined produces a token without one).
  const builder = new jose.SignJWT('aud' in claims ? claims : { ...claims, aud: AUDIENCE })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(options?.issuer ?? issuer)
    .setIssuedAt()
    .setSubject(claims['sub'] as string ?? 'user_abc')
    .setJti('grnt_mw_test');

  if (options?.expiresIn) {
    builder.setExpirationTime(options.expiresIn);
  } else {
    builder.setExpirationTime('1h');
  }

  return builder.sign(rsaPrivateKey);
}

/**
 * Helper to invoke Express middleware using a minimal mock HTTP server.
 * Returns the status code, response body, and the request object (to inspect mcpGrant).
 */
async function invokeMiddleware(
  middleware: ReturnType<typeof requireMcpAuth>,
  headers: Record<string, string>,
): Promise<{
  statusCode: number;
  body: string;
  req: McpAuthRequest;
}> {
  return new Promise((resolve) => {
    const server = createServer((rawReq: IncomingMessage, res: ServerResponse) => {
      const req = rawReq as McpAuthRequest;
      // Override headers
      for (const [k, v] of Object.entries(headers)) {
        req.headers[k.toLowerCase()] = v;
      }

      middleware(req, res, () => {
        // next() was called — middleware passed
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ granted: true, mcpGrant: req.mcpGrant }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      fetch(`http://127.0.0.1:${port}/test`)
        .then(async (resp) => {
          const body = await resp.text();
          server.close();
          resolve({
            statusCode: resp.status,
            body,
            req: {} as McpAuthRequest, // we read from body.mcpGrant instead
          });
        })
        .catch(() => {
          server.close();
          resolve({ statusCode: 500, body: '', req: {} as McpAuthRequest });
        });
    });
  });
}

describe('Express middleware', () => {
  it('passes valid token and sets mcpGrant', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE });
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['read', 'write'],
      agt: 'did:grantex:ag_01',
    });

    const result = await invokeMiddleware(mw, {
      authorization: `Bearer ${token}`,
    });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.granted).toBe(true);
    expect(body.mcpGrant.sub).toBe('user_abc');
    expect(body.mcpGrant.scopes).toEqual(['read', 'write']);
    expect(body.mcpGrant.agentDid).toBe('did:grantex:ag_01');
  });

  it('rejects missing token with 401', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE });

    const result = await invokeMiddleware(mw, {});

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('unauthorized');
    expect(body.error_description).toContain('Missing');
  });

  it('rejects expired token with 401', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE });
    const token = await signTestJwt(
      { sub: 'user_abc', scp: ['read'] },
      { expiresIn: '-1h' },
    );

    const result = await invokeMiddleware(mw, {
      authorization: `Bearer ${token}`,
    });

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('unauthorized');
  });

  it('enforces required scopes (403)', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE, scopes: ['admin:write'] });
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['read'],
    });

    const result = await invokeMiddleware(mw, {
      authorization: `Bearer ${token}`,
    });

    expect(result.statusCode).toBe(403);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('insufficient_scope');
    expect(body.error_description).toContain('admin:write');
  });

  it('passes when all required scopes present', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE, scopes: ['read'] });
    const token = await signTestJwt({
      sub: 'user_abc',
      scp: ['read', 'write'],
    });

    const result = await invokeMiddleware(mw, {
      authorization: `Bearer ${token}`,
    });

    expect(result.statusCode).toBe(200);
  });

  it('rejects invalid Bearer format with 401', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE });

    const result = await invokeMiddleware(mw, {
      authorization: 'NotBearer some-token',
    });

    expect(result.statusCode).toBe(401);
  });

  describe('issuer / audience pinning', () => {
    it('rejects a token from a different iss even when the key validates', async () => {
      const mw = requireMcpAuth({ issuer: 'https://grantex.example.com', audience: AUDIENCE, jwksUri: `${issuer}/.well-known/jwks.json` });
      const wrongIss = await signTestJwt({ sub: 'user_abc', scp: ['read'] }, { issuer });
      const rightIss = await signTestJwt({ sub: 'user_abc', scp: ['read'] }, { issuer: 'https://grantex.example.com' });

      const rejected = await invokeMiddleware(mw, { authorization: `Bearer ${wrongIss}` });
      expect(rejected.statusCode).toBe(401);

      const accepted = await invokeMiddleware(mw, { authorization: `Bearer ${rightIss}` });
      expect(accepted.statusCode).toBe(200);
    });

    it('rejects a token whose aud does not match the configured audience', async () => {
      const mw = requireMcpAuth({ issuer, audience: 'https://mcp.example.com' });
      const good = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: 'https://mcp.example.com' });
      const bad = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: 'https://other.example.com' });
      const none = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: undefined });

      expect((await invokeMiddleware(mw, { authorization: `Bearer ${good}` })).statusCode).toBe(200);
      expect((await invokeMiddleware(mw, { authorization: `Bearer ${bad}` })).statusCode).toBe(401);
      expect((await invokeMiddleware(mw, { authorization: `Bearer ${none}` })).statusCode).toBe(401);
    });

    it('fails closed when issuer is empty', async () => {
      const mw = requireMcpAuth({ issuer: '', audience: AUDIENCE });
      const token = await signTestJwt({ sub: 'user_abc', scp: ['read'] });
      expect((await invokeMiddleware(mw, { authorization: `Bearer ${token}` })).statusCode).toBe(401);
    });
  });
});

describe('scp claim shape', () => {
  // @grantex/sdk rejects any non-array scp; the middlewares used to split a
  // space-separated string, so a foreign token from the same issuer gained
  // scopes it never carried as an array.
  it('Express rejects a space-separated string scp and a missing scp', async () => {
    const mw = requireMcpAuth({ issuer, audience: AUDIENCE, scopes: ['read'] });
    const stringScp = await signTestJwt({ sub: 'user_abc', scp: 'read write' });
    const noScp = await signTestJwt({ sub: 'user_abc' });
    const mixedScp = await signTestJwt({ sub: 'user_abc', scp: ['read', 42] });

    for (const token of [stringScp, noScp, mixedScp]) {
      const result = await invokeMiddleware(mw, { authorization: `Bearer ${token}` });
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe('unauthorized');
    }
  });
});

describe('Hono middleware', () => {
  function run(mw: ReturnType<typeof requireMcpAuthHono>, authorization?: string) {
    const vars = new Map<string, unknown>();
    let status = 200;
    let payload: unknown;
    const c = {
      req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) },
      set: (k: string, v: unknown) => { vars.set(k, v); },
      json: (data: unknown, s?: number) => { payload = data; status = s ?? 200; return new Response(JSON.stringify(data), { status }); },
    };
    return mw(c, async () => {}).then((res) => ({ status: res ? res.status : 200, payload, vars }));
  }

  it('rejects a different iss and a mismatched aud, accepts the pinned pair', async () => {
    const mw = requireMcpAuthHono({ issuer, audience: 'https://mcp.example.com' });
    const good = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: 'https://mcp.example.com' });
    const wrongIss = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: 'https://mcp.example.com' }, { issuer: 'https://evil.example.com' });
    const wrongAud = await signTestJwt({ sub: 'user_abc', scp: ['read'], aud: 'https://other.example.com' });

    const ok = await run(mw, `Bearer ${good}`);
    expect(ok.status).toBe(200);
    expect((ok.vars.get('mcpGrant') as { sub: string }).sub).toBe('user_abc');
    expect((await run(mw, `Bearer ${wrongIss}`)).status).toBe(401);
    expect((await run(mw, `Bearer ${wrongAud}`)).status).toBe(401);
  });

  it('rejects a space-separated string scp and a missing scp', async () => {
    const mw = requireMcpAuthHono({ issuer, audience: AUDIENCE });
    const stringScp = await signTestJwt({ sub: 'user_abc', scp: 'read write' });
    const noScp = await signTestJwt({ sub: 'user_abc' });

    expect((await run(mw, `Bearer ${stringScp}`)).status).toBe(401);
    expect((await run(mw, `Bearer ${noScp}`)).status).toBe(401);
    expect((await run(mw, `Bearer ${await signTestJwt({ sub: 'user_abc', scp: ['read'] })}`)).status).toBe(200);
  });
});

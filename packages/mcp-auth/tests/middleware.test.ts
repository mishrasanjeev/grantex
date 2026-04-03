import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as jose from 'jose';
import { requireMcpAuth } from '../src/middleware/express.js';
import type { McpAuthRequest } from '../src/middleware/express.js';

let rsaPrivateKey: jose.KeyLike;
let rsaPublicJwk: jose.JWK;
let jwksServer: Server;
let jwksPort: number;
let issuer: string;

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
  options?: { expiresIn?: string },
): Promise<string> {
  const builder = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
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
    const mw = requireMcpAuth({ issuer });
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
    const mw = requireMcpAuth({ issuer });

    const result = await invokeMiddleware(mw, {});

    expect(result.statusCode).toBe(401);
    const body = JSON.parse(result.body);
    expect(body.error).toBe('unauthorized');
    expect(body.error_description).toContain('Missing');
  });

  it('rejects expired token with 401', async () => {
    const mw = requireMcpAuth({ issuer });
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
    const mw = requireMcpAuth({ issuer, scopes: ['admin:write'] });
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
    const mw = requireMcpAuth({ issuer, scopes: ['read'] });
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
    const mw = requireMcpAuth({ issuer });

    const result = await invokeMiddleware(mw, {
      authorization: 'NotBearer some-token',
    });

    expect(result.statusCode).toBe(401);
  });
});

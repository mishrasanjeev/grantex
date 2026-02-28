import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { VerifiedGrant } from '@grantex/sdk';
import type { GrantexRequest } from '../src/types.js';
import { GrantexMiddlewareError } from '../src/errors.js';

vi.mock('@grantex/sdk', () => ({
  verifyGrantToken: vi.fn(),
  GrantexTokenError: class GrantexTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GrantexTokenError';
    }
  },
}));

import { verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import { requireGrantToken, requireScopes, createGrantex } from '../src/middleware.js';

const JWKS_URI = 'https://example.com/.well-known/jwks.json';

const MOCK_GRANT: VerifiedGrant = {
  tokenId: 'tok_01',
  grantId: 'grnt_01',
  principalId: 'user_123',
  agentDid: 'did:grantex:ag_01',
  developerId: 'dev_01',
  scopes: ['calendar:read', 'email:read'],
  issuedAt: 1709100000,
  expiresAt: 1709200000,
};

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

interface MockRes extends Response {
  _body: unknown;
}

function mockRes(): MockRes {
  const res = {
    statusCode: 200,
    _body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as unknown as MockRes;
}

// ─── requireGrantToken ──────────────────────────────────────────────────────

describe('requireGrantToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('calls next() and sets req.grant on valid token', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq({ authorization: 'Bearer valid.jwt.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as GrantexRequest).grant).toEqual(MOCK_GRANT);
    expect(verifyGrantToken).toHaveBeenCalledWith('valid.jwt.token', {
      jwksUri: JWKS_URI,
    });
  });

  it('returns 401 JSON when no Authorization header', async () => {
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: 'TOKEN_MISSING' });
  });

  it('returns 401 when Authorization header is not Bearer', async () => {
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq({ authorization: 'Basic dXNlcjpwYXNz' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: 'TOKEN_MISSING' });
  });

  it('returns 401 when token is invalid', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Grant token verification failed: invalid signature'),
    );
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq({ authorization: 'Bearer bad.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: 'TOKEN_INVALID' });
  });

  it('returns 401 with TOKEN_EXPIRED code for expired tokens', async () => {
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Grant token verification failed: "exp" claim timestamp check failed'),
    );
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq({ authorization: 'Bearer expired.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: 'TOKEN_EXPIRED' });
  });

  it('passes unexpected errors to Express error handler via next(err)', async () => {
    const unexpectedErr = new Error('Network failure');
    vi.mocked(verifyGrantToken).mockRejectedValue(unexpectedErr);
    const middleware = requireGrantToken({ jwksUri: JWKS_URI });
    const req = mockReq({ authorization: 'Bearer some.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(unexpectedErr);
  });

  it('supports custom tokenExtractor', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    const middleware = requireGrantToken({
      jwksUri: JWKS_URI,
      tokenExtractor: (req) => (req.headers as Record<string, string>)['x-grant-token'],
    });
    const req = mockReq({ 'x-grant-token': 'custom.header.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(verifyGrantToken).toHaveBeenCalledWith('custom.header.token', {
      jwksUri: JWKS_URI,
    });
  });

  it('returns 401 when custom tokenExtractor returns undefined', async () => {
    const middleware = requireGrantToken({
      jwksUri: JWKS_URI,
      tokenExtractor: () => undefined,
    });
    const req = mockReq({ authorization: 'Bearer ignored' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res._body).toMatchObject({ error: 'TOKEN_MISSING' });
  });

  it('passes clockTolerance and audience to verifyGrantToken', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    const middleware = requireGrantToken({
      jwksUri: JWKS_URI,
      clockTolerance: 10,
      audience: 'my-app',
    });
    const req = mockReq({ authorization: 'Bearer some.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(verifyGrantToken).toHaveBeenCalledWith('some.token', {
      jwksUri: JWKS_URI,
      clockTolerance: 10,
      audience: 'my-app',
    });
  });

  it('calls custom onError handler instead of default JSON response', async () => {
    const onError = vi.fn();
    vi.mocked(verifyGrantToken).mockRejectedValue(
      new GrantexTokenError('Grant token verification failed: bad'),
    );
    const middleware = requireGrantToken({ jwksUri: JWKS_URI, onError });
    const req = mockReq({ authorization: 'Bearer bad.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TOKEN_INVALID', statusCode: 401 }),
      req,
      res,
      next,
    );
    // Default handler should NOT have been called
    expect(res.statusCode).toBe(200); // untouched
  });

  it('calls custom onError for missing tokens too', async () => {
    const onError = vi.fn();
    const middleware = requireGrantToken({ jwksUri: JWKS_URI, onError });
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TOKEN_MISSING', statusCode: 401 }),
      req,
      res,
      next,
    );
  });
});

// ─── requireScopes ──────────────────────────────────────────────────────────

describe('requireScopes', () => {
  it('calls next() when grant has all required scopes', () => {
    const middleware = requireScopes('calendar:read');
    const req = mockReq() as GrantexRequest;
    req.grant = MOCK_GRANT;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() when checking multiple scopes that are all present', () => {
    const middleware = requireScopes('calendar:read', 'email:read');
    const req = mockReq() as GrantexRequest;
    req.grant = MOCK_GRANT;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 when grant is missing a required scope', () => {
    const middleware = requireScopes('calendar:write');
    const req = mockReq() as GrantexRequest;
    req.grant = MOCK_GRANT;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res._body).toMatchObject({
      error: 'SCOPE_INSUFFICIENT',
      message: expect.stringContaining('calendar:write'),
    });
  });

  it('lists all missing scopes in the error message', () => {
    const middleware = requireScopes('calendar:write', 'email:write');
    const req = mockReq() as GrantexRequest;
    req.grant = MOCK_GRANT;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.statusCode).toBe(403);
    const body = res._body as { message: string };
    expect(body.message).toContain('calendar:write');
    expect(body.message).toContain('email:write');
  });

  it('returns 500 when used without requireGrantToken (no grant on request)', () => {
    const middleware = requireScopes('calendar:read');
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res._body).toMatchObject({ error: 'TOKEN_MISSING' });
  });

  it('allows any token when called with zero scopes', () => {
    const middleware = requireScopes();
    const req = mockReq() as GrantexRequest;
    req.grant = { ...MOCK_GRANT, scopes: [] };
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ─── createGrantex ──────────────────────────────────────────────────────────

describe('createGrantex', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates middleware instances with pre-configured options', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    const grantex = createGrantex({ jwksUri: JWKS_URI, clockTolerance: 5 });
    const middleware = grantex.requireToken();
    const req = mockReq({ authorization: 'Bearer some.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(verifyGrantToken).toHaveBeenCalledWith('some.token', {
      jwksUri: JWKS_URI,
      clockTolerance: 5,
    });
    expect(next).toHaveBeenCalledWith();
  });

  it('allows per-route overrides', async () => {
    vi.mocked(verifyGrantToken).mockResolvedValue(MOCK_GRANT);
    const grantex = createGrantex({ jwksUri: JWKS_URI });
    const middleware = grantex.requireToken({ audience: 'special-app' });
    const req = mockReq({ authorization: 'Bearer some.token' });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(verifyGrantToken).toHaveBeenCalledWith('some.token', {
      jwksUri: JWKS_URI,
      audience: 'special-app',
    });
  });

  it('requireScopes() works the same as standalone', () => {
    const grantex = createGrantex({ jwksUri: JWKS_URI });
    const middleware = grantex.requireScopes('calendar:read');
    const req = mockReq() as GrantexRequest;
    req.grant = MOCK_GRANT;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ─── GrantexMiddlewareError ─────────────────────────────────────────────────

describe('GrantexMiddlewareError', () => {
  it('has correct properties', () => {
    const err = new GrantexMiddlewareError('TOKEN_INVALID', 'bad token', 401);
    expect(err.code).toBe('TOKEN_INVALID');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('bad token');
    expect(err.name).toBe('GrantexMiddlewareError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GrantexMiddlewareError);
  });
});

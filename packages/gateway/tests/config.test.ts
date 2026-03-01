import { describe, it, expect } from 'vitest';
import { validateConfig } from '../src/config.js';
import { GatewayError } from '../src/errors.js';

const VALID_CONFIG = {
  upstream: 'https://api.internal.example.com',
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  port: 8080,
  routes: [
    {
      path: '/calendar/**',
      methods: ['GET'],
      requiredScopes: ['calendar:read'],
    },
  ],
};

describe('validateConfig', () => {
  it('validates a correct config', () => {
    const config = validateConfig(VALID_CONFIG);
    expect(config.upstream).toBe('https://api.internal.example.com');
    expect(config.jwksUri).toBe('https://auth.example.com/.well-known/jwks.json');
    expect(config.port).toBe(8080);
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0]!.methods).toEqual(['GET']);
  });

  it('defaults port to 8080', () => {
    const { port: _, ...noPort } = VALID_CONFIG;
    const config = validateConfig(noPort);
    expect(config.port).toBe(8080);
  });

  it('uppercases methods', () => {
    const config = validateConfig({
      ...VALID_CONFIG,
      routes: [{
        path: '/api/**',
        methods: ['get', 'post'],
        requiredScopes: ['api:read'],
      }],
    });
    expect(config.routes[0]!.methods).toEqual(['GET', 'POST']);
  });

  it('parses upstream headers', () => {
    const config = validateConfig({
      ...VALID_CONFIG,
      upstreamHeaders: { 'X-Auth': 'secret', 'X-Version': 2 },
    });
    expect(config.upstreamHeaders).toEqual({ 'X-Auth': 'secret', 'X-Version': '2' });
  });

  it('parses grantexApiKey', () => {
    const config = validateConfig({
      ...VALID_CONFIG,
      grantexApiKey: 'gx_key_123',
    });
    expect(config.grantexApiKey).toBe('gx_key_123');
  });

  it('rejects null config', () => {
    expect(() => validateConfig(null)).toThrow(GatewayError);
  });

  it('rejects missing upstream', () => {
    const { upstream: _, ...noUpstream } = VALID_CONFIG;
    expect(() => validateConfig(noUpstream)).toThrow(GatewayError);
  });

  it('rejects empty upstream', () => {
    expect(() => validateConfig({ ...VALID_CONFIG, upstream: '' })).toThrow(GatewayError);
  });

  it('rejects missing jwksUri', () => {
    const { jwksUri: _, ...noJwks } = VALID_CONFIG;
    expect(() => validateConfig(noJwks)).toThrow(GatewayError);
  });

  it('rejects empty routes', () => {
    expect(() => validateConfig({ ...VALID_CONFIG, routes: [] })).toThrow(GatewayError);
  });

  it('rejects missing routes', () => {
    const { routes: _, ...noRoutes } = VALID_CONFIG;
    expect(() => validateConfig(noRoutes)).toThrow(GatewayError);
  });

  it('rejects route without path', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ methods: ['GET'], requiredScopes: ['read'] }],
    })).toThrow(GatewayError);
  });

  it('rejects route without methods', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ path: '/api', methods: [], requiredScopes: ['read'] }],
    })).toThrow(GatewayError);
  });

  it('rejects route without requiredScopes', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ path: '/api', methods: ['GET'], requiredScopes: [] }],
    })).toThrow(GatewayError);
  });

  it('rejects non-string methods', () => {
    expect(() => validateConfig({
      ...VALID_CONFIG,
      routes: [{ path: '/api', methods: [123], requiredScopes: ['read'] }],
    })).toThrow(GatewayError);
  });

  it('validates multiple routes', () => {
    const config = validateConfig({
      ...VALID_CONFIG,
      routes: [
        { path: '/api/read', methods: ['GET'], requiredScopes: ['api:read'] },
        { path: '/api/write', methods: ['POST', 'PUT'], requiredScopes: ['api:write'] },
      ],
    });
    expect(config.routes).toHaveLength(2);
  });
});

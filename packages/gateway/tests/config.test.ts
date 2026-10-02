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
  it('preserves fixed-resource human and agent bindings', () => {
    const config = validateConfig({ ...VALID_CONFIG, expectedPrincipalId: 'human-1', expectedAgentDid: 'did:grantex:agent-1' });
    expect(config.expectedPrincipalId).toBe('human-1');
    expect(config.expectedAgentDid).toBe('did:grantex:agent-1');
  });

  it.each(['', null, false, 1])('rejects malformed fixed identity bindings %j', (value) => {
    expect(() => validateConfig({ ...VALID_CONFIG, expectedPrincipalId: value })).toThrow('non-empty string');
    expect(() => validateConfig({ ...VALID_CONFIG, expectedAgentDid: value })).toThrow('non-empty string');
  });
  it('preserves an explicit current authority flag and issuer API URL', () => {
    const config = validateConfig({ ...VALID_CONFIG, currentAuthorityCheck: true, grantexBaseUrl: 'https://issuer.example' });
    expect(config.currentAuthorityCheck).toBe(true);
    expect(config.grantexBaseUrl).toBe('https://issuer.example');
  });

  it.each(['true', 'false', null, 1])('rejects a non-boolean current authority flag %j', (value) => {
    expect(() => validateConfig({ ...VALID_CONFIG, currentAuthorityCheck: value })).toThrow('must be a boolean');
  });

  it('does not silently discard a YAML authority callback', () => {
    expect(() => validateConfig({ ...VALID_CONFIG, currentAuthority: 'not-a-function' })).toThrow('programmatic only');
  });
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

  it('parses credentialReference with the key and auth service it needs', () => {
    const config = validateConfig({
      ...VALID_CONFIG,
      credentialReference: 'on',
      grantexApiKey: 'gx_key_123',
      grantexBaseUrl: 'https://auth.example.com',
    });
    expect(config.credentialReference).toBe('on');
    expect(validateConfig({ ...VALID_CONFIG, credentialReference: 'off' }).credentialReference).toBe('off');
    expect(validateConfig(VALID_CONFIG).credentialReference).toBeUndefined();
  });

  it('refuses credentialReference on without the gateway key or the auth service, and any other value', () => {
    expect(() => validateConfig({ ...VALID_CONFIG, credentialReference: 'on', grantexApiKey: 'gx_key_123' }))
      .toThrow('credentialReference: on needs grantexApiKey and grantexBaseUrl');
    expect(() => validateConfig({ ...VALID_CONFIG, credentialReference: 'on', grantexBaseUrl: 'https://auth.example.com' }))
      .toThrow('credentialReference: on needs grantexApiKey and grantexBaseUrl');
    expect(() => validateConfig({ ...VALID_CONFIG, credentialReference: 'yes' }))
      .toThrow("credentialReference must be 'on' or 'off'");
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

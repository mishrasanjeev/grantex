import { describe, it, expect } from 'vitest';
import { matchRoute, isSafeRequestPath } from '../src/matcher.js';
import type { RouteDefinition } from '../src/types.js';

const ROUTES: RouteDefinition[] = [
  { path: '/calendar/**', methods: ['GET'], requiredScopes: ['calendar:read'] },
  { path: '/calendar/**', methods: ['POST', 'PUT', 'PATCH'], requiredScopes: ['calendar:write'] },
  { path: '/payments/**', methods: ['POST'], requiredScopes: ['payments:initiate'] },
  { path: '/users/*', methods: ['GET'], requiredScopes: ['users:read'] },
  { path: '/health', methods: ['GET'], requiredScopes: ['health:read'] },
];

describe('matchRoute', () => {
  it('matches exact path', () => {
    const result = matchRoute('GET', '/health', ROUTES);
    expect(result).not.toBeNull();
    expect(result!.route.requiredScopes).toEqual(['health:read']);
  });

  it('matches ** glob (single segment)', () => {
    const result = matchRoute('GET', '/calendar/events', ROUTES);
    expect(result).not.toBeNull();
    expect(result!.route.requiredScopes).toEqual(['calendar:read']);
  });

  it('matches ** glob (nested segments)', () => {
    const result = matchRoute('GET', '/calendar/events/123/attendees', ROUTES);
    expect(result).not.toBeNull();
    expect(result!.route.requiredScopes).toEqual(['calendar:read']);
  });

  it('matches ** glob (just base path)', () => {
    const result = matchRoute('GET', '/calendar/', ROUTES);
    expect(result).not.toBeNull();
  });

  it('matches * glob (single segment only)', () => {
    const result = matchRoute('GET', '/users/123', ROUTES);
    expect(result).not.toBeNull();
    expect(result!.route.requiredScopes).toEqual(['users:read']);
  });

  it('does NOT match * glob across segments', () => {
    const result = matchRoute('GET', '/users/123/profile', ROUTES);
    expect(result).toBeNull();
  });

  it('matches correct method', () => {
    const getResult = matchRoute('GET', '/calendar/events', ROUTES);
    expect(getResult!.route.requiredScopes).toEqual(['calendar:read']);

    const postResult = matchRoute('POST', '/calendar/events', ROUTES);
    expect(postResult!.route.requiredScopes).toEqual(['calendar:write']);
  });

  it('is case-insensitive on method', () => {
    const result = matchRoute('get', '/health', ROUTES);
    expect(result).not.toBeNull();
  });

  it('returns null for unmatched path', () => {
    const result = matchRoute('GET', '/unknown/path', ROUTES);
    expect(result).toBeNull();
  });

  it('returns null for unmatched method', () => {
    const result = matchRoute('DELETE', '/health', ROUTES);
    expect(result).toBeNull();
  });

  it('returns first matching route', () => {
    const routes: RouteDefinition[] = [
      { path: '/api/**', methods: ['GET'], requiredScopes: ['first'] },
      { path: '/api/**', methods: ['GET'], requiredScopes: ['second'] },
    ];
    const result = matchRoute('GET', '/api/test', routes);
    expect(result!.route.requiredScopes).toEqual(['first']);
  });

  it('matches POST to payments', () => {
    const result = matchRoute('POST', '/payments/intents', ROUTES);
    expect(result).not.toBeNull();
    expect(result!.route.requiredScopes).toEqual(['payments:initiate']);
  });

  it('does not match GET to payments (only POST configured)', () => {
    const result = matchRoute('GET', '/payments/intents', ROUTES);
    expect(result).toBeNull();
  });
});

describe('isSafeRequestPath', () => {
  // The gateway authorizes the literal request path but forwards it verbatim,
  // and the upstream resolves `.`/`..` itself. A path whose two readings differ
  // lets a `/calendar/**` token reach `/payments/transfer`. Node's HTTP server
  // hands over the raw request-target, so this reaches the handler unnormalized.
  it('rejects a parent-directory segment', () => {
    expect(isSafeRequestPath('/calendar/../payments/transfer')).toBe(false);
  });

  it('rejects percent-encoded parent-directory segments', () => {
    expect(isSafeRequestPath('/calendar/%2e%2e/payments/transfer')).toBe(false);
    expect(isSafeRequestPath('/calendar/%2E%2E/payments/transfer')).toBe(false);
  });

  it('rejects a current-directory segment', () => {
    expect(isSafeRequestPath('/calendar/./events')).toBe(false);
    expect(isSafeRequestPath('/calendar/%2e/events')).toBe(false);
  });

  it('rejects a trailing traversal segment', () => {
    expect(isSafeRequestPath('/calendar/events/..')).toBe(false);
  });

  it('rejects backslashes and null bytes', () => {
    expect(isSafeRequestPath('/calendar\\..\\payments')).toBe(false);
    expect(isSafeRequestPath('/calendar/%5c..%5cpayments')).toBe(false);
    expect(isSafeRequestPath('/calendar/events%00.json')).toBe(false);
  });

  it('rejects malformed percent-encoding the upstream might decode differently', () => {
    expect(isSafeRequestPath('/calendar/%zz')).toBe(false);
  });

  it('rejects a path that is not absolute', () => {
    expect(isSafeRequestPath('calendar/events')).toBe(false);
  });

  it('accepts ordinary paths', () => {
    expect(isSafeRequestPath('/calendar/events')).toBe(true);
    expect(isSafeRequestPath('/calendar/events/123')).toBe(true);
    expect(isSafeRequestPath('/')).toBe(true);
  });

  it('accepts dots and encoded characters inside a segment', () => {
    expect(isSafeRequestPath('/calendar/events/report.v2.json')).toBe(true);
    expect(isSafeRequestPath('/files/..hidden')).toBe(true);
    expect(isSafeRequestPath('/search/a%20b')).toBe(true);
  });
});

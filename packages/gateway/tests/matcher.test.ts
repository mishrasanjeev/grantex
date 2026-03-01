import { describe, it, expect } from 'vitest';
import { matchRoute } from '../src/matcher.js';
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

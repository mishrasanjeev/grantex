import { describe, it, expect } from 'vitest';
import { parseScope, findMatchingScope, enforceConstraint } from '../src/scope-utils.js';

describe('parseScope', () => {
  it('parses simple scope without constraint', () => {
    expect(parseScope('calendar:read')).toEqual({
      baseScope: 'calendar:read',
    });
  });

  it('parses scope with max constraint', () => {
    expect(parseScope('payments:initiate:max_500')).toEqual({
      baseScope: 'payments:initiate',
      constraint: { type: 'max', value: 500 },
    });
  });

  it('parses scope with min constraint', () => {
    expect(parseScope('payments:initiate:min_10')).toEqual({
      baseScope: 'payments:initiate',
      constraint: { type: 'min', value: 10 },
    });
  });

  it('parses scope with limit constraint', () => {
    expect(parseScope('api:calls:limit_1000')).toEqual({
      baseScope: 'api:calls',
      constraint: { type: 'limit', value: 1000 },
    });
  });

  it('returns baseScope as-is for single-part scope', () => {
    expect(parseScope('admin')).toEqual({ baseScope: 'admin' });
  });

  it('handles scope with colon but no constraint', () => {
    expect(parseScope('email:send')).toEqual({
      baseScope: 'email:send',
    });
  });

  it('handles multi-part scope without constraint', () => {
    expect(parseScope('org:team:manage')).toEqual({
      baseScope: 'org:team:manage',
    });
  });

  it('parses zero constraint value', () => {
    expect(parseScope('payments:initiate:max_0')).toEqual({
      baseScope: 'payments:initiate',
      constraint: { type: 'max', value: 0 },
    });
  });
});

describe('findMatchingScope', () => {
  it('finds exact match without constraint', () => {
    const result = findMatchingScope(['calendar:read', 'email:send'], 'calendar:read');
    expect(result).toEqual({ baseScope: 'calendar:read' });
  });

  it('finds match with constraint', () => {
    const result = findMatchingScope(['payments:initiate:max_500'], 'payments:initiate');
    expect(result).toEqual({
      baseScope: 'payments:initiate',
      constraint: { type: 'max', value: 500 },
    });
  });

  it('returns null when no match', () => {
    const result = findMatchingScope(['calendar:read'], 'email:send');
    expect(result).toBeNull();
  });

  it('returns null for empty scopes', () => {
    const result = findMatchingScope([], 'calendar:read');
    expect(result).toBeNull();
  });

  it('returns first matching scope', () => {
    const result = findMatchingScope(
      ['payments:initiate:max_100', 'payments:initiate:max_500'],
      'payments:initiate',
    );
    expect(result).toEqual({
      baseScope: 'payments:initiate',
      constraint: { type: 'max', value: 100 },
    });
  });
});

describe('enforceConstraint', () => {
  it('allows when no constraint', () => {
    const result = enforceConstraint({ baseScope: 'payments:initiate' }, 1000);
    expect(result).toEqual({ allowed: true });
  });

  it('allows value under max', () => {
    const parsed = { baseScope: 'payments:initiate', constraint: { type: 'max', value: 500 } };
    expect(enforceConstraint(parsed, 200)).toEqual({ allowed: true });
  });

  it('allows value equal to max', () => {
    const parsed = { baseScope: 'payments:initiate', constraint: { type: 'max', value: 500 } };
    expect(enforceConstraint(parsed, 500)).toEqual({ allowed: true });
  });

  it('rejects value over max', () => {
    const parsed = { baseScope: 'payments:initiate', constraint: { type: 'max', value: 500 } };
    const result = enforceConstraint(parsed, 600);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('600');
    expect(result.reason).toContain('500');
  });

  it('allows value above min', () => {
    const parsed = { baseScope: 'payments:initiate', constraint: { type: 'min', value: 10 } };
    expect(enforceConstraint(parsed, 50)).toEqual({ allowed: true });
  });

  it('rejects value below min', () => {
    const parsed = { baseScope: 'payments:initiate', constraint: { type: 'min', value: 10 } };
    const result = enforceConstraint(parsed, 5);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('5');
  });

  it('allows value under limit', () => {
    const parsed = { baseScope: 'api:calls', constraint: { type: 'limit', value: 100 } };
    expect(enforceConstraint(parsed, 50)).toEqual({ allowed: true });
  });

  it('rejects value over limit', () => {
    const parsed = { baseScope: 'api:calls', constraint: { type: 'limit', value: 100 } };
    const result = enforceConstraint(parsed, 150);
    expect(result.allowed).toBe(false);
  });

  it('allows for unknown constraint type', () => {
    const parsed = { baseScope: 'test', constraint: { type: 'unknown', value: 100 } };
    expect(enforceConstraint(parsed, 9999)).toEqual({ allowed: true });
  });
});

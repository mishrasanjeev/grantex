import { describe, it, expect } from 'vitest';
import { parseScope, scopeMatches, hasScope, missingScopes } from '../src/scopes.js';

describe('canonical scope matching (SPEC §4.1)', () => {
  it('parses resource:action[:constraint]', () => {
    expect(parseScope('calendar:read')).toEqual({ resource: 'calendar', action: 'read' });
    expect(parseScope('payments:initiate:max_500')).toEqual({ resource: 'payments', action: 'initiate', constraint: 'max_500' });
    expect(parseScope('calendar')).toBeUndefined();
    expect(parseScope('a:b:c:d')).toBeUndefined();
    expect(parseScope('a::c')).toBeUndefined();
  });

  it('matches only on exact equality', () => {
    expect(scopeMatches('calendar:read', 'calendar:read')).toBe(true);
    expect(scopeMatches('calendar:read', 'calendar:write')).toBe(false);
    // A constraint is part of the permission: neither direction is implied.
    expect(scopeMatches('payments:initiate', 'payments:initiate:max_500')).toBe(false);
    expect(scopeMatches('payments:initiate:max_500', 'payments:initiate')).toBe(false);
    expect(scopeMatches('payments:initiate:max_500', 'payments:initiate:max_5000')).toBe(false);
    // No wildcard or prefix semantics in the core SDK.
    expect(scopeMatches('*', 'calendar:read')).toBe(false);
    expect(scopeMatches('calendar:*', 'calendar:read')).toBe(false);
    expect(scopeMatches('calendar:rea', 'calendar:read')).toBe(false);
  });

  it('computes missing scopes against a granted set', () => {
    expect(hasScope(['a:b', 'c:d'], 'c:d')).toBe(true);
    expect(missingScopes(['a:b', 'weather:*'], ['a:b', 'weather:read'])).toEqual(['weather:read']);
    expect(missingScopes(['a:b'], [])).toEqual([]);
  });
});

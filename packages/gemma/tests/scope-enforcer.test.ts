import { describe, it, expect } from 'vitest';
import { enforceScopes, hasScope } from '../src/verifier/scope-enforcer.js';
import { ScopeViolationError } from '../src/errors.js';

describe('scope-enforcer', () => {
  describe('hasScope', () => {
    it('returns true when scope is present', () => {
      expect(hasScope(['calendar:read', 'email:send'], 'calendar:read')).toBe(
        true,
      );
    });

    it('returns false when scope is absent', () => {
      expect(hasScope(['calendar:read'], 'admin:write')).toBe(false);
    });

    it('returns false for empty grant scopes', () => {
      expect(hasScope([], 'any:scope')).toBe(false);
    });
  });

  describe('enforceScopes', () => {
    it('passes when all required scopes are present', () => {
      expect(() =>
        enforceScopes(
          ['calendar:read', 'email:send', 'files:write'],
          ['calendar:read', 'email:send'],
        ),
      ).not.toThrow();
    });

    it('throws ScopeViolationError when scope is missing', () => {
      expect(() =>
        enforceScopes(['calendar:read'], ['calendar:read', 'admin:write']),
      ).toThrow(ScopeViolationError);
    });

    it('includes required and grant scopes in error', () => {
      try {
        enforceScopes(['a'], ['a', 'b']);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as ScopeViolationError;
        expect(err.requiredScopes).toEqual(['a', 'b']);
        expect(err.grantScopes).toEqual(['a']);
        expect(err.code).toBe('SCOPE_VIOLATION');
      }
    });

    it('passes with empty required scopes', () => {
      expect(() => enforceScopes(['calendar:read'], [])).not.toThrow();
    });
  });
});

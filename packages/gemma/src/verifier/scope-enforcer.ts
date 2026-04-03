import { ScopeViolationError } from '../errors.js';

/**
 * Checks whether `grantScopes` contains a specific scope string.
 */
export function hasScope(grantScopes: string[], scope: string): boolean {
  return grantScopes.includes(scope);
}

/**
 * Throws {@link ScopeViolationError} if any of `requiredScopes` is missing
 * from `grantScopes`.
 */
export function enforceScopes(
  grantScopes: string[],
  requiredScopes: string[],
): void {
  const missing = requiredScopes.filter((s) => !grantScopes.includes(s));
  if (missing.length > 0) {
    throw new ScopeViolationError(requiredScopes, grantScopes);
  }
}

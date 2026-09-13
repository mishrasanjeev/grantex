/**
 * Canonical Grantex scope-matching semantics (SPEC §4.1).
 *
 * A scope is `resource:action[:constraint]`. Matching is exact: a granted
 * scope satisfies a required scope only when the two strings are identical.
 * In particular a constrained scope (`payments:initiate:max_500`) is never
 * satisfied by its unconstrained form, and vice versa — the constraint is
 * part of the permission, not a suffix to be prefix-matched away.
 *
 * Adapters that add their own wildcard sugar MUST reduce to these rules for
 * every non-wildcard scope (see `@grantex/x402`'s `scopeMatches`).
 */

export interface ParsedScope {
  resource: string;
  action: string;
  constraint?: string;
}

/** Splits `resource:action[:constraint]`; returns undefined for malformed scopes. */
export function parseScope(scope: string): ParsedScope | undefined {
  if (typeof scope !== 'string') return undefined;
  const parts = scope.split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  if (parts.some((part) => part.length === 0)) return undefined;
  const [resource, action, constraint] = parts as [string, string, string?];
  return constraint !== undefined ? { resource, action, constraint } : { resource, action };
}

/** True when `granted` satisfies `required` — exact string equality. */
export function scopeMatches(granted: string, required: string): boolean {
  return typeof granted === 'string' && typeof required === 'string' && granted === required;
}

/** True when a required scope is satisfied by at least one granted scope. */
export function hasScope(grantedScopes: readonly string[], required: string): boolean {
  return grantedScopes.some((granted) => scopeMatches(granted, required));
}

/** Required scopes not covered by the granted set (empty when all are satisfied). */
export function missingScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): string[] {
  return requiredScopes.filter((required) => !hasScope(grantedScopes, required));
}

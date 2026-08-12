import type { RouteDefinition, MatchResult } from './types.js';

/**
 * Convert a route path pattern to a regex.
 * Supports:
 *   - `*` matches a single path segment (no slashes)
 *   - `**` matches zero or more segments (including slashes)
 */
function patternToRegex(pattern: string): RegExp {
  // Escape special regex chars except * and /
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      // Skip trailing slash after **
      if (pattern[i] === '/') i++;
    } else if (pattern[i] === '*') {
      regex += '[^/]+';
      i++;
    } else if ('.+?^${}()|[]\\'.includes(pattern[i]!)) {
      regex += '\\' + pattern[i];
      i++;
    } else {
      regex += pattern[i];
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

// Patterns come from config and never change at runtime, but matchRoute runs on
// every request against every route — recompiling each time made routing cost
// scale with route count on the hot path.
const regexCache = new Map<string, RegExp>();

function cachedPatternRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (regex === undefined) {
    regex = patternToRegex(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Reject request paths whose authorized form and forwarded form can differ.
 *
 * Authorization matches the pattern against the literal path, but the upstream
 * receives that path verbatim and resolves `.`/`..` itself. So `/public/../admin`
 * clears a `/public/**` rule carrying only public scopes and then reaches
 * `/admin`. Percent-encoded traversal (`%2e%2e`) does the same once the upstream
 * decodes. Neither form has a legitimate use in an API path, so both are refused.
 */
export function isSafeRequestPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.includes('\0') || path.includes('\\')) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed percent-encoding — the upstream may decode it differently.
    return false;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return false;

  for (const candidate of [path, decoded]) {
    for (const segment of candidate.split('/')) {
      if (segment === '.' || segment === '..') return false;
    }
  }
  return true;
}

export function matchRoute(
  method: string,
  path: string,
  routes: RouteDefinition[],
): MatchResult | null {
  const upperMethod = method.toUpperCase();

  for (const route of routes) {
    // Check method first (cheap)
    if (!route.methods.includes(upperMethod)) continue;

    // Check path pattern
    const regex = cachedPatternRegex(route.path);
    if (regex.test(path)) {
      return { route, params: {} };
    }
  }

  return null;
}

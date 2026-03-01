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
    const regex = patternToRegex(route.path);
    if (regex.test(path)) {
      return { route, params: {} };
    }
  }

  return null;
}

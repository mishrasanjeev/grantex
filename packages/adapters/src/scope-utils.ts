export interface ParsedScope {
  baseScope: string;
  constraint?: { type: string; value: number };
}

export function parseScope(scope: string): ParsedScope {
  const parts = scope.split(':');
  if (parts.length < 2) {
    return { baseScope: scope };
  }

  const lastPart = parts[parts.length - 1]!;
  const constraintMatch = lastPart.match(/^(max|min|limit)_(\d+)$/);

  if (constraintMatch) {
    const baseScope = parts.slice(0, -1).join(':');
    return {
      baseScope,
      constraint: {
        type: constraintMatch[1]!,
        value: parseInt(constraintMatch[2]!, 10),
      },
    };
  }

  return { baseScope: scope };
}

export function findMatchingScope(
  grantedScopes: string[],
  requiredScope: string,
): ParsedScope | null {
  // Exact match first (core SDK semantics); a constrained grant of the same
  // base scope is returned only when no exact grant exists, and callers must
  // then enforce the constraint (see BaseAdapter.verifyAndCheckScope).
  if (grantedScopes.includes(requiredScope)) {
    return parseScope(requiredScope);
  }
  // Several constrained grants of the same base scope may coexist (for
  // example after a policy tightened a cap without revoking the old grant).
  // The tightest one wins: returning the first match would let a looser cap
  // override a stricter one purely by ordering. Grants whose constraint
  // types disagree cannot be reconciled into one bound, so they are rejected
  // outright rather than guessed at.
  let tightest: ParsedScope | null = null;
  for (const scope of grantedScopes) {
    const parsed = parseScope(scope);
    if (parsed.baseScope !== requiredScope || !parsed.constraint) continue;
    if (tightest === null || !tightest.constraint) {
      tightest = parsed;
      continue;
    }
    if (tightest.constraint.type !== parsed.constraint.type) {
      return null;
    }
    if (isTighter(parsed.constraint, tightest.constraint)) {
      tightest = parsed;
    }
  }
  return tightest;
}

/** `min` is a floor (higher is tighter); `max` and `limit` are ceilings (lower is tighter). */
function isTighter(
  candidate: { type: string; value: number },
  current: { type: string; value: number },
): boolean {
  return candidate.type === 'min'
    ? candidate.value > current.value
    : candidate.value < current.value;
}

export function enforceConstraint(
  parsed: ParsedScope,
  actualValue: number,
): { allowed: boolean; reason?: string } {
  if (!parsed.constraint) {
    return { allowed: true };
  }

  const { type, value } = parsed.constraint;

  switch (type) {
    case 'max':
      if (actualValue > value) {
        return {
          allowed: false,
          reason: `Value ${actualValue} exceeds maximum ${value}`,
        };
      }
      return { allowed: true };
    case 'min':
      if (actualValue < value) {
        return {
          allowed: false,
          reason: `Value ${actualValue} is below minimum ${value}`,
        };
      }
      return { allowed: true };
    case 'limit':
      if (actualValue > value) {
        return {
          allowed: false,
          reason: `Value ${actualValue} exceeds limit ${value}`,
        };
      }
      return { allowed: true };
    default:
      return { allowed: true };
  }
}

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
  for (const scope of grantedScopes) {
    const parsed = parseScope(scope);
    if (parsed.baseScope === requiredScope) {
      return parsed;
    }
  }
  return null;
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

import type { OfflineVerifier } from '../verifier/offline-verifier.js';
import type { OfflineAuditLog } from '../audit/offline-audit-log.js';
import { enforceScopes } from '../verifier/scope-enforcer.js';
import { GrantexAuthError } from '../errors.js';

export interface GoogleADKAuthOptions {
  /** Offline verifier instance. */
  verifier: OfflineVerifier;
  /** Offline audit log for recording actions. */
  auditLog: OfflineAuditLog;
  /** Scopes required to invoke this tool. */
  requiredScopes: string[];
  /** Grantex grant token (JWT). */
  grantToken: string;
}

/**
 * Wrap a Google ADK `FunctionTool` (or any object with a callable
 * `func` / `run` method) with Grantex offline authorization.
 *
 * Before the tool executes:
 * 1. The grant token is verified offline (signature + expiry).
 * 2. Required scopes are enforced.
 *
 * After execution:
 * 3. An audit entry is appended with the result.
 *
 * On failure the tool throws a {@link GrantexAuthError}.
 *
 * @example
 * ```ts
 * import { withGrantexAuth } from '@grantex/gemma';
 *
 * const protectedTool = withGrantexAuth(myAdkTool, {
 *   verifier,
 *   auditLog,
 *   requiredScopes: ['calendar:read'],
 *   grantToken: bundle.grantToken,
 * });
 * ```
 */
export function withGrantexAuth<T extends Record<string, unknown>>(
  tool: T,
  options: GoogleADKAuthOptions,
): T {
  const { verifier, auditLog, requiredScopes, grantToken } = options;

  // Google ADK tools typically have a `func` property or callable via `run`.
  // We wrap whichever is present.
  const originalFn =
    typeof tool['func'] === 'function'
      ? (tool['func'] as (...args: unknown[]) => unknown)
      : typeof tool['run'] === 'function'
        ? (tool['run'] as (...args: unknown[]) => unknown)
        : null;

  if (!originalFn) {
    throw new GrantexAuthError(
      'Tool must have a "func" or "run" method',
      'INVALID_TOOL',
    );
  }

  const fnKey = typeof tool['func'] === 'function' ? 'func' : 'run';

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    // 1. Verify grant offline
    let grant;
    try {
      grant = await verifier.verify(grantToken);
    } catch (err) {
      await auditLog.append({
        action: `tool:${String(tool['name'] ?? 'unknown')}`,
        agentDID: '',
        grantId: '',
        scopes: requiredScopes,
        result: 'auth_failure',
        metadata: { error: (err as Error).message },
      });
      throw new GrantexAuthError(
        `Authorization failed: ${(err as Error).message}`,
        'AUTH_FAILED',
      );
    }

    // 2. Enforce scopes
    try {
      enforceScopes(grant.scopes, requiredScopes);
    } catch (err) {
      await auditLog.append({
        action: `tool:${String(tool['name'] ?? 'unknown')}`,
        agentDID: grant.agentDID,
        grantId: grant.grantId,
        scopes: grant.scopes,
        result: 'scope_violation',
        metadata: { requiredScopes },
      });
      throw err;
    }

    // 3. Execute tool
    let result: unknown;
    try {
      result = await originalFn.apply(tool, args);
    } catch (err) {
      await auditLog.append({
        action: `tool:${String(tool['name'] ?? 'unknown')}`,
        agentDID: grant.agentDID,
        grantId: grant.grantId,
        scopes: grant.scopes,
        result: 'execution_error',
        metadata: { error: (err as Error).message },
      });
      throw err;
    }

    // 4. Audit success
    await auditLog.append({
      action: `tool:${String(tool['name'] ?? 'unknown')}`,
      agentDID: grant.agentDID,
      grantId: grant.grantId,
      scopes: grant.scopes,
      result: 'success',
    });

    return result;
  };

  // Return a shallow copy with the wrapped function.
  return { ...tool, [fnKey]: wrapped };
}

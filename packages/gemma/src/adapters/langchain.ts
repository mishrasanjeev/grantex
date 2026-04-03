import type { OfflineVerifier } from '../verifier/offline-verifier.js';
import type { OfflineAuditLog } from '../audit/offline-audit-log.js';
import { enforceScopes } from '../verifier/scope-enforcer.js';
import { GrantexAuthError } from '../errors.js';

export interface LangChainAuthOptions {
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
 * Wrap a LangChain `StructuredTool` (or any object with `_call` / `invoke`)
 * with Grantex offline authorization.
 *
 * The wrapper:
 * 1. Verifies the grant token offline (signature + expiry).
 * 2. Enforces required scopes.
 * 3. Logs the action to the offline audit log.
 *
 * @example
 * ```ts
 * import { withGrantexAuth } from '@grantex/gemma/adapters/langchain';
 *
 * const protectedTool = withGrantexAuth(myLangChainTool, {
 *   verifier,
 *   auditLog,
 *   requiredScopes: ['email:read'],
 *   grantToken: bundle.grantToken,
 * });
 * ```
 */
export function withGrantexAuth<T extends Record<string, unknown>>(
  tool: T,
  options: LangChainAuthOptions,
): T {
  const { verifier, auditLog, requiredScopes, grantToken } = options;

  // LangChain StructuredTool uses `_call` internally, or `invoke`.
  const originalFn =
    typeof tool['_call'] === 'function'
      ? (tool['_call'] as (...args: unknown[]) => unknown)
      : typeof tool['invoke'] === 'function'
        ? (tool['invoke'] as (...args: unknown[]) => unknown)
        : null;

  if (!originalFn) {
    throw new GrantexAuthError(
      'Tool must have a "_call" or "invoke" method',
      'INVALID_TOOL',
    );
  }

  const fnKey = typeof tool['_call'] === 'function' ? '_call' : 'invoke';

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

  return { ...tool, [fnKey]: wrapped };
}

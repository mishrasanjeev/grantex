import type { Grantex } from '@grantex/sdk';
import type { GrantexFunction } from './types.js';

export interface AuditLoggingOptions {
  /** Agent ID to record in audit entries. */
  agentId: string;
  /** Agent DID (e.g. `'did:key:z6Mk...'`). */
  agentDid: string;
  /** Grant ID associated with the function invocation. */
  grantId: string;
  /** Principal ID that granted authorization. */
  principalId: string;
}

/**
 * Wrap a {@link GrantexFunction} with Grantex audit logging.
 *
 * Logs a `'success'` entry on completion and a `'failure'` entry when
 * `execute()` throws. The original error is re-thrown after logging.
 *
 * @example
 * ```ts
 * const auditedFn = withAuditLogging(calendarFn, grantexClient, {
 *   agentId: 'did:key:z6Mk...',
 *   grantId: tokenResponse.grantId,
 * });
 * ```
 */
export function withAuditLogging<T extends Record<string, unknown>>(
  fn: GrantexFunction<T>,
  client: Grantex,
  options: AuditLoggingOptions,
): GrantexFunction<T> {
  const { agentId, agentDid, grantId, principalId } = options;
  const fnName = fn.definition.function.name;

  return {
    definition: fn.definition,
    async execute(args: T): Promise<unknown> {
      try {
        const result = await fn.execute(args);
        await client.audit.log({
          agentId,
          agentDid,
          grantId,
          principalId,
          action: `function:${fnName}`,
          metadata: { args },
          status: 'success' as const,
        });
        return result;
      } catch (err) {
        await client.audit.log({
          agentId,
          agentDid,
          grantId,
          principalId,
          action: `function:${fnName}`,
          metadata: {
            args,
            error: err instanceof Error ? err.message : String(err),
          },
          status: 'failure' as const,
        });
        throw err;
      }
    },
  };
}

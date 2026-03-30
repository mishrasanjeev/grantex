import type { Grantex } from '@grantex/sdk';
import type { GrantexTool } from './types.js';

export interface AuditLoggingOptions {
  /** Agent identifier to record in audit entries. */
  agentId: string;
  /** Agent DID (decentralized identifier) to record in audit entries. */
  agentDid: string;
  /** Grant ID associated with the tool invocation. */
  grantId: string;
  /** Principal (end-user) identifier who granted the authorization. */
  principalId: string;
}

/**
 * Wrap a {@link GrantexTool} with Grantex audit logging.
 *
 * Logs a `'success'` entry on completion and a `'failure'` entry when
 * `execute()` throws. The original error is re-thrown after logging.
 *
 * @example
 * ```ts
 * import { Grantex } from '@grantex/sdk';
 * import { createGrantexTool, withAuditLogging } from '@grantex/anthropic';
 *
 * const grantex = new Grantex({ apiKey: process.env.GRANTEX_API_KEY });
 *
 * const tool = createGrantexTool({ ... });
 *
 * const auditedTool = withAuditLogging(tool, grantex, {
 *   agentId: 'ag_01HXYZ...',
 *   agentDid: 'did:grantex:ag_01HXYZ...',
 *   grantId: tokenResponse.grantId,
 *   principalId: 'user_abc123',
 * });
 *
 * // Now every call to auditedTool.execute() is logged automatically.
 * ```
 */
export function withAuditLogging<T>(
  tool: GrantexTool<T>,
  client: Grantex,
  options: AuditLoggingOptions,
): GrantexTool<T> {
  const { agentId, agentDid, grantId, principalId } = options;
  const toolName = tool.definition.name;

  return {
    definition: tool.definition,
    async execute(args: T): Promise<unknown> {
      try {
        const result = await tool.execute(args);
        await client.audit.log({
          agentId,
          agentDid,
          grantId,
          principalId,
          action: `tool:${toolName}`,
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
          action: `tool:${toolName}`,
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

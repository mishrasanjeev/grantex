import type { Grantex } from '@grantex/sdk';
import type { z } from 'zod';
import { TOOL_NAME_KEY, type GrantexTool } from './tool.js';
import type { AuditLoggingOptions } from './types.js';

/**
 * Wrap a Grantex tool's `execute` function with audit logging.
 *
 * Logs a `'success'` entry after each successful execution and a
 * `'failure'` entry (then re-throws) on error.
 *
 * @example
 * ```ts
 * const auditedTool = withAuditLogging(fetchTool, grantexClient, {
 *   agentId: 'ag_01HXYZ',
 *   grantId: tokenResponse.grantId,
 * });
 *
 * // auditedTool is a drop-in replacement for fetchTool
 * const result = await generateText({
 *   model: myModel,
 *   tools: { fetch_data: auditedTool },
 *   prompt: '...',
 * });
 * ```
 */
export function withAuditLogging<PARAMETERS extends z.ZodTypeAny, RESULT>(
  grantexTool: GrantexTool<PARAMETERS, RESULT>,
  client: Grantex,
  options: AuditLoggingOptions,
): GrantexTool<PARAMETERS, RESULT> {
  const { agentId, grantId } = options;
  const toolName = options.toolName ?? grantexTool[TOOL_NAME_KEY];
  const action = `tool:${toolName}`;
  const originalExecute = grantexTool.execute;

  const wrappedExecute: typeof originalExecute = async (args, execOptions) => {
    try {
      const result = await originalExecute(args, execOptions);
      await client.audit.log({
        agentId,
        grantId,
        action,
        metadata: { args: args as Record<string, unknown> },
        status: 'success' as const,
      });
      return result;
    } catch (err) {
      await client.audit.log({
        agentId,
        grantId,
        action,
        metadata: {
          args: args as Record<string, unknown>,
          error: err instanceof Error ? err.message : String(err),
        },
        status: 'failure' as const,
      });
      throw err;
    }
  };

  return Object.defineProperty(
    { ...grantexTool, execute: wrappedExecute },
    TOOL_NAME_KEY,
    {
      value: toolName,
      writable: false,
      enumerable: false,
      configurable: false,
    },
  ) as GrantexTool<PARAMETERS, RESULT>;
}

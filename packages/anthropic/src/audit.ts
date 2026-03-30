import type { Grantex } from '@grantex/sdk';
import type { GrantexTool, AnthropicToolUseBlock, AuditLoggingOptions } from './types.js';

/**
 * Wrap a {@link GrantexTool} with Grantex audit logging.
 *
 * Logs a `'success'` entry on completion and a `'failure'` entry when
 * `execute()` throws. The original error is re-thrown after logging.
 *
 * @example
 * ```ts
 * import { createGrantexTool, withAuditLogging } from '@grantex/anthropic';
 *
 * const auditedTool = withAuditLogging(readFileTool, grantexClient, {
 *   agentId: 'ag_01',
 *   agentDid: 'did:key:z6Mk...',
 *   grantId: tokenResponse.grantId,
 *   principalId: 'user_01',
 * });
 * ```
 */
export function withAuditLogging<T extends Record<string, unknown>>(
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

/**
 * Handle an Anthropic `tool_use` block with automatic audit logging.
 *
 * Convenience function that executes the tool and logs the result in one step.
 * Useful when iterating over response content blocks.
 *
 * @example
 * ```ts
 * for (const block of response.content) {
 *   if (block.type === 'tool_use') {
 *     const result = await handleToolCall(readFileTool, block, grantexClient, {
 *       agentId: 'ag_01',
 *       agentDid: 'did:key:z6Mk...',
 *       grantId: tokenResponse.grantId,
 *       principalId: 'user_01',
 *     });
 *   }
 * }
 * ```
 */
export async function handleToolCall<T extends Record<string, unknown>>(
  tool: GrantexTool<T>,
  block: AnthropicToolUseBlock,
  client: Grantex,
  options: AuditLoggingOptions,
): Promise<unknown> {
  const { agentId, agentDid, grantId, principalId } = options;

  try {
    const result = await tool.execute(block.input as T);
    await client.audit.log({
      agentId,
      agentDid,
      grantId,
      principalId,
      action: `tool:${block.name}`,
      metadata: { args: block.input },
      status: 'success' as const,
    });
    return result;
  } catch (err) {
    await client.audit.log({
      agentId,
      agentDid,
      grantId,
      principalId,
      action: `tool:${block.name}`,
      metadata: {
        args: block.input,
        error: err instanceof Error ? err.message : String(err),
      },
      status: 'failure' as const,
    });
    throw err;
  }
}

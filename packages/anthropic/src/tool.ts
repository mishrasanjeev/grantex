import { decodeJwtPayload } from './_jwt.js';
import type { AnthropicToolDefinition, CreateGrantexToolOptions, GrantexTool } from './types.js';
import { GrantexScopeError } from './types.js';

/**
 * Create a Grantex-authorized tool in Anthropic SDK format.
 *
 * The scope check is performed offline by reading the `scp` claim from the
 * grant token JWT — no network call is made. If the agent does not hold
 * `requiredScope`, `execute()` throws a {@link GrantexScopeError} before
 * calling the implementation.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createGrantexTool } from '@grantex/anthropic';
 *
 * const readFileTool = createGrantexTool({
 *   name: 'read_file',
 *   description: 'Read a file from disk',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { path: { type: 'string' } },
 *     required: ['path'],
 *   },
 *   grantToken: process.env.GRANT_TOKEN!,
 *   requiredScope: 'file:read',
 *   execute: async ({ path }) => fs.readFile(path, 'utf-8'),
 * });
 *
 * // Pass to Anthropic SDK:
 * const response = await client.messages.create({
 *   model: 'claude-sonnet-4-20250514',
 *   max_tokens: 1024,
 *   tools: [readFileTool.definition],
 *   messages: [...],
 * });
 *
 * // Handle tool_use blocks:
 * for (const block of response.content) {
 *   if (block.type === 'tool_use' && block.name === 'read_file') {
 *     const result = await readFileTool.execute(block.input);
 *   }
 * }
 * ```
 */
export function createGrantexTool<T = Record<string, unknown>>(
  options: CreateGrantexToolOptions<T>,
): GrantexTool<T> {
  const { name, description, inputSchema, grantToken, requiredScope, execute: executeFn } = options;

  const definition: AnthropicToolDefinition = {
    name,
    description,
    input_schema: inputSchema,
  };

  return {
    definition,
    async execute(args: T): Promise<unknown> {
      const payload = decodeJwtPayload(grantToken);
      const scopes = payload['scp'];
      const scopeList = Array.isArray(scopes) ? (scopes as string[]) : [];

      if (!scopeList.includes(requiredScope)) {
        throw new GrantexScopeError(requiredScope, scopeList);
      }

      return executeFn(args);
    },
  };
}

/**
 * Decode the grant token offline and return the list of scopes.
 *
 * @example
 * ```ts
 * const scopes = getGrantScopes(grantToken);
 * // ['file:read', 'file:write', 'calendar:read']
 * ```
 */
export function getGrantScopes(grantToken: string): string[] {
  const payload = decodeJwtPayload(grantToken);
  const scopes = payload['scp'];
  return Array.isArray(scopes) ? (scopes as string[]) : [];
}

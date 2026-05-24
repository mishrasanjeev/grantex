import { verifyGrantToken, type VerifyGrantTokenOptions } from '@grantex/sdk';
import { decodeJwtPayload } from './_jwt.js';
import {
  GrantexScopeError,
  type CreateGrantexToolOptions,
  type GrantexTool,
  type AnthropicToolDefinition,
} from './types.js';

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';

/**
 * Create a Grantex-authorized tool in Anthropic SDK format.
 *
 * The grant token is verified against Grantex JWKS before its `scp` claim is
 * trusted. If the agent does not hold `requiredScope`, `execute()` throws
 * {@link GrantexScopeError} before calling the implementation.
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
 *   execute: async ({ path }) => fs.readFile(path as string, 'utf-8'),
 * });
 *
 * const response = await client.messages.create({
 *   model: 'claude-opus-4-6',
 *   max_tokens: 1024,
 *   tools: [readFileTool.definition],
 *   messages: [{ role: 'user', content: 'Read config.json' }],
 * });
 * ```
 *
 * @throws {Error} if the grant token is not a valid JWT.
 */
export function createGrantexTool<T extends Record<string, unknown>>(
  options: CreateGrantexToolOptions<T>,
): GrantexTool<T> {
  const { name, description, inputSchema, grantToken, requiredScope, execute } = options;

  const definition: AnthropicToolDefinition = {
    name,
    description,
    input_schema: inputSchema,
  };

  return {
    definition,
    async execute(args: T): Promise<unknown> {
      const grant = await verifyGrantToken(grantToken, buildVerifyOptions(options));
      const scopes = grant.scopes;

      if (!scopes.includes(requiredScope)) {
        throw new GrantexScopeError(requiredScope, scopes);
      }

      return execute(args);
    },
  };
}

/**
 * Return the scopes embedded in a Grantex grant token.
 *
 * Purely offline for diagnostics only: no network call, no signature check.
 */
export function getGrantScopes(grantToken: string): string[] {
  const payload = decodeJwtPayload(grantToken);
  return Array.isArray(payload['scp']) ? (payload['scp'] as string[]) : [];
}

function buildVerifyOptions<T extends Record<string, unknown>>(
  options: CreateGrantexToolOptions<T>,
): VerifyGrantTokenOptions {
  return {
    jwksUri: options.jwksUri ?? DEFAULT_JWKS_URI,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  };
}

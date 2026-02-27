import type { Tool } from 'ai';
import type { z } from 'zod';
import type { ToolCallOptions } from '@ai-sdk/provider-utils';
import { zodSchema } from 'ai';
import { decodeJwtPayload } from './_jwt.js';
import { GrantexScopeError, type CreateGrantexToolOptions } from './types.js';

/** Symbol key used to carry the tool name through to `withAuditLogging`. */
export const TOOL_NAME_KEY = Symbol('grantex.toolName');

/**
 * A Vercel AI `Tool` augmented with the Grantex tool name for audit logging.
 */
export type GrantexTool<PARAMETERS extends z.ZodTypeAny, RESULT> = Tool<
  PARAMETERS,
  RESULT
> & {
  execute: (
    args: z.infer<PARAMETERS>,
    options: ToolCallOptions,
  ) => PromiseLike<RESULT>;
  readonly [TOOL_NAME_KEY]: string;
};

/**
 * Create a Vercel AI SDK tool with Grantex scope enforcement.
 *
 * Performs an **offline** scope check against the JWT `scp` claim at
 * construction time. Throws {@link GrantexScopeError} immediately if the
 * required scope is absent — before any LLM call can invoke the tool.
 *
 * The returned value is a standard Vercel AI `Tool` and can be used
 * directly in the `tools` map of `generateText` / `streamText`.
 *
 * @example
 * ```ts
 * import { createGrantexTool } from '@grantex/vercel-ai';
 * import { z } from 'zod';
 *
 * const fetchTool = createGrantexTool({
 *   name: 'fetch_data',
 *   description: 'Fetches data from a URL.',
 *   parameters: z.object({ url: z.string().url() }),
 *   grantToken: token,
 *   requiredScope: 'data:read',
 *   execute: async ({ url }) => fetch(url).then(r => r.text()),
 * });
 *
 * const result = await generateText({
 *   model: myModel,
 *   tools: { fetch_data: fetchTool },
 *   prompt: 'Fetch https://example.com',
 * });
 * ```
 *
 * @throws {GrantexScopeError} if the grant token lacks `requiredScope`.
 * @throws {Error} if the grant token is not a valid JWT.
 */
export function createGrantexTool<PARAMETERS extends z.ZodTypeAny, RESULT>(
  options: CreateGrantexToolOptions<PARAMETERS, RESULT>,
): GrantexTool<PARAMETERS, RESULT> {
  const { name, description, parameters, grantToken, requiredScope, execute } =
    options;

  // Offline scope check — fail fast before any LLM call
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwtPayload(grantToken);
  } catch (err) {
    throw new Error(
      `Grantex: could not decode grant token — ${(err as Error).message}`,
    );
  }

  const scopes = Array.isArray(payload['scp'])
    ? (payload['scp'] as string[])
    : [];

  if (!scopes.includes(requiredScope)) {
    throw new GrantexScopeError(requiredScope, scopes);
  }

  const vercelTool = {
    description,
    inputSchema: zodSchema(parameters),
    execute,
  } as unknown as Tool<PARAMETERS, RESULT>;

  return Object.defineProperty(vercelTool, TOOL_NAME_KEY, {
    value: name,
    writable: false,
    enumerable: false,
    configurable: false,
  }) as GrantexTool<PARAMETERS, RESULT>;
}

/**
 * Return the scopes embedded in a Grantex grant token.
 *
 * Purely offline — no network call, no signature check.
 */
export function getGrantScopes(grantToken: string): string[] {
  const payload = decodeJwtPayload(grantToken);
  return Array.isArray(payload['scp']) ? (payload['scp'] as string[]) : [];
}

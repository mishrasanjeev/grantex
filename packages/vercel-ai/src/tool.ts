import type { Tool } from 'ai';
import type { z } from 'zod';
import { zodSchema } from 'ai';
import { verifyGrantToken, type VerifyGrantTokenOptions } from '@grantex/sdk';
import { decodeJwtPayload } from './_jwt.js';
import { GrantexScopeError, type CreateGrantexToolOptions, type GrantexToolExecutionOptions } from './types.js';

/** Symbol key used to carry the tool name through to `withAuditLogging`. */
export const TOOL_NAME_KEY = Symbol('grantex.toolName');
const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';

/**
 * A Vercel AI `Tool` augmented with the Grantex tool name for audit logging.
 */
export type GrantexTool<PARAMETERS extends z.ZodTypeAny, RESULT> = Tool<
  PARAMETERS,
  RESULT
> & {
  execute: (
    args: z.infer<PARAMETERS>,
    options: GrantexToolExecutionOptions,
  ) => PromiseLike<RESULT>;
  readonly [TOOL_NAME_KEY]: string;
};

/**
 * Create a Vercel AI SDK tool with Grantex scope enforcement.
 *
 * Verifies the JWT signature and grant claims before each execution, then
 * checks the verified `scp` claim for the required scope.
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
 * @throws {GrantexScopeError} if the verified grant token lacks `requiredScope`.
 * @throws {Error} if the grant token cannot be verified.
 */
export function createGrantexTool<PARAMETERS extends z.ZodTypeAny, RESULT>(
  options: CreateGrantexToolOptions<PARAMETERS, RESULT>,
): GrantexTool<PARAMETERS, RESULT> {
  const { name, description, parameters, grantToken, requiredScope, execute } =
    options;

  const vercelTool = {
    description,
    inputSchema: zodSchema(parameters),
    execute: async (
      args: z.infer<PARAMETERS>,
      toolOptions: GrantexToolExecutionOptions,
    ): Promise<RESULT> => {
      const grant = await verifyGrantToken(grantToken, buildVerifyOptions(options));
      const scopes = grant.scopes;
      if (!scopes.includes(requiredScope)) {
        throw new GrantexScopeError(requiredScope, scopes);
      }
      return execute(args, toolOptions) as Promise<RESULT>;
    },
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

function buildVerifyOptions<PARAMETERS extends z.ZodTypeAny, RESULT>(
  options: CreateGrantexToolOptions<PARAMETERS, RESULT>,
): VerifyGrantTokenOptions {
  return {
    jwksUri: options.jwksUri ?? DEFAULT_JWKS_URI,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  };
}

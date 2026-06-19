import { verifyGrantToken, type VerifyGrantTokenOptions } from '@grantex/sdk';
import type { GrantexFunction, GrantexFunctionOptions, OpenAIFunctionTool } from './types.js';

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';

/**
 * Create a Grantex-authorized function in OpenAI function-calling format.
 *
 * The scope check is performed offline by reading the `scp` claim from the
 * grant token JWT — no network call is made. If the agent does not hold
 * `requiredScope`, `execute()` throws before calling `func`.
 *
 * @example
 * ```ts
 * const calendarFn = createGrantexFunction({
 *   name: 'list_calendar_events',
 *   description: "List the user's upcoming calendar events",
 *   parameters: {
 *     type: 'object',
 *     properties: { date: { type: 'string', description: 'ISO date string' } },
 *     required: ['date'],
 *   },
 *   grantToken: tokenResponse.grantToken,
 *   requiredScope: 'calendar:read',
 *   func: async ({ date }) => fetchCalendarEvents(date as string),
 * });
 *
 * // Pass to AutoGen / OpenAI:
 * const tools = [calendarFn.definition];
 *
 * // Execute after LLM selects the tool:
 * const result = await calendarFn.execute({ date: '2024-01-15' });
 * ```
 */
export function createGrantexFunction<T extends Record<string, unknown>>(
  options: GrantexFunctionOptions<T>,
): GrantexFunction<T> {
  const { name, description, parameters, grantToken, requiredScope, func } = options;

  const definition: OpenAIFunctionTool = {
    type: 'function',
    function: { name, description, parameters },
  };

  return {
    definition,
    async execute(args: T): Promise<unknown> {
      const grant = await verifyGrantToken(grantToken, buildVerifyOptions(options));
      const scopes = grant.scopes;

      if (!scopes.includes(requiredScope)) {
        throw new Error(
          `Grantex: agent is not authorized for scope '${requiredScope}'. ` +
            `Granted scopes: ${scopes.join(', ') || 'none'}.`,
        );
      }

      return func(args);
    },
  };
}

function buildVerifyOptions<T extends Record<string, unknown>>(
  options: GrantexFunctionOptions<T>,
): VerifyGrantTokenOptions {
  return {
    jwksUri: options.jwksUri ?? DEFAULT_JWKS_URI,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  };
}

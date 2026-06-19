import { DynamicTool } from '@langchain/core/tools';
import { verifyGrantToken, type VerifyGrantTokenOptions } from '@grantex/sdk';

export interface GrantexToolOptions {
  /** Tool name shown to the LLM in the prompt. */
  name: string;
  /** Tool description shown to the LLM. */
  description: string;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** JWKS URL used to verify the grant token. Defaults to https://api.grantex.dev/.well-known/jwks.json. */
  jwksUri?: string;
  /** Expected JWT issuer when it differs from the JWKS origin. */
  issuer?: string;
  /** did:web issuer used to derive the JWKS URL. */
  issuerDid?: string;
  /** Expected JWT audience. */
  audience?: string;
  /** Clock tolerance in seconds for token verification. */
  clockTolerance?: number;
  /** Scope the agent must hold to invoke this tool (e.g. `'calendar:read'`). */
  requiredScope: string;
  /** The tool implementation. Receives a string input, returns a string output. */
  func: (input: string) => Promise<string>;
}

const DEFAULT_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';

/**
 * Create a LangChain `DynamicTool` that enforces Grantex scope authorization.
 *
 * The scope check is performed offline by reading the `scp` claim from the
 * grant token JWT — no network call is made. If the agent does not hold
 * `requiredScope`, the tool throws before calling `func`.
 *
 * @example
 * ```ts
 * const calendarTool = createGrantexTool({
 *   name: 'read_calendar',
 *   description: "Read the user's upcoming calendar events",
 *   grantToken: tokenResponse.grantToken,
 *   requiredScope: 'calendar:read',
 *   func: async (input) => fetchCalendarEvents(input),
 * });
 * ```
 */
export function createGrantexTool(options: GrantexToolOptions): DynamicTool {
  const { name, description, grantToken, requiredScope, func } = options;

  return new DynamicTool({
    name,
    description,
    func: async (input: string): Promise<string> => {
      const grant = await verifyGrantToken(grantToken, buildVerifyOptions(options));
      const scopes = grant.scopes;

      if (!scopes.includes(requiredScope)) {
        throw new Error(
          `Grantex: agent is not authorized for scope '${requiredScope}'. ` +
            `Granted scopes: ${scopes.join(', ') || 'none'}.`,
        );
      }

      return func(input);
    },
  });
}

function buildVerifyOptions(options: GrantexToolOptions): VerifyGrantTokenOptions {
  return {
    jwksUri: options.jwksUri ?? DEFAULT_JWKS_URI,
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.issuerDid !== undefined ? { issuerDid: options.issuerDid } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
    ...(options.clockTolerance !== undefined ? { clockTolerance: options.clockTolerance } : {}),
  };
}

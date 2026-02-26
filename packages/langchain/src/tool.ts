import { DynamicTool } from '@langchain/core/tools';
import { decodeJwtPayload } from './_jwt.js';

export interface GrantexToolOptions {
  /** Tool name shown to the LLM in the prompt. */
  name: string;
  /** Tool description shown to the LLM. */
  description: string;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** Scope the agent must hold to invoke this tool (e.g. `'calendar:read'`). */
  requiredScope: string;
  /** The tool implementation. Receives a string input, returns a string output. */
  func: (input: string) => Promise<string>;
}

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
      const payload = decodeJwtPayload(grantToken);
      const scopes = payload['scp'];

      if (!Array.isArray(scopes) || !(scopes as string[]).includes(requiredScope)) {
        throw new Error(
          `Grantex: agent is not authorized for scope '${requiredScope}'. ` +
            `Granted scopes: ${Array.isArray(scopes) ? (scopes as string[]).join(', ') : 'none'}.`,
        );
      }

      return func(input);
    },
  });
}

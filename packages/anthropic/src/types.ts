/** A subset of JSON Schema sufficient for Anthropic tool input_schema. */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

/** Anthropic tool definition as expected by the Anthropic SDK. */
export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Options for {@link createGrantexTool}. */
export interface CreateGrantexToolOptions<T> {
  /** Tool name shown to the LLM. Must match `^[a-zA-Z0-9_-]+$`. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema describing the structured input arguments. */
  inputSchema: JsonSchema;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** Scope the agent must hold to invoke this tool (e.g. `'file:read'`). */
  requiredScope: string;
  /** The tool implementation. Receives typed args, returns any JSON-serialisable value. */
  execute: (args: T) => Promise<unknown>;
}

/**
 * A Grantex-authorized tool in Anthropic tool format.
 *
 * - `definition` — pass this to the `tools` array in `client.messages.create()`
 * - `execute(args)` — call when handling a `tool_use` content block; enforces scope offline
 */
export interface GrantexTool<T> {
  /** Anthropic tool definition for passing to the LLM. */
  readonly definition: AnthropicToolDefinition;
  /**
   * Execute the tool with the given arguments.
   * Verifies the required scope offline before calling the implementation.
   * Throws {@link GrantexScopeError} if the agent does not hold the required scope.
   */
  execute(args: T): Promise<unknown>;
}

/**
 * Thrown when the grant token does not contain the required scope.
 */
export class GrantexScopeError extends Error {
  readonly requiredScope: string;
  readonly grantedScopes: string[];

  constructor(requiredScope: string, grantedScopes: string[]) {
    super(
      `Grantex: agent is not authorized for scope '${requiredScope}'. ` +
        `Granted scopes: ${grantedScopes.length > 0 ? grantedScopes.join(', ') : 'none'}.`,
    );
    this.name = 'GrantexScopeError';
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
    Object.setPrototypeOf(this, GrantexScopeError.prototype);
  }
}

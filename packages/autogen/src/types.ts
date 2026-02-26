/** A subset of JSON Schema sufficient for OpenAI function parameters. */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

/** OpenAI / AutoGen function-calling tool definition. */
export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/** Options for {@link createGrantexFunction}. */
export interface GrantexFunctionOptions<T extends Record<string, unknown>> {
  /** Function name shown to the LLM. Must match `^[a-zA-Z0-9_-]+$`. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema describing the structured input arguments. */
  parameters: JsonSchema;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** Scope the agent must hold to invoke this function (e.g. `'calendar:read'`). */
  requiredScope: string;
  /** The function implementation. Receives typed args, returns any JSON-serialisable value. */
  func: (args: T) => Promise<unknown>;
}

/**
 * A Grantex-authorized function in OpenAI function-calling format.
 *
 * - `definition` — pass this to the LLM (inside a `tools` array)
 * - `execute(args)` — call after the LLM selects the tool; enforces scope offline
 */
export interface GrantexFunction<T extends Record<string, unknown>> {
  /** OpenAI function-calling tool definition for passing to the LLM. */
  readonly definition: OpenAIFunctionTool;
  /**
   * Execute the function with the given arguments.
   * Verifies the required scope offline before calling `func`.
   * Throws if the agent does not hold the required scope.
   */
  execute(args: T): Promise<unknown>;
}

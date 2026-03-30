/** JSON Schema for nested properties (type is a free string: 'string', 'number', etc.). */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * Top-level input schema for an Anthropic tool.
 * Anthropic requires `type: 'object'` at the top level.
 */
export interface AnthropicInputSchema {
  type: 'object';
  properties?: Record<string, JsonSchema> | null;
  required?: string[];
  [key: string]: unknown;
}

/** Anthropic tool definition as passed to `client.messages.create({ tools })`. */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: AnthropicInputSchema;
}

/**
 * Anthropic tool_use content block from a response.
 * `input` is typed as `unknown` to match the SDK's `ToolUseBlock.input`.
 */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

/** Options for {@link createGrantexTool}. */
export interface CreateGrantexToolOptions<T extends Record<string, unknown>> {
  /** Tool name shown to the model. Must match `^[a-zA-Z0-9_-]+$`. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** JSON Schema describing the tool's input parameters (`type` must be `'object'`). */
  inputSchema: AnthropicInputSchema;
  /** Grantex grant token obtained from the token exchange. */
  grantToken: string;
  /** Scope the agent must hold to invoke this tool (e.g. `'file:read'`). */
  requiredScope: string;
  /** The tool implementation. Receives typed args, returns any JSON-serialisable value. */
  execute: (args: T) => Promise<unknown>;
}

/**
 * A Grantex-authorized tool in Anthropic SDK format.
 *
 * - `definition` — pass this to the `tools` array of `client.messages.create()`
 * - `execute(args)` — call when handling a `tool_use` block; enforces scope offline
 */
export interface GrantexTool<T extends Record<string, unknown>> {
  /** Anthropic tool definition for passing to the model. */
  readonly definition: AnthropicToolDefinition;
  /**
   * Execute the tool with the given arguments.
   * Verifies the required scope offline before calling the implementation.
   * @throws {GrantexScopeError} if the agent does not hold the required scope.
   */
  execute(args: T): Promise<unknown>;
}

/** Options for {@link withAuditLogging}. */
export interface AuditLoggingOptions {
  /** Agent ID to record in audit entries. */
  agentId: string;
  /** Agent DID (e.g. `'did:key:z6Mk...'`). */
  agentDid: string;
  /** Grant ID associated with the tool invocation. */
  grantId: string;
  /** Principal ID that granted authorization. */
  principalId: string;
}

/** Thrown when a grant token is missing a required scope. */
export class GrantexScopeError extends Error {
  readonly requiredScope: string;
  readonly grantedScopes: string[];

  constructor(requiredScope: string, grantedScopes: string[]) {
    super(
      `Grantex: agent is not authorized for scope '${requiredScope}'. ` +
        `Granted scopes: [${grantedScopes.join(', ')}]`,
    );
    this.name = 'GrantexScopeError';
    this.requiredScope = requiredScope;
    this.grantedScopes = grantedScopes;
  }
}

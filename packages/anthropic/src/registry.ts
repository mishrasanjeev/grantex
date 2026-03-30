import type { GrantexTool, AnthropicToolDefinition, AnthropicToolUseBlock } from './types.js';

/**
 * Registry that collects multiple {@link GrantexTool}s and provides a
 * single executor for dispatching `tool_use` blocks by name.
 *
 * @example
 * ```ts
 * import Anthropic from '@anthropic-ai/sdk';
 * import { createGrantexTool, GrantexToolRegistry } from '@grantex/anthropic';
 *
 * const registry = new GrantexToolRegistry();
 * registry.register(readFileTool).register(writeFileTool);
 *
 * const response = await client.messages.create({
 *   model: 'claude-opus-4-6',
 *   max_tokens: 1024,
 *   tools: registry.definitions,
 *   messages,
 * });
 *
 * for (const block of response.content) {
 *   if (block.type === 'tool_use') {
 *     const result = await registry.execute(block);
 *   }
 * }
 * ```
 */
export class GrantexToolRegistry {
  readonly #tools = new Map<string, GrantexTool<Record<string, unknown>>>();

  /**
   * Register a Grantex tool.
   * Returns `this` for chaining.
   */
  register<T extends Record<string, unknown>>(tool: GrantexTool<T>): this {
    this.#tools.set(tool.definition.name, tool as GrantexTool<Record<string, unknown>>);
    return this;
  }

  /** Anthropic tool definitions for all registered tools. */
  get definitions(): AnthropicToolDefinition[] {
    return Array.from(this.#tools.values()).map((t) => t.definition);
  }

  /**
   * Execute a registered tool from an Anthropic `tool_use` block.
   * @throws {Error} if no tool with that name is registered.
   * @throws {GrantexScopeError} if the grant token lacks the required scope.
   */
  async execute(block: AnthropicToolUseBlock): Promise<unknown> {
    const tool = this.#tools.get(block.name);
    if (!tool) {
      throw new Error(`Grantex: no tool registered with name '${block.name}'.`);
    }
    return tool.execute(block.input as Record<string, unknown>);
  }
}

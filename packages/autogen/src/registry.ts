import type { GrantexFunction, OpenAIFunctionTool } from './types.js';

/**
 * Registry that collects multiple {@link GrantexFunction}s and provides a
 * single executor for dispatching tool calls by name.
 *
 * @example
 * ```ts
 * const registry = new GrantexFunctionRegistry();
 * registry.register(calendarFn).register(emailFn);
 *
 * // Pass all definitions to the LLM:
 * const response = await openai.chat.completions.create({
 *   tools: registry.definitions,
 *   ...
 * });
 *
 * // Dispatch the LLM's chosen tool call:
 * const result = await registry.execute(
 *   toolCall.function.name,
 *   JSON.parse(toolCall.function.arguments),
 * );
 * ```
 */
export class GrantexFunctionRegistry {
  readonly #functions = new Map<string, GrantexFunction<Record<string, unknown>>>();

  /**
   * Register a Grantex function.
   * Returns `this` for chaining.
   */
  register<T extends Record<string, unknown>>(fn: GrantexFunction<T>): this {
    this.#functions.set(fn.definition.function.name, fn as GrantexFunction<Record<string, unknown>>);
    return this;
  }

  /** OpenAI function-calling tool definitions for all registered functions. */
  get definitions(): OpenAIFunctionTool[] {
    return Array.from(this.#functions.values()).map((fn) => fn.definition);
  }

  /**
   * Execute a registered function by name.
   * @throws {Error} if no function with that name is registered.
   */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const fn = this.#functions.get(name);
    if (!fn) {
      throw new Error(`Grantex: no function registered with name '${name}'.`);
    }
    return fn.execute(args);
  }
}

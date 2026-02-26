import { describe, it, expect, vi } from 'vitest';
import { GrantexFunctionRegistry } from '../src/registry.js';
import type { GrantexFunction } from '../src/types.js';

/** Build a minimal stub GrantexFunction. */
function makeFn(name: string, result: unknown = 'ok'): GrantexFunction<Record<string, unknown>> {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Does ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

describe('GrantexFunctionRegistry', () => {
  it('exposes definitions for all registered functions', () => {
    const registry = new GrantexFunctionRegistry();
    registry.register(makeFn('fn_a')).register(makeFn('fn_b'));

    const names = registry.definitions.map((d) => d.function.name);
    expect(names).toContain('fn_a');
    expect(names).toContain('fn_b');
    expect(registry.definitions).toHaveLength(2);
  });

  it('dispatches execute() to the correct function', async () => {
    const fnA = makeFn('fn_a', 'result_a');
    const fnB = makeFn('fn_b', 'result_b');
    const registry = new GrantexFunctionRegistry();
    registry.register(fnA).register(fnB);

    const result = await registry.execute('fn_b', { foo: 'bar' });

    expect(result).toBe('result_b');
    expect(fnB.execute).toHaveBeenCalledWith({ foo: 'bar' });
    expect(fnA.execute).not.toHaveBeenCalled();
  });

  it('throws when executing an unknown function name', async () => {
    const registry = new GrantexFunctionRegistry();
    registry.register(makeFn('fn_a'));

    await expect(registry.execute('nonexistent', {})).rejects.toThrow('nonexistent');
  });

  it('returns this from register() for chaining', () => {
    const registry = new GrantexFunctionRegistry();
    const returned = registry.register(makeFn('fn_a'));
    expect(returned).toBe(registry);
  });

  it('returns an empty definitions array when no functions are registered', () => {
    const registry = new GrantexFunctionRegistry();
    expect(registry.definitions).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { GrantexToolRegistry } from '../src/registry.js';
import type { GrantexTool, AnthropicToolUseBlock } from '../src/types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTool(
  name: string,
  result: unknown = 'ok',
): GrantexTool<Record<string, unknown>> {
  return {
    definition: {
      name,
      description: `Does ${name}`,
      input_schema: { type: 'object' as const, properties: {} },
    },
    execute: vi.fn().mockResolvedValue(result),
  };
}

function makeBlock(name: string, input: Record<string, unknown> = {}): AnthropicToolUseBlock {
  return { type: 'tool_use', id: 'toolu_01', name, input };
}

// ─── GrantexToolRegistry ──────────────────────────────────────────────────────

describe('GrantexToolRegistry', () => {
  it('exposes definitions for all registered tools', () => {
    const registry = new GrantexToolRegistry();
    registry.register(makeTool('tool_a')).register(makeTool('tool_b'));

    const names = registry.definitions.map((d) => d.name);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
    expect(registry.definitions).toHaveLength(2);
  });

  it('dispatches execute() to the correct tool', async () => {
    const toolA = makeTool('tool_a', 'result_a');
    const toolB = makeTool('tool_b', 'result_b');
    const registry = new GrantexToolRegistry();
    registry.register(toolA).register(toolB);

    const result = await registry.execute(makeBlock('tool_b', { foo: 'bar' }));

    expect(result).toBe('result_b');
    expect(toolB.execute).toHaveBeenCalledWith({ foo: 'bar' });
    expect(toolA.execute).not.toHaveBeenCalled();
  });

  it('throws when executing an unknown tool name', async () => {
    const registry = new GrantexToolRegistry();
    registry.register(makeTool('tool_a'));

    await expect(registry.execute(makeBlock('nonexistent'))).rejects.toThrow('nonexistent');
  });

  it('returns this from register() for chaining', () => {
    const registry = new GrantexToolRegistry();
    const returned = registry.register(makeTool('tool_a'));
    expect(returned).toBe(registry);
  });

  it('returns an empty definitions array when no tools are registered', () => {
    const registry = new GrantexToolRegistry();
    expect(registry.definitions).toEqual([]);
  });

  it('passes block.input as args to execute', async () => {
    const tool = makeTool('my_tool');
    const registry = new GrantexToolRegistry();
    registry.register(tool);

    await registry.execute(makeBlock('my_tool', { x: 1, y: 'hello' }));

    expect(tool.execute).toHaveBeenCalledWith({ x: 1, y: 'hello' });
  });
});

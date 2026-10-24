import { readFileSync } from 'node:fs';
import { DynamicTool } from '@langchain/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { verifyGrantToken } from '@grantex/sdk';
import { createGrantexTool } from '../src/tool.js';

vi.mock('@grantex/sdk', () => ({ verifyGrantToken: vi.fn() }));

describe('installed LangChain runtime compatibility', () => {
  it('retains the upstream tracing dependency requirement', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const requirement = lock.packages['node_modules/@langchain/core'].dependencies.langsmith;
    expect(manifest.overrides.langsmith).toBe(requirement);
  });

  it('invokes the real DynamicTool and rechecks authorization before execution', async () => {
    const verifier = vi.mocked(verifyGrantToken);
    verifier.mockReset();
    verifier.mockResolvedValueOnce({ scopes: ['data:read'] } as Awaited<ReturnType<typeof verifyGrantToken>>);
    verifier.mockRejectedValueOnce(new Error('grant revoked'));
    const callback = vi.fn(async (input: string) => `fixture:${input}`);
    const tool = createGrantexTool({
      name: 'read_fixture', description: 'Read a synthetic fixture.',
      grantToken: 'synthetic-token', requiredScope: 'data:read', func: callback,
    });
    expect(tool).toBeInstanceOf(DynamicTool);
    await expect(tool.invoke('sample')).resolves.toBe('fixture:sample');
    await expect(tool.invoke('blocked')).rejects.toThrow('grant revoked');
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

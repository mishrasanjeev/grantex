import { beforeEach, describe, expect, it, vi } from 'vitest';

// Simulate a published @grantex/sdk without the grant token audience check.
// Its enforce() would ignore --audience and report a token for another relying
// party as allowed, so the command refuses the audience options instead.
vi.mock('@grantex/sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const tokenSubReason = { ...(actual['TokenSubReason'] as Record<string, string>) };
  delete tokenSubReason['AUDIENCE_UNCONFIGURED'];
  delete tokenSubReason['AUDIENCE_MISMATCH'];
  return { ...actual, TokenSubReason: tokenSubReason };
});

vi.mock('../src/client.js', () => ({ requireClient: vi.fn() }));

import { requireClient } from '../src/client.js';
import { enforceCommand } from '../src/commands/enforce.js';
import { setJsonMode } from '../src/format.js';

const mockClient = { enforce: vi.fn(), loadManifest: vi.fn() };

function run(...extra: string[]): Promise<unknown> {
  const cmd = enforceCommand();
  cmd.exitOverride();
  return cmd.parseAsync([
    'node', 'test', 'test', '--token', 'jwt_token_value', '--connector', 'salesforce', '--tool', 'query',
    ...extra,
  ]);
}

describe('grantex enforce test with an @grantex/sdk that has no audience check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
    process.exitCode = undefined;
  });

  it.each([
    ['--audience', 'https://api.merchant.example'],
    ['--audience-check', 'on'],
  ])('refuses %s instead of ignoring it', async (flag, value) => {
    await run(flag, value);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(
      'the installed @grantex/sdk does not check the grant token audience',
    ));
    expect(process.exitCode).toBe(1);
    expect(requireClient).not.toHaveBeenCalled();
    expect(mockClient.enforce).not.toHaveBeenCalled();
  });

  it('still runs without the audience options', async () => {
    mockClient.enforce.mockResolvedValue({ allowed: true, scopes: [], permission: 'read', reason: '' });
    await run();
    expect(mockClient.enforce).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });
});

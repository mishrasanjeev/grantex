import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Grantex } from '@grantex/sdk';

vi.mock('@langchain/core/callbacks/base', () => ({
  BaseCallbackHandler: class MockBase {},
}));

vi.mock('@grantex/sdk', () => ({
  Grantex: class {},
}));

import { GrantexAuditHandler } from '../src/callback.js';

function makeToken(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.fakesig`;
}

const GRANT_TOKEN = makeToken({ grnt: 'grnt_01', jti: 'tok_01', scp: ['calendar:read'] });
const TOKEN_JTI_ONLY = makeToken({ jti: 'tok_fallback', scp: ['calendar:read'] });
const TOKEN_NO_ID = makeToken({ scp: ['calendar:read'] });

describe('GrantexAuditHandler', () => {
  let mockLog: ReturnType<typeof vi.fn>;
  let mockClient: Grantex;

  beforeEach(() => {
    mockLog = vi.fn().mockResolvedValue({});
    mockClient = { audit: { log: mockLog } } as unknown as Grantex;
  });

  it('logs tool start with the tool name and success status', async () => {
    const handler = new GrantexAuditHandler({
      client: mockClient,
      agentId: 'ag_01',
      grantToken: GRANT_TOKEN,
    });

    await handler.handleToolStart({ name: 'read_calendar' }, 'show me today');

    expect(mockLog).toHaveBeenCalledWith({
      agentId: 'ag_01',
      grantId: 'grnt_01',
      action: 'tool:read_calendar',
      metadata: { input: 'show me today' },
      status: 'success',
    });
  });

  it('logs tool error with failure status', async () => {
    const handler = new GrantexAuditHandler({
      client: mockClient,
      agentId: 'ag_01',
      grantToken: GRANT_TOKEN,
    });

    await handler.handleToolError(new Error('API connection timed out'));

    expect(mockLog).toHaveBeenCalledWith({
      agentId: 'ag_01',
      grantId: 'grnt_01',
      action: 'tool:error',
      metadata: { error: 'API connection timed out' },
      status: 'failure',
    });
  });

  it('falls back to jti when grnt claim is absent', async () => {
    const handler = new GrantexAuditHandler({
      client: mockClient,
      agentId: 'ag_01',
      grantToken: TOKEN_JTI_ONLY,
    });

    await handler.handleToolStart({ name: 'some_tool' }, 'input');

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'tok_fallback' }),
    );
  });

  it('throws on construction when token has neither grnt nor jti', () => {
    expect(
      () =>
        new GrantexAuditHandler({
          client: mockClient,
          agentId: 'ag_01',
          grantToken: TOKEN_NO_ID,
        }),
    ).toThrow('grantId');
  });
});

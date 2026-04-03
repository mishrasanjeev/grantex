import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';
import { verifyCommand } from '../src/commands/verify.js';
import { setJsonMode } from '../src/format.js';

// Helper: create a self-signed JWT for testing
async function createTestJwt(
  claims: Record<string, unknown> = {},
  opts: { expired?: boolean; alg?: string } = {},
): Promise<{ token: string; publicKey: jose.KeyLike; privateKey: jose.KeyLike }> {
  const alg = opts.alg ?? 'RS256';
  const { publicKey, privateKey } = await jose.generateKeyPair(alg);
  const now = Math.floor(Date.now() / 1000);

  const builder = new jose.SignJWT({
    sub: 'user_alice',
    agt: 'did:grantex:ag_01HXYZ',
    dev: 'dev_01',
    scp: ['calendar:read', 'email:send:max_10'],
    grnt: 'grnt_01HXYZ',
    delegationDepth: 0,
    ...claims,
  })
    .setProtectedHeader({ alg, kid: 'test-key-1' })
    .setIssuedAt(opts.expired ? now - 7200 : now)
    .setJti('jti_test_01');

  if (opts.expired) {
    builder.setExpirationTime(now - 3600); // expired 1h ago
  } else {
    builder.setExpirationTime(now + 86400); // expires in 24h
  }

  const token = await builder.sign(privateKey);
  return { token, publicKey, privateKey };
}

describe('verifyCommand()', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  it('registers the "verify" command name', () => {
    const cmd = verifyCommand();
    expect(cmd.name()).toBe('verify');
  });

  it('decodes and displays a valid token in pretty format', async () => {
    const { token } = await createTestJwt();
    const cmd = verifyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Grantex Grant Token');
    expect(allOutput).toContain('grnt_01HXYZ');
    expect(allOutput).toContain('did:grantex:ag_01HXYZ');
    expect(allOutput).toContain('user_alice');
    expect(allOutput).toContain('calendar:read');
    expect(allOutput).toContain('email:send:max_10');
    expect(allOutput).toContain('RS256');
  });

  it('exits 1 for an expired token', async () => {
    const { token } = await createTestJwt({}, { expired: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', token])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('shows "Expired" status for expired token', async () => {
    const { token } = await createTestJwt({}, { expired: true });
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    try {
      await cmd.parseAsync(['node', 'test', token]);
    } catch {
      // expected
    }

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Expired');
    vi.mocked(process.exit).mockRestore();
  });

  it('--json produces valid JSON for a valid token', async () => {
    const { token } = await createTestJwt();
    setJsonMode(true);
    const cmd = verifyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token, '--json']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.grantId).toBe('grnt_01HXYZ');
    expect(parsed.agentDid).toBe('did:grantex:ag_01HXYZ');
    expect(parsed.principal).toBe('user_alice');
    expect(parsed.scopes).toContain('calendar:read');
    expect(parsed.algorithm).toBe('RS256');
    expect(parsed.elapsedMs).toBeTypeOf('number');
  });

  it('--json for expired token includes expired status', async () => {
    const { token } = await createTestJwt({}, { expired: true });
    setJsonMode(true);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    try {
      await cmd.parseAsync(['node', 'test', token, '--json']);
    } catch {
      // expected
    }

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('expired');
    vi.mocked(process.exit).mockRestore();
  });

  it('exits 1 for malformed token', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'not-a-jwt'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('shows delegation info for delegated tokens', async () => {
    const { token } = await createTestJwt({
      delegationDepth: 2,
      parentAgt: 'did:grantex:ag_parent',
      parentGrnt: 'grnt_parent_01',
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Delegation');
    expect(allOutput).toContain('depth: 2');
    expect(allOutput).toContain('did:grantex:ag_parent');
    expect(allOutput).toContain('grnt_parent_01');
  });

  it('shows budget claim when present', async () => {
    const { token } = await createTestJwt({ bdg: 42.5 });

    const cmd = verifyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Budget');
    expect(allOutput).toContain('42.5');
  });

  it('--verbose shows JWT header and claims', async () => {
    const { token } = await createTestJwt();

    const cmd = verifyCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token, '--verbose']);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('JWT Header');
    expect(allOutput).toContain('JWT Claims');
    expect(allOutput).toContain('"alg"');
    expect(allOutput).toContain('"kid"');
  });

  it('exits 1 when no token provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = verifyCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('reads token from --file', async () => {
    const { token } = await createTestJwt();

    // Write token to a temp file
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpFile = path.join(os.tmpdir(), `grantex-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, token);

    try {
      setJsonMode(true);
      const cmd = verifyCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', '--file', tmpFile, '--json']);

      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.grantId).toBe('grnt_01HXYZ');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

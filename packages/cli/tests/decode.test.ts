import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';
import { decodeCommand } from '../src/commands/decode.js';
import { setJsonMode } from '../src/format.js';

async function createTestJwt(claims: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = await jose.generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);

  return new jose.SignJWT({
    sub: 'user_bob',
    agt: 'did:grantex:ag_decode_test',
    scp: ['files:read'],
    grnt: 'grnt_decode_01',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'decode-key-1' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setJti('jti_decode_01')
    .sign(privateKey);
}

describe('decodeCommand()', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  it('registers the "decode" command name', () => {
    const cmd = decodeCommand();
    expect(cmd.name()).toBe('decode');
  });

  it('decodes a valid JWT and shows header and payload', async () => {
    const token = await createTestJwt();
    const cmd = decodeCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('JWT Header');
    expect(allOutput).toContain('JWT Payload');
    expect(allOutput).toContain('"alg"');
    expect(allOutput).toContain('user_bob');
    expect(allOutput).toContain('did:grantex:ag_decode_test');
    expect(allOutput).toContain('Signature was NOT verified');
  });

  it('--json outputs header and payload as JSON', async () => {
    const token = await createTestJwt();
    setJsonMode(true);
    const cmd = decodeCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token, '--json']);

    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.header).toBeDefined();
    expect(parsed.payload).toBeDefined();
    expect(parsed.header.alg).toBe('RS256');
    expect(parsed.header.kid).toBe('decode-key-1');
    expect(parsed.payload.sub).toBe('user_bob');
    expect(parsed.payload.grnt).toBe('grnt_decode_01');
  });

  it('exits 1 for malformed token', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = decodeCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test', 'not-a-jwt'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits 1 with no token argument', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const cmd = decodeCommand();
    cmd.exitOverride();
    await expect(cmd.parseAsync(['node', 'test'])).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('reads token from --file', async () => {
    const token = await createTestJwt();

    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const tmpFile = path.join(os.tmpdir(), `grantex-decode-test-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, token);

    try {
      setJsonMode(true);
      const cmd = decodeCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', '--file', tmpFile, '--json']);

      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.payload.sub).toBe('user_bob');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('shows human-readable expiry info', async () => {
    const token = await createTestJwt();
    const cmd = decodeCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Expires:');
  });

  it('shows "Expired" for expired token', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({ sub: 'test' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(privateKey);

    const cmd = decodeCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', token]);

    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('Expired:');
  });
});

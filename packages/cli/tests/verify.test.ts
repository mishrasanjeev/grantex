import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as jose from 'jose';
import { verifyCommand } from '../src/commands/verify.js';
import { setJsonMode } from '../src/format.js';

type TestKeyPair = Awaited<ReturnType<typeof jose.generateKeyPair>>;

// The CLI only trusts keys from the configured Grantex base URL (or
// production), never from the token's own `iss`. Tests therefore stand up a
// JWKS server, point GRANTEX_URL at it, and sign with its key.
let issuerKeys: TestKeyPair;
let jwksServer: Server;
let issuer: string;
let jwksRequests = 0;

beforeAll(async () => {
  issuerKeys = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(issuerKeys.publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwksServer = createServer((req, res) => {
    jwksRequests += 1;
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const addr = jwksServer.address();
  issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => jwksServer.close((err) => (err ? reject(err) : resolve())));
});

// Helper: create a JWT signed by the trusted issuer (or by a foreign key).
async function createTestJwt(
  claims: Record<string, unknown> = {},
  opts: { expired?: boolean; alg?: string; foreignKey?: boolean } = {},
): Promise<{ token: string; publicKey: TestKeyPair['publicKey']; privateKey: TestKeyPair['privateKey'] }> {
  const alg = opts.alg ?? 'RS256';
  const { publicKey, privateKey } = opts.foreignKey || alg !== 'RS256'
    ? await jose.generateKeyPair(alg)
    : issuerKeys;
  const now = Math.floor(Date.now() / 1000);

  const builder = new jose.SignJWT({
    iss: issuer,
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

function expectExit1() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
}

function firstJsonOutput(): Record<string, unknown> {
  return JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
}

describe('verifyCommand()', () => {
  const savedUrl = process.env['GRANTEX_URL'];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
    process.env['GRANTEX_URL'] = issuer;
    jwksRequests = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
    if (savedUrl === undefined) delete process.env['GRANTEX_URL'];
    else process.env['GRANTEX_URL'] = savedUrl;
  });

  describe('trust anchoring', () => {
    it('reports a token signed by a foreign key as invalid_signature, exit 1', async () => {
      const { token } = await createTestJwt({}, { foreignKey: true });
      const exitSpy = expectExit1();
      setJsonMode(true);

      const cmd = verifyCommand();
      cmd.exitOverride();
      await expect(cmd.parseAsync(['node', 'test', token, '--json'])).rejects.toThrow('process.exit');

      expect(firstJsonOutput().status).toBe('invalid_signature');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('never fetches a JWKS from the token iss claim', async () => {
      // A forged token naming an attacker-controlled issuer, signed by the
      // attacker's key (which that issuer would happily publish).
      const attacker = 'http://127.0.0.1:1'; // nothing listens here
      const { token } = await createTestJwt({ iss: attacker }, { foreignKey: true });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expectExit1();
      setJsonMode(true);

      const cmd = verifyCommand();
      cmd.exitOverride();
      await expect(cmd.parseAsync(['node', 'test', token, '--json'])).rejects.toThrow('process.exit');

      expect(firstJsonOutput().status).toBe('invalid_signature');
      for (const call of fetchSpy.mock.calls) {
        expect(String(call[0])).not.toContain(attacker);
      }
      expect(jwksRequests).toBe(1);
    });

    it('rejects a token from the trusted key whose iss does not match the trusted issuer', async () => {
      const { token } = await createTestJwt({ iss: 'https://evil.example.com' });
      expectExit1();
      setJsonMode(true);

      const cmd = verifyCommand();
      cmd.exitOverride();
      await expect(cmd.parseAsync(['node', 'test', token, '--json'])).rejects.toThrow('process.exit');

      const parsed = firstJsonOutput();
      expect(parsed.status).toBe('invalid_signature');
      expect(String(parsed.error)).toMatch(/iss/);
    });

    it('does not report valid when no JWKS is reachable', async () => {
      process.env['GRANTEX_URL'] = 'http://127.0.0.1:1';
      const { token } = await createTestJwt();
      expectExit1();
      setJsonMode(true);

      const cmd = verifyCommand();
      cmd.exitOverride();
      await expect(cmd.parseAsync(['node', 'test', token, '--json'])).rejects.toThrow('process.exit');

      expect(firstJsonOutput().status).toBe('invalid_signature');
    });

    it('--jwks-file verifies offline against the given key set', async () => {
      const { token } = await createTestJwt();
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const jwk = await jose.exportJWK(issuerKeys.publicKey);
      jwk.kid = 'test-key-1';
      const tmpFile = path.join(os.tmpdir(), `grantex-jwks-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify({ keys: [jwk] }));

      try {
        setJsonMode(true);
        const cmd = verifyCommand();
        cmd.exitOverride();
        await cmd.parseAsync(['node', 'test', token, '--jwks-file', tmpFile, '--json']);
        const parsed = firstJsonOutput();
        expect(parsed.status).toBe('valid');
        expect(parsed.mode).toBe('offline');
        expect(jwksRequests).toBe(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
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

  it('reads token from --env', async () => {
    const { token } = await createTestJwt();
    process.env['GRANTEX_TEST_TOKEN'] = token;

    try {
      setJsonMode(true);
      const cmd = verifyCommand();
      cmd.exitOverride();
      await cmd.parseAsync(['node', 'test', '--env', 'GRANTEX_TEST_TOKEN', '--json']);

      const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const parsed = JSON.parse(output);
      expect(parsed.grantId).toBe('grnt_01HXYZ');
    } finally {
      delete process.env['GRANTEX_TEST_TOKEN'];
    }
  });
});

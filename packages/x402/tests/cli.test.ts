import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from '../src/crypto.js';
import { issueGDT } from '../src/gdt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = join(__dirname, '..');

function run(args: string, env?: Record<string, string>): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('npx', ['tsx', 'src/cli.ts', ...args.split(/\s+/).filter(Boolean)], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 30000,
      shell: true,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

describe('CLI', () => {
  describe('help', () => {
    it('shows usage with --help', () => {
      const { stdout, exitCode } = run('--help');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('grantex-x402');
      expect(stdout).toContain('Commands:');
    });

    it('shows usage with help command', () => {
      const { stdout, exitCode } = run('help');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('keygen');
    });

    it('shows usage with -h', () => {
      const { stdout, exitCode } = run('-h');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('grantex-x402');
    });
  });

  describe('unknown command', () => {
    it('exits with error for unknown command', () => {
      const { exitCode } = run('nonsense');
      expect(exitCode).toBe(1);
    });
  });

  describe('keygen', () => {
    it('generates a key pair as JSON', () => {
      const { stdout, exitCode } = run('keygen');
      expect(exitCode).toBe(0);

      const keys = JSON.parse(stdout);
      expect(keys.did).toMatch(/^did:key:z6Mk/);
      expect(keys.publicKey).toHaveLength(64); // 32 bytes hex
      expect(keys.privateKey).toHaveLength(64);
    });

    it('writes to file with --out flag', () => {
      const outFile = join(cwd, '__test_keys.json');
      try {
        const { exitCode, stdout } = run(`keygen --out ${outFile}`);
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Key pair written');
        expect(existsSync(outFile)).toBe(true);

        const keys = JSON.parse(readFileSync(outFile, 'utf8'));
        expect(keys.did).toMatch(/^did:key:z6Mk/);
      } finally {
        if (existsSync(outFile)) unlinkSync(outFile);
      }
    });
  });

  describe('issue', () => {
    let keyFile: string;
    let principal: ReturnType<typeof generateKeyPair>;
    let agent: ReturnType<typeof generateKeyPair>;

    beforeEach(() => {
      principal = generateKeyPair();
      agent = generateKeyPair();
      keyFile = join(cwd, '__test_principal.key');
      writeFileSync(keyFile, Buffer.from(principal.privateKey).toString('hex'));
    });

    afterEach(() => {
      if (existsSync(keyFile)) unlinkSync(keyFile);
    });

    it('issues a GDT with all required flags', () => {
      const { stdout, exitCode } = run(
        `issue --agent ${agent.did} --scope weather:read --limit 10 --expiry 24h --key ${keyFile}`,
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim().split('.')).toHaveLength(3); // JWT format
    });

    it('issues with multiple scopes', () => {
      const { stdout, exitCode } = run(
        `issue --agent ${agent.did} --scope weather:read,news:read --limit 10 --expiry 24h --key ${keyFile}`,
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim().split('.')).toHaveLength(3);
    });

    it('reads key from GRANTEX_PRIVATE_KEY env var', () => {
      const { stdout, exitCode } = run(
        `issue --agent ${agent.did} --scope weather:read --limit 10 --expiry 24h`,
        { GRANTEX_PRIVATE_KEY: Buffer.from(principal.privateKey).toString('hex') },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim().split('.')).toHaveLength(3);
    });

    it('fails when missing --agent', () => {
      const { exitCode } = run(`issue --scope weather:read --limit 10 --expiry 24h --key ${keyFile}`);
      expect(exitCode).toBe(1);
    });

    it('fails when missing --scope', () => {
      const { exitCode } = run(`issue --agent ${agent.did} --limit 10 --expiry 24h --key ${keyFile}`);
      expect(exitCode).toBe(1);
    });

    it('fails when missing --limit', () => {
      const { exitCode } = run(`issue --agent ${agent.did} --scope weather:read --expiry 24h --key ${keyFile}`);
      expect(exitCode).toBe(1);
    });

    it('fails when missing --expiry', () => {
      const { exitCode } = run(`issue --agent ${agent.did} --scope weather:read --limit 10 --key ${keyFile}`);
      expect(exitCode).toBe(1);
    });

    it('fails when no key provided', () => {
      const { exitCode } = run(`issue --agent ${agent.did} --scope weather:read --limit 10 --expiry 24h`);
      expect(exitCode).toBe(1);
    });
  });

  describe('verify', () => {
    let token: string;

    beforeEach(async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();
      token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });
    });

    it('verifies a valid token', () => {
      const { stdout, exitCode } = run(`verify ${token} --resource weather:read --amount 0.001`);
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.valid).toBe(true);
    });

    it('fails with scope mismatch', () => {
      const { exitCode } = run(`verify ${token} --resource finance:read --amount 0.001`);
      expect(exitCode).toBe(1);
    });

    it('fails when missing --resource', () => {
      const { exitCode } = run(`verify ${token} --amount 0.001`);
      expect(exitCode).toBe(1);
    });

    it('fails when missing --amount', () => {
      const { exitCode } = run(`verify ${token} --resource weather:read`);
      expect(exitCode).toBe(1);
    });

    it('fails with invalid token', () => {
      const { exitCode } = run('verify not.a.jwt --resource weather:read --amount 0.001');
      expect(exitCode).toBe(1);
    });
  });

  describe('decode / inspect', () => {
    let token: string;

    beforeEach(async () => {
      const principal = generateKeyPair();
      const agent = generateKeyPair();
      token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: principal.privateKey,
      });
    });

    it('decodes a valid token', () => {
      const { stdout, exitCode } = run(`decode ${token}`);
      expect(exitCode).toBe(0);
      const decoded = JSON.parse(stdout);
      expect(decoded.vc).toBeDefined();
      expect(decoded.iss).toMatch(/^did:key:z6Mk/);
    });

    it('inspect is an alias for decode', () => {
      const { stdout, exitCode } = run(`inspect ${token}`);
      expect(exitCode).toBe(0);
      const decoded = JSON.parse(stdout);
      expect(decoded.vc).toBeDefined();
    });

    it('fails on missing token argument', () => {
      const { exitCode } = run('decode');
      expect(exitCode).toBe(1);
    });

    it('fails on invalid token', () => {
      const { exitCode } = run('decode garbage');
      expect(exitCode).toBe(1);
    });
  });
});


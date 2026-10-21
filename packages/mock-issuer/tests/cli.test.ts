// SPDX-License-Identifier: Apache-2.0
//
// The CLI, and the command sequences in docs/issuers/running-the-mock-issuer.md
// run as written (with the state directory moved to a temporary one).

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MockIssuer } from '../src/index.ts';
import { tempDir } from './helpers.ts';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(PACKAGE, '../../docs/issuers/running-the-mock-issuer.md');
const CLI = join(PACKAGE, 'src/cli.ts');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function scratch(): string {
  const dir = tempDir();
  cleanups.push(dir.remove);
  return dir.path;
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: PACKAGE,
    encoding: 'utf8',
    env: { ...process.env, MOCK_ISSUER_DIR: '', ...env },
  });
}

/** The fenced block after the MDX comment "example: <name>" in the docs page. */
function docExample(name: string): string {
  const text = readFileSync(DOC, 'utf8').replaceAll('\r\n', '\n');
  const match = text.match(new RegExp(`\\{/\\* example: ${name} \\*/\\}\\s*\`\`\`bash\\n([\\s\\S]*?)\`\`\``));
  if (!match) throw new Error(`no example ${name} in ${DOC}`);
  return match[1] as string;
}

function withScratchDir(script: string, dir: string): string {
  const exportLine = /^export MOCK_ISSUER_DIR=\.mock-issuer.*$/m;
  expect(script).toMatch(exportLine);
  return script.replace(exportLine, `export MOCK_ISSUER_DIR='${dir.replaceAll('\\', '/')}'`);
}

describe('CLI', () => {
  it('prints the public JWKS and never the private key', () => {
    const dir = scratch();
    const result = run(['keys', '--dir', dir]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { entity_id: string; status_list_base: string; jwks: { keys: object[] } };
    expect(out.entity_id).toBe('https://mock-issuer.example');
    expect(out.status_list_base).toBe('https://mock-issuer.example/status/');
    expect(out.jwks.keys[0]).not.toHaveProperty('d');
    const stored = JSON.parse(readFileSync(join(dir, 'issuer-key.json'), 'utf8')) as { d: string };
    expect(result.stdout).not.toContain(stored.d);
    expect(result.stderr).not.toContain(stored.d);
  });

  it('needs a state directory', () => {
    const result = run(['keys']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--dir/);
  });

  it('refuses an unknown command', () => {
    const result = run(['mint-money']);
    expect(result.status).toBe(2);
  });

  it('fails closed with the refusal code', () => {
    const dir = scratch();
    const result = run(['revoke', '--dir', dir, '--attestation-id', 'att_01J00000000000000000000000']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/attestation_not_registered/);
  });
});

describe('docs/issuers/running-the-mock-issuer.md', () => {
  it('runs the issue, attest, suspend, reinstate and revoke sequence', () => {
    const dir = scratch();
    const script = withScratchDir(docExample('mock-issuer-cli'), dir);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', script], {
      cwd: PACKAGE,
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: '' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const issuer = MockIssuer.create({ dir });
    const passport = JSON.parse(readFileSync(join(dir, 'passport.json'), 'utf8')) as { attestation_id: string };
    expect(issuer.passportStatus(passport.attestation_id)).toBe('invalid');
    // The attestation printed by `attest` is a compact JWS.
    expect(readFileSync(join(dir, 'attestation.jws'), 'utf8').trim()).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('serves the JWKS and prints the origin map entry', async () => {
    const dir = scratch();
    expect(run(['keys', '--dir', dir]).status).toBe(0);
    const line = docExample('mock-issuer-serve').trim();
    expect(line.startsWith('node src/cli.ts serve')).toBe(true);
    const args = line.replace(/^node src\/cli\.ts /, '').split(/\s+/);
    // The documented port stays in 56900-56999; the test asks for an ephemeral one.
    const portAt = args.indexOf('--port');
    expect(Number(args[portAt + 1])).toBeGreaterThanOrEqual(56900);
    args[portAt + 1] = '0';
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: PACKAGE,
      env: { ...process.env, MOCK_ISSUER_DIR: dir },
    });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        let buffered = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          if (buffered.includes('\n')) resolve(buffered.slice(0, buffered.indexOf('\n')));
        });
        child.on('exit', (code) => reject(new Error(`serve exited with ${code}`)));
      });
      const started = JSON.parse(first) as { origin: string; origin_map: string };
      expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(started.origin_map).toBe(`https://mock-issuer.example=${started.origin}`);
      const response = await fetch(`${started.origin}/.well-known/jwks.json`);
      expect(response.headers.get('content-type')).toBe('application/jwk-set+json');
    } finally {
      child.kill();
    }
  });
});

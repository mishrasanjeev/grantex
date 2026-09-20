import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { evidenceCommand, EXIT_FAILED, EXIT_USAGE } from '../src/commands/evidence.js';
import { setJsonMode } from '../src/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = join(here, '..', '..', '..', 'spec', 'examples', 'evidence');
const expected = JSON.parse(readFileSync(join(EXAMPLES, 'expected.json'), 'utf8')) as Record<string, { root: string; anchor_hash?: string }>;
const ROOT = expected['evidence-package.json']!.root;
const ANCHOR = expected['evidence-package.json']!.anchor_hash!;
const PACKAGE = join(EXAMPLES, 'evidence-package.json');
const dir = mkdtempSync(join(tmpdir(), 'grantex-evidence-cli-'));

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let logs: string[] = [];
let errors: string[] = [];

async function run(...args: string[]): Promise<number> {
  const cmd = evidenceCommand();
  cmd.exitOverride();
  try {
    await cmd.parseAsync(args, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof Exit) return err.code;
    if (err && typeof err === 'object' && 'exitCode' in err) return EXIT_USAGE;
    throw err;
  }
}

// The evidence module is imported lazily by the command; load it once up front so
// the first test does not pay the import under a parallel test run.
beforeAll(async () => {
  await import('@grantex/sdk');
}, 60_000);

beforeEach(() => {
  logs = [];
  errors = [];
  setJsonMode(false);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
});

const corrupt = (): string => {
  const data = readFileSync(PACKAGE);
  data[data.indexOf('61250') + 1] = '2'.charCodeAt(0);
  const file = join(dir, `corrupt-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, data);
  return file;
};

describe('grantex evidence verify', () => {
  it('exits 0 for a valid package', async () => {
    expect(await run('verify', PACKAGE, '--root', ROOT, '--anchor', ANCHOR)).toBe(0);
    expect(logs[0]).toContain('18 entries');
    expect(logs).toContain('  anchor:    pinned to the --anchor hash you supplied');
    logs = [];
    expect(await run('verify', PACKAGE, '--root', ROOT)).toBe(0);
    expect(logs.some((l) => l.startsWith('  anchor:    internal-consistency-only'))).toBe(true);
    expect(logs).toContain('  unsourced policy inputs: 1');
  });

  it('reports a verified service signature as the trust basis', async () => {
    expect(await run('verify', join(EXAMPLES, 'evidence-package-signed.json'), '--root', ROOT, '--jwks', join(EXAMPLES, 'jwks.json'))).toBe(0);
    expect(logs).toContain('  signature: verified (kid evidence-example-es256)');
    expect(logs).toContain('  anchor:    covered by the verified service signature');
  });

  it('e2e step 8: corrupting one byte fails and prints the failing link', async () => {
    expect(await run('verify', PACKAGE, '--root', ROOT)).toBe(0);
    expect(await run('verify', corrupt(), '--root', ROOT)).toBe(EXIT_FAILED);
    expect(errors[0]).toContain('entry_hash_mismatch: entry 13 content does not match its hash');
    expect(errors).toContain('  entry:    13');
    expect(errors).toContain('  field:    entries[13].hash');
    expect(errors.some((l) => l.startsWith('  expected: sha256:'))).toBe(true);
  });

  it('prints the same JSON result as the Python CLI', async () => {
    setJsonMode(true);
    expect(await run('verify', PACKAGE, '--root', `sha256:${'0'.repeat(64)}`)).toBe(EXIT_FAILED);
    const body = JSON.parse(logs.join('\n')) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, code: 'root_not_trusted', field_path: 'chain.root', entry_index: null });
  });

  it('treats a missing or malformed root and a negative size limit as usage errors (exit 2, as the Python CLI)', async () => {
    expect(await run('verify', PACKAGE)).toBe(EXIT_USAGE);
    expect(await run('verify', PACKAGE, '--root', 'not-a-root')).toBe(EXIT_USAGE);
    expect(errors.join('\n')).toContain('--root must be');
    expect(await run('verify', PACKAGE, '--root', ROOT, '--max-bytes', '-1')).toBe(EXIT_USAGE);
  });

  it('starts and explains the requirement when the installed SDK has no evidence module', async () => {
    const older = async (): Promise<Record<string, unknown>> => ({ Grantex: class {} });
    const cmd = evidenceCommand(older);
    cmd.exitOverride();
    let code = 0;
    try {
      await cmd.parseAsync(['verify', PACKAGE, '--root', ROOT], { from: 'user' });
    } catch (err) {
      code = err instanceof Exit ? err.code : -1;
    }
    expect(code).toBe(EXIT_USAGE);
    expect(errors.join('\n')).toContain('requires @grantex/sdk >= 0.7.0');
  });

  it('needs keys or an explicit skip for a signed package', async () => {
    const signed = join(EXAMPLES, 'evidence-package-signed.json');
    expect(await run('verify', signed, '--root', ROOT)).toBe(EXIT_FAILED);
    expect(errors.join('\n')).toContain('signature_unverified');
    expect(await run('verify', signed, '--root', ROOT, '--jwks', join(EXAMPLES, 'jwks.json'), '--require-signature')).toBe(0);
    expect(await run('verify', signed, '--root', ROOT, '--skip-signature')).toBe(0);
    expect(await run('verify', signed, '--root', ROOT, '--skip-signature', '--jwks', join(EXAMPLES, 'jwks.json'))).toBe(EXIT_USAGE);
  });

  it('exits 2 on unreadable input', async () => {
    expect(await run('verify', join(dir, 'missing.json'), '--root', ROOT)).toBe(EXIT_USAGE);
    const bad = join(dir, 'bad-jwks.json');
    writeFileSync(bad, '[]');
    expect(await run('verify', join(EXAMPLES, 'evidence-package-signed.json'), '--root', ROOT, '--jwks', bad)).toBe(EXIT_USAGE);
  });
});

describe('grantex evidence export', () => {
  let server: Server;
  let baseUrl: string;
  let respond: (url: string, body: string) => { status: number; headers?: Record<string, string>; body: Buffer | string };
  let lastRequest: { url: string; body: string; auth: string | undefined } | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', () => {
        lastRequest = { url: req.url ?? '', body, auth: req.headers['authorization'] };
        const reply = respond(req.url ?? '', body);
        res.writeHead(reply.status, reply.headers ?? {});
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    vi.stubEnv('GRANTEX_URL', baseUrl);
    vi.stubEnv('GRANTEX_KEY', 'placeholder-api-key');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes a package that verifies against the anchored root', async () => {
    respond = () => ({ status: 200, headers: { 'Grantex-Evidence-Root': ROOT, 'Grantex-Evidence-Anchor': ANCHOR }, body: readFileSync(PACKAGE) });
    const out = join(dir, 'exported.json');
    expect(await run('export', 'case_demo_0001', '--out', out, '--disclose', 'approver')).toBe(0);
    expect(readFileSync(out).equals(readFileSync(PACKAGE))).toBe(true);
    expect(lastRequest?.url).toBe('/v1/evidence/cases/case_demo_0001/export');
    expect(lastRequest?.auth).toBe('Bearer placeholder-api-key');
    expect(JSON.parse(lastRequest!.body)).toEqual({ disclose: ['approver'], sign: false });
    expect(logs.join('\n')).toContain(`--root ${ROOT}`);
  });

  it('refuses to save a package that does not match its root', async () => {
    const tampered = readFileSync(corrupt());
    respond = () => ({ status: 200, headers: { 'Grantex-Evidence-Root': ROOT, 'Grantex-Evidence-Anchor': ANCHOR }, body: tampered });
    const out = join(dir, 'tampered.json');
    expect(await run('export', 'case_demo_0001', '--out', out)).toBe(EXIT_FAILED);
    expect(existsSync(out)).toBe(false);
    expect(errors.join('\n')).toContain('entry_hash_mismatch');
  });

  it('reports service errors and bad headers', async () => {
    respond = () => ({ status: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'FEATURE_DISABLED', message: 'evidence export is not enabled' }) });
    expect(await run('export', 'case_demo_0001', '--out', join(dir, 'x.json'))).toBe(EXIT_FAILED);
    expect(errors.join('\n')).toContain('403 FEATURE_DISABLED');
    respond = () => ({ status: 200, body: '{}' });
    expect(await run('export', 'case_demo_0001', '--out', join(dir, 'x.json'))).toBe(EXIT_FAILED);
    expect(errors.join('\n')).toContain('EVIDENCE_ROOT_HEADER_INVALID');
  });

  it('does not derive a file name from an unsafe case id', async () => {
    respond = () => ({ status: 200, headers: { 'Grantex-Evidence-Root': ROOT, 'Grantex-Evidence-Anchor': ANCHOR }, body: readFileSync(PACKAGE) });
    expect(await run('export', '../case_demo_0001')).toBe(EXIT_USAGE);
    expect(errors.join('\n')).toContain('pass --out');
  });

  it('does not send a saved API key to an override URL', async () => {
    vi.stubEnv('GRANTEX_KEY', '');
    expect(await run('export', 'case_demo_0001', '--url', baseUrl, '--out', join(dir, 'no-leak.json'))).toBe(EXIT_USAGE);
    expect(errors.join('\n')).toContain('evidence export requires GRANTEX_KEY');
  });
});

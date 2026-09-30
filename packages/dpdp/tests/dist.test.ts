/**
 * Runs the BUILT package (dist/index.js) in a plain Node ESM process.
 *
 * Unit tests import `src/` through the test runner, which supplies CommonJS
 * globals such as `require`. The published package is ESM and has none, so a
 * `require(...)` in `src/` passes every unit test and then throws a
 * ReferenceError for users. This file builds the package first (a failing build
 * fails the test) and then exercises the code paths in a child `node` process,
 * where only real ESM semantics apply.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = pathToFileURL(resolve(pkgDir, 'dist', 'index.js')).href;

/** Run `script` as an .mjs file (an ES module, exactly as a package consumer's code would be). */
function runInNode(script: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dpdp-dist-'));
  try {
    const file = join(dir, 'run.mjs');
    writeFileSync(file, script, 'utf8');
    const result = spawnSync(process.execPath, [file], { cwd: pkgDir, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('built package (dist) in plain Node ESM', () => {
  beforeAll(() => {
    // Build with the package's own TypeScript; throws (and fails the suite) if the build fails.
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: pkgDir, stdio: 'pipe' });
  }, 120_000);

  it('createConsentRecord with proofIpAddress works in the built ESM package', () => {
    const rawIp = '192.0.2.10';
    const script = `
      const dpdp = await import(${JSON.stringify(distEntry)});
      const sent = [];
      globalThis.fetch = async (url, init) => {
        sent.push({ url, init });
        return new Response(JSON.stringify({
          recordId: 'crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W',
          grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
          dataPrincipalId: 'user_123',
          consentNoticeId: 'privacy-notice',
          consentNoticeVersion: '2.0',
          consentNoticeHash: 'aa',
          consentProof: { type: 'JWS-EdDSA', alg: 'EdDSA', kid: null, proofJwt: 'a.b.c',
            jwksUri: 'https://api.example.com/.well-known/jwks.json', signedAt: '2026-09-30T10:15:00.000Z' },
          processingExpiresAt: '2027-09-30T00:00:00.000Z',
          retentionUntil: '2027-10-30T00:00:00.000Z',
          status: 'active',
          createdAt: '2026-09-30T10:15:00.000Z',
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      };
      const record = await dpdp.createConsentRecord({
        grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
        dataPrincipalId: 'user_123',
        dataFiduciaryId: 'fid_1',
        dataFiduciaryName: 'Acme Health',
        purposes: [{ purposeId: 'analytics', name: 'Analytics', description: 'Usage analytics',
          legalBasis: 'consent', dataCategories: ['usage'], retentionPeriod: '1 year', thirdPartySharing: false }],
        scopes: ['read:profile'],
        consentNoticeId: 'privacy-notice',
        consentNoticeContent: 'Notice text',
        consentMethod: 'explicit-click',
        processingExpiresAt: new Date('2027-09-30T00:00:00.000Z'),
        retentionUntil: new Date('2027-10-30T00:00:00.000Z'),
        proofIpAddress: ${JSON.stringify(rawIp)},
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com',
      });
      process.stdout.write(JSON.stringify({ record, body: sent[0].init.body }));
    `;

    const { status, stdout, stderr } = runInNode(script);
    expect(stderr).toBe('');
    expect(status).toBe(0);

    const { record, body } = JSON.parse(stdout) as {
      record: { recordId: string; localEvidence?: { ipAddressHash?: string } };
      body: string;
    };
    expect(record.recordId).toBe('crec_01J9ZB4Y7Q2M8N3P5R6S7T8V9W');
    const expectedHash = createHash('sha256').update(rawIp).digest('hex');
    expect(record.localEvidence?.ipAddressHash).toBe(expectedHash);
    // The raw IP never leaves the process.
    expect(body).not.toContain(rawIp);
  });

  it('exports every public function from the built package', () => {
    const script = `
      const dpdp = await import(${JSON.stringify(distEntry)});
      const names = Object.keys(dpdp).filter((k) => typeof dpdp[k] === 'function').sort();
      process.stdout.write(JSON.stringify(names));
    `;
    const { status, stdout, stderr } = runInNode(script);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const names = JSON.parse(stdout) as string[];
    for (const fn of [
      'createConsentRecord', 'getConsentRecord', 'listConsentRecords',
      'createConsentNotice', 'listConsentNotices', 'getConsentNotice',
      'withdrawConsent', 'getDataPrincipalRecords', 'requestDataErasure', 'getErasureRequest',
      'fileGrievance', 'getGrievanceStatus', 'listGrievances', 'updateGrievance',
      'requestDpdpExport', 'requestGdprExport', 'requestEuAiActExport', 'getExportStatus',
    ]) {
      expect(names).toContain(fn);
    }
  });
});

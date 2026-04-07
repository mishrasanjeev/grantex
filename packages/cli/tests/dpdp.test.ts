import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../src/config.js', () => ({
  defaultConfigPath: vi.fn().mockReturnValue('/home/user/.grantex/config.json'),
  loadConfig: vi.fn(),
  resolveConfig: vi.fn(),
}));
vi.mock('../src/format.js', async () => {
  const actual = await vi.importActual<typeof import('../src/format.js')>('../src/format.js');
  return { ...actual };
});

import { loadConfig, resolveConfig } from '../src/config.js';
import { dpdpCommand } from '../src/commands/dpdp.js';
import { setJsonMode } from '../src/format.js';

// ── Sample data ───────────────────────────────────────────────────────────

const sampleConsentRecord = {
  recordId: 'cr_1',
  grantId: 'grnt_1',
  dataPrincipalId: 'user@test.com',
  dataFiduciaryName: 'Test Corp',
  purposes: [{ code: 'marketing', description: 'Marketing communications' }],
  scopes: ['email:read'],
  consentNoticeId: 'notice_v1',
  consentNoticeHash: 'abc123hash',
  consentProof: { type: 'Ed25519Signature2020' },
  status: 'active',
  processingExpiresAt: '2027-01-01T00:00:00Z',
  retentionUntil: '2027-01-31T00:00:00Z',
  accessCount: 1,
  withdrawnAt: null,
  withdrawnReason: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const sampleWithdrawResponse = {
  recordId: 'cr_1',
  status: 'withdrawn',
  withdrawnAt: '2026-06-01T00:00:00Z',
  grantRevoked: false,
  dataDeleted: false,
};

const sampleNotice = {
  id: 'ntc_1',
  noticeId: 'privacy-notice',
  version: '1.0',
  language: 'en',
  contentHash: 'sha256hash',
  createdAt: '2026-01-01T00:00:00Z',
};

const sampleGrievance = {
  grievanceId: 'grv_1',
  referenceNumber: 'GRV-2026-00001',
  type: 'data-misuse',
  status: 'submitted',
  dataPrincipalId: 'user@test.com',
  description: 'My data was misused',
  evidence: {},
  recordId: null,
  expectedResolutionBy: '2026-01-08T00:00:00Z',
  resolvedAt: null,
  resolution: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const sampleErasure = {
  requestId: 'ER-2026-00001',
  dataPrincipalId: 'user@test.com',
  status: 'completed',
  recordsErased: 3,
  grantsRevoked: 2,
  submittedAt: '2026-01-01T00:00:00Z',
  expectedCompletionBy: '2026-01-08T00:00:00Z',
};

const sampleExport = {
  exportId: 'exp_1',
  type: 'dpdp-audit',
  format: 'json',
  recordCount: 5,
  data: { exportType: 'dpdp-audit' },
  status: 'completed',
  expiresAt: '2026-01-08T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

const samplePrincipalRecords = {
  dataPrincipalId: 'user@test.com',
  records: [sampleConsentRecord],
  totalRecords: 1,
};

// ── Helpers ───────────────────────────────────────────────────────────────

function makeProg() {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(dpdpCommand());
  return prog;
}

function mockFetchOk(data: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status,
      json: () => Promise.resolve(data),
    }),
  );
}

function mockFetchError(status: number, message: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve({ message }),
    }),
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({
    baseUrl: 'http://localhost:3001',
    apiKey: 'gx_test_key',
  });
  vi.mocked(resolveConfig).mockReturnValue({
    baseUrl: 'http://localhost:3001',
    apiKey: 'gx_test_key',
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('dpdp command', () => {
  describe('structure', () => {
    it('registers the "dpdp" command', () => {
      const cmd = dpdpCommand();
      expect(cmd.name()).toBe('dpdp');
    });

    it('has consent, notices, grievances, erasure, exports, and principal-records subcommands', () => {
      const cmd = dpdpCommand();
      const names = cmd.commands.map((c) => c.name());
      expect(names).toContain('consent');
      expect(names).toContain('notices');
      expect(names).toContain('grievances');
      expect(names).toContain('erasure');
      expect(names).toContain('exports');
      expect(names).toContain('principal-records');
    });

    it('consent has create, get, list, and withdraw subcommands', () => {
      const cmd = dpdpCommand();
      const consent = cmd.commands.find((c) => c.name() === 'consent')!;
      const names = consent.commands.map((c) => c.name());
      expect(names).toContain('create');
      expect(names).toContain('get');
      expect(names).toContain('list');
      expect(names).toContain('withdraw');
    });

    it('notices has create subcommand', () => {
      const cmd = dpdpCommand();
      const notices = cmd.commands.find((c) => c.name() === 'notices')!;
      const names = notices.commands.map((c) => c.name());
      expect(names).toContain('create');
    });

    it('grievances has file and get subcommands', () => {
      const cmd = dpdpCommand();
      const grievances = cmd.commands.find((c) => c.name() === 'grievances')!;
      const names = grievances.commands.map((c) => c.name());
      expect(names).toContain('file');
      expect(names).toContain('get');
    });

    it('exports has create and get subcommands', () => {
      const cmd = dpdpCommand();
      const exports = cmd.commands.find((c) => c.name() === 'exports')!;
      const names = exports.commands.map((c) => c.name());
      expect(names).toContain('create');
      expect(names).toContain('get');
    });
  });

  // ── consent create ────────────────────────────────────────────────────

  describe('consent create', () => {
    it('creates a consent record and prints confirmation', async () => {
      mockFetchOk(sampleConsentRecord);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'consent', 'create',
          '--grant-id', 'grnt_1',
          '--principal-id', 'user@test.com',
          '--notice-id', 'notice_v1',
          '--processing-expires-at', '2027-01-01T00:00:00Z',
          '--purposes', '[{"code":"marketing","description":"Marketing communications"}]',
        ],
        { from: 'user' },
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-records',
        expect.objectContaining({ method: 'POST' }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Consent record created');
      expect(output).toContain('cr_1');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleConsentRecord);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'consent', 'create',
          '--grant-id', 'grnt_1',
          '--principal-id', 'user@test.com',
          '--notice-id', 'notice_v1',
          '--processing-expires-at', '2027-01-01T00:00:00Z',
          '--purposes', '[{"code":"marketing","description":"Marketing communications"}]',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.recordId).toBe('cr_1');
      expect(parsed.grantId).toBe('grnt_1');
    });

    it('exits with error for invalid --purposes JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'dpdp', 'consent', 'create',
            '--grant-id', 'grnt_1',
            '--principal-id', 'user@test.com',
            '--notice-id', 'notice_v1',
            '--processing-expires-at', '2027-01-01T00:00:00Z',
            '--purposes', 'not-json',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --purposes must be valid JSON.');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  // ── consent get ───────────────────────────────────────────────────────

  describe('consent get', () => {
    it('fetches and prints consent record details', async () => {
      mockFetchOk(sampleConsentRecord);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'get', 'cr_1'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-records/cr_1',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer gx_test_key' }),
        }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cr_1');
      expect(output).toContain('grnt_1');
      expect(output).toContain('active');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleConsentRecord);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'get', 'cr_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.recordId).toBe('cr_1');
      expect(parsed.status).toBe('active');
    });

    it('shows dash for null withdrawnAt', async () => {
      mockFetchOk(sampleConsentRecord);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'get', 'cr_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toMatch(/\u2014/);
    });
  });

  // ── consent list ──────────────────────────────────────────────────────

  describe('consent list', () => {
    it('prints a table of consent records', async () => {
      mockFetchOk({ records: [sampleConsentRecord], totalRecords: 1 });

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'list'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-records',
        expect.any(Object),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('cr_1');
      expect(output).toContain('grnt_1');
      expect(output).toContain('user@test.com');
      expect(output).toContain('active');
    });

    it('passes --principal filter as query parameter', async () => {
      mockFetchOk({ records: [], totalRecords: 0 });

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'list', '--principal', 'user@test.com'], {
        from: 'user',
      });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-records?dataPrincipalId=user%40test.com',
        expect.any(Object),
      );
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk({ records: [sampleConsentRecord], totalRecords: 1 });

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'consent', 'list'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0].recordId).toBe('cr_1');
    });
  });

  // ── consent withdraw ──────────────────────────────────────────────────

  describe('consent withdraw', () => {
    it('withdraws consent and prints confirmation', async () => {
      mockFetchOk(sampleWithdrawResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['dpdp', 'consent', 'withdraw', 'cr_1', '--reason', 'No longer needed'],
        { from: 'user' },
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-records/cr_1/withdraw',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.reason).toBe('No longer needed');

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Consent withdrawn');
      expect(output).toContain('cr_1');
    });

    it('passes --revoke-grant and --delete-data flags', async () => {
      mockFetchOk({ ...sampleWithdrawResponse, grantRevoked: true, dataDeleted: true });

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'consent', 'withdraw', 'cr_1',
          '--reason', 'Full withdrawal',
          '--revoke-grant',
          '--delete-data',
        ],
        { from: 'user' },
      );

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.revokeGrant).toBe(true);
      expect(body.deleteProcessedData).toBe(true);
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleWithdrawResponse);

      const prog = makeProg();
      await prog.parseAsync(
        ['dpdp', 'consent', 'withdraw', 'cr_1', '--reason', 'Test'],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.recordId).toBe('cr_1');
      expect(parsed.status).toBe('withdrawn');
    });
  });

  // ── notices create ────────────────────────────────────────────────────

  describe('notices create', () => {
    it('creates a notice and prints confirmation', async () => {
      mockFetchOk(sampleNotice);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'notices', 'create',
          '--notice-id', 'privacy-notice',
          '--version', '1.0',
          '--title', 'Privacy Notice',
          '--content', 'We collect data for marketing.',
          '--purposes', '[{"code":"marketing","description":"Marketing"}]',
        ],
        { from: 'user' },
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/consent-notices',
        expect.objectContaining({ method: 'POST' }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Consent notice created');
      expect(output).toContain('ntc_1');
    });

    it('passes optional parameters', async () => {
      mockFetchOk(sampleNotice);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'notices', 'create',
          '--notice-id', 'privacy-notice',
          '--version', '1.0',
          '--title', 'Privacy Notice',
          '--content', 'We collect data.',
          '--purposes', '[{"code":"marketing","description":"Marketing"}]',
          '--language', 'hi',
          '--fiduciary-contact', 'privacy@example.com',
          '--grievance-officer', '{"name":"Officer","email":"grv@example.com"}',
        ],
        { from: 'user' },
      );

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.language).toBe('hi');
      expect(body.dataFiduciaryContact).toBe('privacy@example.com');
      expect(body.grievanceOfficer).toEqual({ name: 'Officer', email: 'grv@example.com' });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleNotice);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'notices', 'create',
          '--notice-id', 'privacy-notice',
          '--version', '1.0',
          '--title', 'Privacy Notice',
          '--content', 'Content here.',
          '--purposes', '[{"code":"marketing","description":"Marketing"}]',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe('ntc_1');
      expect(parsed.noticeId).toBe('privacy-notice');
    });

    it('exits with error for invalid --purposes JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'dpdp', 'notices', 'create',
            '--notice-id', 'pn',
            '--version', '1.0',
            '--title', 'T',
            '--content', 'C',
            '--purposes', 'bad',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --purposes must be valid JSON.');
      exitSpy.mockRestore();
    });

    it('exits with error for invalid --grievance-officer JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'dpdp', 'notices', 'create',
            '--notice-id', 'pn',
            '--version', '1.0',
            '--title', 'T',
            '--content', 'C',
            '--purposes', '[{"code":"x","description":"y"}]',
            '--grievance-officer', 'not-json',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --grievance-officer must be valid JSON.');
      exitSpy.mockRestore();
    });
  });

  // ── grievances file ───────────────────────────────────────────────────

  describe('grievances file', () => {
    it('files a grievance and prints confirmation', async () => {
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'grievances', 'file',
          '--principal-id', 'user@test.com',
          '--type', 'data-misuse',
          '--description', 'My data was misused',
        ],
        { from: 'user' },
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/grievances',
        expect.objectContaining({ method: 'POST' }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Grievance filed');
      expect(output).toContain('grv_1');
      expect(output).toContain('GRV-2026-00001');
    });

    it('passes --record-id and --evidence', async () => {
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'grievances', 'file',
          '--principal-id', 'user@test.com',
          '--type', 'data-misuse',
          '--description', 'Misuse',
          '--record-id', 'cr_1',
          '--evidence', '{"screenshot":"url"}',
        ],
        { from: 'user' },
      );

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.recordId).toBe('cr_1');
      expect(body.evidence).toEqual({ screenshot: 'url' });
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'grievances', 'file',
          '--principal-id', 'user@test.com',
          '--type', 'data-misuse',
          '--description', 'Misuse',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.grievanceId).toBe('grv_1');
      expect(parsed.status).toBe('submitted');
    });

    it('exits with error for invalid --evidence JSON', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'dpdp', 'grievances', 'file',
            '--principal-id', 'user@test.com',
            '--type', 'data-misuse',
            '--description', 'test',
            '--evidence', 'bad-json',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalledWith('Error: --evidence must be valid JSON.');
      exitSpy.mockRestore();
    });
  });

  // ── grievances get ────────────────────────────────────────────────────

  describe('grievances get', () => {
    it('fetches and prints grievance details', async () => {
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'grievances', 'get', 'grv_1'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/grievances/grv_1',
        expect.any(Object),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('grv_1');
      expect(output).toContain('GRV-2026-00001');
      expect(output).toContain('data-misuse');
      expect(output).toContain('submitted');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'grievances', 'get', 'grv_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.grievanceId).toBe('grv_1');
      expect(parsed.referenceNumber).toBe('GRV-2026-00001');
    });

    it('shows dash for null resolvedAt and resolution', async () => {
      mockFetchOk(sampleGrievance);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'grievances', 'get', 'grv_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      // Two dashes for resolvedAt and resolution
      expect(output).toMatch(/\u2014/);
    });
  });

  // ── erasure ───────────────────────────────────────────────────────────

  describe('erasure', () => {
    it('requests erasure and prints confirmation', async () => {
      mockFetchOk(sampleErasure);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'erasure', 'user@test.com'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/data-principals/user@test.com/erasure',
        expect.objectContaining({ method: 'POST' }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Erasure request completed');
      expect(output).toContain('ER-2026-00001');
      expect(output).toContain('user@test.com');
      expect(output).toContain('3');
      expect(output).toContain('2');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleErasure);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'erasure', 'user@test.com'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.requestId).toBe('ER-2026-00001');
      expect(parsed.recordsErased).toBe(3);
      expect(parsed.grantsRevoked).toBe(2);
    });
  });

  // ── exports create ────────────────────────────────────────────────────

  describe('exports create', () => {
    it('creates an export and prints confirmation', async () => {
      mockFetchOk(sampleExport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'exports', 'create',
          '--type', 'dpdp-audit',
          '--date-from', '2026-01-01',
          '--date-to', '2026-06-01',
        ],
        { from: 'user' },
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/exports',
        expect.objectContaining({ method: 'POST' }),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('Export created');
      expect(output).toContain('exp_1');
    });

    it('passes optional parameters', async () => {
      mockFetchOk(sampleExport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'exports', 'create',
          '--type', 'gdpr-article-15',
          '--date-from', '2026-01-01',
          '--date-to', '2026-06-01',
          '--format', 'csv',
          '--include-action-log',
          '--include-consent-records',
          '--principal-id', 'user@test.com',
        ],
        { from: 'user' },
      );

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.type).toBe('gdpr-article-15');
      expect(body.format).toBe('csv');
      expect(body.includeActionLog).toBe(true);
      expect(body.includeConsentRecords).toBe(true);
      expect(body.dataPrincipalId).toBe('user@test.com');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleExport);

      const prog = makeProg();
      await prog.parseAsync(
        [
          'dpdp', 'exports', 'create',
          '--type', 'dpdp-audit',
          '--date-from', '2026-01-01',
          '--date-to', '2026-06-01',
        ],
        { from: 'user' },
      );

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.exportId).toBe('exp_1');
      expect(parsed.type).toBe('dpdp-audit');
    });
  });

  // ── exports get ───────────────────────────────────────────────────────

  describe('exports get', () => {
    it('fetches and prints export details', async () => {
      mockFetchOk(sampleExport);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'exports', 'get', 'exp_1'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/exports/exp_1',
        expect.any(Object),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('exp_1');
      expect(output).toContain('dpdp-audit');
      expect(output).toContain('json');
      expect(output).toContain('completed');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(sampleExport);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'exports', 'get', 'exp_1'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.exportId).toBe('exp_1');
      expect(parsed.recordCount).toBe(5);
    });
  });

  // ── principal-records ─────────────────────────────────────────────────

  describe('principal-records', () => {
    it('fetches and prints records for a data principal', async () => {
      mockFetchOk(samplePrincipalRecords);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'principal-records', 'user@test.com'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/dpdp/data-principals/user@test.com/records',
        expect.any(Object),
      );
      const output = vi.mocked(console.log).mock.calls.map((c) => c[0]).join('\n');
      expect(output).toContain('user@test.com');
      expect(output).toContain('1 records');
      expect(output).toContain('cr_1');
      expect(output).toContain('grnt_1');
      expect(output).toContain('active');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(samplePrincipalRecords);

      const prog = makeProg();
      await prog.parseAsync(['dpdp', 'principal-records', 'user@test.com'], { from: 'user' });

      const output = vi.mocked(console.log).mock.calls[0]![0];
      const parsed = JSON.parse(output);
      expect(parsed.dataPrincipalId).toBe('user@test.com');
      expect(parsed.totalRecords).toBe(1);
      expect(parsed.records[0].recordId).toBe('cr_1');
    });
  });

  // ── error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('exits with error when config is not set', async () => {
      vi.mocked(resolveConfig).mockReturnValue(null);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(['dpdp', 'consent', 'list'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(console.error).toHaveBeenCalled();
      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('not configured');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('exits with error when API returns error', async () => {
      mockFetchError(400, 'Grant not found or not owned by developer');

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(
          [
            'dpdp', 'consent', 'create',
            '--grant-id', 'grnt_bad',
            '--principal-id', 'user@test.com',
            '--notice-id', 'notice_v1',
            '--processing-expires-at', '2027-01-01T00:00:00Z',
            '--purposes', '[{"code":"x","description":"y"}]',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow('process.exit');

      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('Grant not found');
      exitSpy.mockRestore();
    });

    it('falls back to HTTP status when error body has no message', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          json: () => Promise.resolve(null),
        }),
      );

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      const prog = makeProg();
      await expect(
        prog.parseAsync(['dpdp', 'consent', 'list'], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      const errorOutput = vi.mocked(console.error).mock.calls.map((c) => c[0]).join('\n');
      expect(errorOutput).toContain('HTTP 500');
      exitSpy.mockRestore();
    });
  });
});

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command, CommanderError } from 'commander';

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
import { createProgram } from '../src/index.js';

// ── Server response fixtures ──────────────────────────────────────────────
// Response bodies exactly as the auth service's DPDP routes send them
// (tests/fixtures/dpdp-server-fixtures.json). Never invent response shapes.

type Json = Record<string, unknown>;
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/dpdp-server-fixtures.json', import.meta.url), 'utf8'),
) as Record<string, Json>;

/** A fixture without its documentation keys (`_note`, `_query`, `_request`). */
function fx(name: string): Json {
  const raw = fixtures[name];
  if (!raw) throw new Error(`missing fixture ${name}`);
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
}

const consentRecord = fx('consentRecord_200');
const erasedLegacyRecord = fx('consentRecord_erased_legacy_200');
const createConsent = fx('createConsentRecord_201');
const listConsent: Json & { nextCursor: string } = {
  ...(fx('listConsentRecords_200') as { nextCursor: string }),
  records: [consentRecord, erasedLegacyRecord],
};
const principalRecords = { ...fx('principalRecords_200'), records: [consentRecord] };
const withdraw = fx('withdrawConsent_200');
const createNotice = fx('createConsentNotice_201');
const listNotices = fx('listConsentNotices_200');
const getNotice = fx('getConsentNotice_200');
const fileGrievance = fx('fileGrievance_202');
const listGrievances = fx('listGrievances_200');
const getGrievance = fx('getGrievance_200');
const updateGrievance = fx('updateGrievance_200');
const createExport = fx('createExport_201');
const getExport = fx('getExport_200');
const erasure = fx('erasure_201');
const errors = fixtures['errors'] as Record<string, Json>;

const RECORD_ID = consentRecord['recordId'] as string;
const GRIEVANCE_ID = getGrievance['grievanceId'] as string;
const EXPORT_ID = createExport['exportId'] as string;
const REQUEST_ID = erasure['requestId'] as string;
const BASE = 'http://localhost:3001';

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

function mockFetchError(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

function fetchUrl(call = 0): string {
  return vi.mocked(fetch).mock.calls[call]![0] as string;
}

function fetchInit(call = 0): RequestInit {
  return vi.mocked(fetch).mock.calls[call]![1] as RequestInit;
}

function sentBody(call = 0): Json {
  return JSON.parse(fetchInit(call).body as string) as Json;
}

function stdout(): string {
  return vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
}

function stderr(): string {
  return vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n');
}

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
}

async function run(args: string[]) {
  await makeProg().parseAsync(args, { from: 'user' });
}

async function runFails(args: string[]) {
  const exitSpy = mockExit();
  await expect(makeProg().parseAsync(args, { from: 'user' })).rejects.toThrow();
  return exitSpy;
}

const consentCreateArgs = [
  'dpdp', 'consent', 'create',
  '--grant-id', 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
  '--principal-id', 'user_123',
  '--notice-id', 'privacy-notice',
  '--processing-expires-at', '2027-09-30T00:00:00.000Z',
  '--purposes', '[{"code":"analytics","description":"Usage analytics for service improvement"}]',
];

const noticeCreateArgs = [
  'dpdp', 'notices', 'create',
  '--notice-id', 'privacy-notice',
  '--notice-version', '2.0',
  '--title', 'Data Processing Consent Notice',
  '--content', 'We collect and process your data for the following purposes...',
  '--purposes', '[{"code":"analytics","description":"Usage analytics"}]',
];

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({ baseUrl: BASE, apiKey: 'gx_test_key' });
  vi.mocked(resolveConfig).mockReturnValue({ baseUrl: BASE, apiKey: 'gx_test_key' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  setJsonMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('dpdp command', () => {
  describe('structure', () => {
    it('registers the "dpdp" command', () => {
      expect(dpdpCommand().name()).toBe('dpdp');
    });

    it('has consent, notices, grievances, erasure, exports, and principal-records subcommands', () => {
      const names = dpdpCommand().commands.map((c) => c.name());
      expect(names).toEqual(
        expect.arrayContaining(['consent', 'notices', 'grievances', 'erasure', 'exports', 'principal-records']),
      );
    });

    it('consent has create, get, list, and withdraw subcommands', () => {
      const consent = dpdpCommand().commands.find((c) => c.name() === 'consent')!;
      expect(consent.commands.map((c) => c.name())).toEqual(
        expect.arrayContaining(['create', 'get', 'list', 'withdraw']),
      );
    });

    it('notices has create, list, and get subcommands', () => {
      const notices = dpdpCommand().commands.find((c) => c.name() === 'notices')!;
      expect(notices.commands.map((c) => c.name())).toEqual(
        expect.arrayContaining(['create', 'list', 'get']),
      );
    });

    it('grievances has file, get, list, and update subcommands', () => {
      const grievances = dpdpCommand().commands.find((c) => c.name() === 'grievances')!;
      expect(grievances.commands.map((c) => c.name())).toEqual(
        expect.arrayContaining(['file', 'get', 'list', 'update']),
      );
    });

    it('exports has create and get subcommands', () => {
      const exports = dpdpCommand().commands.find((c) => c.name() === 'exports')!;
      expect(exports.commands.map((c) => c.name())).toEqual(expect.arrayContaining(['create', 'get']));
    });

    it('cites the right DPDP Act sections in help text', () => {
      const cmd = dpdpCommand();
      const erasureCmd = cmd.commands.find((c) => c.name() === 'erasure')!;
      const access = cmd.commands.find((c) => c.name() === 'principal-records')!;
      const grievances = cmd.commands.find((c) => c.name() === 'grievances')!;
      expect(erasureCmd.description()).toContain('s.12');
      expect(access.description()).toContain('s.11');
      expect(grievances.description()).toContain('s.13');
      expect(erasureCmd.description()).not.toContain('Section 11');
      const allHelp = [erasureCmd, access, grievances].map((c) => c.helpInformation()).join('\n');
      expect(allHelp).not.toContain('13(6)');
    });
  });

  // ── root program (the real one, with .version()) ──────────────────────

  describe('root program', () => {
    function realProgram() {
      const program = createProgram();
      program.exitOverride();
      let out = '';
      program.configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
      return { program, output: () => out };
    }

    it('creates a notice with --notice-version through the real program', async () => {
      mockFetchOk(createNotice, 201);
      const { program, output } = realProgram();
      await program.parseAsync(noticeCreateArgs, { from: 'user' });

      expect(output()).not.toContain('0.4.1');
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-notices`);
      expect(sentBody().version).toBe('2.0');
      expect(sentBody().noticeId).toBe('privacy-notice');
    });

    it('still prints the CLI version for grantex --version', async () => {
      const { program, output } = realProgram();
      const err = await program.parseAsync(['--version'], { from: 'user' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CommanderError);
      expect((err as CommanderError).code).toBe('commander.version');
      expect(output()).toContain('0.4.1');
    });

    it('still prints the CLI version for grantex -V', async () => {
      const { program, output } = realProgram();
      const err = await program.parseAsync(['-V'], { from: 'user' }).catch((e: unknown) => e);
      expect((err as CommanderError).code).toBe('commander.version');
      expect(output()).toContain('0.4.1');
    });
  });

  // ── consent create ────────────────────────────────────────────────────

  describe('consent create', () => {
    it('sends only the fields the server reads, with purposes as {code, description}', async () => {
      mockFetchOk(createConsent, 201);
      await run([
        ...consentCreateArgs.slice(0, -1),
        '[{"code":"analytics","description":"Usage analytics","extra":"dropped"}]',
        '--notice-version', '2.0',
      ]);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-records`);
      expect(fetchInit().method).toBe('POST');
      expect(sentBody()).toEqual({
        grantId: 'grnt_01J9ZB3X6P1L7M2N4Q5R6S7T8V',
        dataPrincipalId: 'user_123',
        purposes: [{ code: 'analytics', description: 'Usage analytics' }],
        consentNoticeId: 'privacy-notice',
        consentNoticeVersion: '2.0',
        processingExpiresAt: '2027-09-30T00:00:00.000Z',
      });
    });

    it('omits consentNoticeVersion when not given', async () => {
      mockFetchOk(createConsent, 201);
      await run(consentCreateArgs);
      expect(sentBody()).not.toHaveProperty('consentNoticeVersion');
    });

    it('prints the record and its consent proof', async () => {
      mockFetchOk(createConsent, 201);
      await run(consentCreateArgs);

      const out = stdout();
      expect(out).toContain('Consent record created');
      expect(out).toContain(createConsent['recordId'] as string);
      expect(out).toContain('2.0');
      expect(out).toContain(createConsent['consentNoticeHash'] as string);
      expect(out).toContain('JWS-EdDSA');
      expect(out).toContain('ed25519-2026-09');
      expect(out).toContain('https://api.grantex.dev/.well-known/jwks.json');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(createConsent, 201);
      await run(consentCreateArgs);

      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.recordId).toBe(createConsent['recordId']);
      expect((parsed.consentProof as Json).proofJwt).toBe((createConsent['consentProof'] as Json).proofJwt);
    });

    it('exits with error for invalid --purposes JSON', async () => {
      const exitSpy = await runFails([...consentCreateArgs.slice(0, -1), 'not-json']);
      expect(console.error).toHaveBeenCalledWith('Error: --purposes must be valid JSON.');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects purposes that are not a non-empty array of {code, description}', async () => {
      for (const bad of ['[]', '{"code":"a","description":"b"}', '[{"code":"a"}]']) {
        vi.mocked(console.error).mockClear();
        await runFails([...consentCreateArgs.slice(0, -1), bad]);
        expect(stderr()).toContain('--purposes must be a non-empty JSON array of {code, description}');
      }
    });
  });

  // ── consent get ───────────────────────────────────────────────────────

  describe('consent get', () => {
    it('fetches and prints consent record details', async () => {
      mockFetchOk(consentRecord);
      await run(['dpdp', 'consent', 'get', RECORD_ID]);

      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/v1/dpdp/consent-records/${RECORD_ID}`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer gx_test_key' }),
        }),
      );
      const out = stdout();
      expect(out).toContain(RECORD_ID);
      expect(out).toContain(consentRecord['grantId'] as string);
      expect(out).toContain('active');
      expect(out).toContain('analytics, personalization');
      expect(out).toMatch(/—/);
    });

    it('url-encodes the record id', async () => {
      mockFetchOk(consentRecord);
      await run(['dpdp', 'consent', 'get', '../../v1/agents']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-records/..%2F..%2Fv1%2Fagents`);
    });

    it('renders an erased legacy record (null notice version)', async () => {
      mockFetchOk(erasedLegacyRecord);
      await run(['dpdp', 'consent', 'get', erasedLegacyRecord['recordId'] as string]);
      const out = stdout();
      expect(out).toContain('erased');
      expect(out).toMatch(/consentNoticeVersion\s+—/);
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(consentRecord);
      await run(['dpdp', 'consent', 'get', RECORD_ID]);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.recordId).toBe(RECORD_ID);
      expect(parsed.status).toBe('active');
    });
  });

  // ── consent list ──────────────────────────────────────────────────────

  describe('consent list', () => {
    it('prints a table of consent records with total and next cursor', async () => {
      mockFetchOk(listConsent);
      await run(['dpdp', 'consent', 'list']);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-records`);
      const out = stdout();
      expect(out).toContain(RECORD_ID);
      expect(out).toContain('user_123');
      expect(out).toContain('active');
      expect(out).toContain('erased');
      expect(out).toContain('Total records: 7');
      expect(out).toContain(`Next cursor: ${listConsent.nextCursor}`);
    });

    it('passes --principal, --limit and --cursor as query parameters', async () => {
      mockFetchOk({ records: [], totalRecords: 0, nextCursor: null });
      await run(['dpdp', 'consent', 'list', '--principal', 'user@test.com', '--limit', '25', '--cursor', 'abc+/=']);
      expect(fetchUrl()).toBe(
        `${BASE}/v1/dpdp/consent-records?dataPrincipalId=user%40test.com&limit=25&cursor=abc%2B%2F%3D`,
      );
      expect(stdout()).not.toContain('Next cursor');
    });

    it('rejects a --limit outside 1..200', async () => {
      mockFetchOk({ records: [], totalRecords: 0, nextCursor: null });
      await runFails(['dpdp', 'consent', 'list', '--limit', '500']);
      expect(stderr()).toContain('--limit must be an integer from 1 to 200');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('prints JSON array in --json mode and the page info on stderr', async () => {
      setJsonMode(true);
      mockFetchOk(listConsent);
      await run(['dpdp', 'consent', 'list']);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json[];
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed[0]!.recordId).toBe(RECORD_ID);
      expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string)).toEqual({
        totalRecords: 7,
        nextCursor: listConsent.nextCursor,
      });
    });
  });

  // ── consent withdraw ──────────────────────────────────────────────────

  describe('consent withdraw', () => {
    it('withdraws consent and prints the server result', async () => {
      mockFetchOk(withdraw);
      await run(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'No longer needed']);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-records/${RECORD_ID}/withdraw`);
      expect(fetchInit().method).toBe('POST');
      expect(sentBody()).toEqual({ reason: 'No longer needed' });
      const out = stdout();
      expect(out).toContain('Consent withdrawn');
      expect(out).toMatch(/grantRevoked\s+true/);
      expect(out).toMatch(/dataDeletionRequested\s+true/);
    });

    it('url-encodes the record id', async () => {
      mockFetchOk(withdraw);
      await run(['dpdp', 'consent', 'withdraw', 'a/b?c', '--reason', 'x']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-records/a%2Fb%3Fc/withdraw`);
    });

    it('passes --revoke-grant and --delete-processed-data', async () => {
      mockFetchOk(withdraw);
      await run(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'r', '--revoke-grant', '--delete-processed-data']);
      expect(sentBody()).toEqual({ reason: 'r', revokeGrant: true, deleteProcessedData: true });
    });

    it('sends revokeGrant false for --no-revoke-grant', async () => {
      mockFetchOk({ ...withdraw, grantRevoked: false });
      await run(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'r', '--no-revoke-grant']);
      expect(sentBody()).toEqual({ reason: 'r', revokeGrant: false });
    });

    it('keeps the older --delete-data spelling working', async () => {
      mockFetchOk(withdraw);
      await run(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'r', '--delete-data']);
      expect(sentBody().deleteProcessedData).toBe(true);
    });

    it('prints message, code and requestId on 409', async () => {
      mockFetchError(409, errors['409_ALREADY_WITHDRAWN']);
      const exitSpy = await runFails(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'r']);
      const err = stderr();
      expect(err).toContain('Consent already withdrawn');
      expect(err).toContain('ALREADY_WITHDRAWN');
      expect(err).toContain('req-7f40');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(withdraw);
      await run(['dpdp', 'consent', 'withdraw', RECORD_ID, '--reason', 'Test']);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.recordId).toBe(RECORD_ID);
      expect(parsed.status).toBe('withdrawn');
    });
  });

  // ── notices ───────────────────────────────────────────────────────────

  describe('notices create', () => {
    it('creates a notice and prints confirmation', async () => {
      mockFetchOk(createNotice, 201);
      await run(noticeCreateArgs);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-notices`);
      expect(sentBody()).toEqual({
        noticeId: 'privacy-notice',
        version: '2.0',
        title: 'Data Processing Consent Notice',
        content: 'We collect and process your data for the following purposes...',
        purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      });
      const out = stdout();
      expect(out).toContain('Consent notice created');
      expect(out).toContain(createNotice['id'] as string);
      expect(out).toContain(createNotice['contentHash'] as string);
    });

    it('requires --notice-version', async () => {
      const i = noticeCreateArgs.indexOf('--notice-version');
      const args = [...noticeCreateArgs.slice(0, i), ...noticeCreateArgs.slice(i + 2)];
      const prog = makeProg();
      prog.commands[0]!.commands.forEach((c) => c.commands.forEach((s) => s.exitOverride().configureOutput({ writeErr: () => {} })));
      await expect(prog.parseAsync(args, { from: 'user' })).rejects.toThrow(/--notice-version/);
    });

    it('passes optional parameters, sending only the grievance officer fields the server reads', async () => {
      mockFetchOk(createNotice, 201);
      await run([
        ...noticeCreateArgs,
        '--language', 'hi',
        '--fiduciary-contact', 'privacy@acme.example',
        '--grievance-officer', '{"name":"Grievance Officer","email":"grievance@acme.example","phone":"+91-00000-00000","x":1}',
      ]);
      const body = sentBody();
      expect(body.language).toBe('hi');
      expect(body.dataFiduciaryContact).toBe('privacy@acme.example');
      expect(body.grievanceOfficer).toEqual({
        name: 'Grievance Officer',
        email: 'grievance@acme.example',
        phone: '+91-00000-00000',
      });
    });

    it('rejects a grievance officer without name and email', async () => {
      mockFetchOk(createNotice, 201);
      await runFails([...noticeCreateArgs, '--grievance-officer', '{"name":"Officer"}']);
      expect(stderr()).toContain('--grievance-officer must be a JSON object with string name and email');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('prints message, code and requestId when the version exists', async () => {
      mockFetchError(409, errors['409_CONFLICT']);
      await runFails(noticeCreateArgs);
      expect(stderr()).toContain('Notice version already exists');
      expect(stderr()).toContain('CONFLICT');
      expect(stderr()).toContain('req-7f43');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(createNotice, 201);
      await run(noticeCreateArgs);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.id).toBe(createNotice['id']);
      expect(parsed.noticeId).toBe('privacy-notice');
    });

    it('exits with error for invalid --purposes JSON', async () => {
      await runFails([...noticeCreateArgs.slice(0, -1), 'bad']);
      expect(console.error).toHaveBeenCalledWith('Error: --purposes must be valid JSON.');
    });

    it('exits with error for invalid --grievance-officer JSON', async () => {
      await runFails([...noticeCreateArgs, '--grievance-officer', 'not-json']);
      expect(console.error).toHaveBeenCalledWith('Error: --grievance-officer must be valid JSON.');
    });
  });

  describe('notices list', () => {
    it('lists notices with pagination', async () => {
      mockFetchOk({ ...listNotices, nextCursor: 'nxt' });
      await run(['dpdp', 'notices', 'list', '--limit', '10', '--cursor', 'c1']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-notices?limit=10&cursor=c1`);
      const out = stdout();
      expect(out).toContain('privacy-notice');
      expect(out).toContain('2.0');
      expect(out).toContain('Data Processing Consent Notice');
      expect(out).toContain('Next cursor: nxt');
      expect(out).not.toContain('Total records');
    });
  });

  describe('notices get', () => {
    it('prints every version of a notice', async () => {
      mockFetchOk(getNotice);
      await run(['dpdp', 'notices', 'get', 'privacy notice/v1']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/consent-notices/privacy%20notice%2Fv1`);
      const out = stdout();
      expect(out).toContain('privacy-notice');
      expect(out).toContain('notice_01J9ZA1B2C3D4E5F6G7H8J9K0M');
      expect(out).toContain('1.0');
      expect(out).toContain('grievance@acme.example');
    });
  });

  // ── grievances ───────────────────────────────────────────────────────

  describe('grievances file', () => {
    const base = [
      'dpdp', 'grievances', 'file',
      '--principal-id', 'user_123',
      '--type', 'unauthorized-processing',
      '--description', 'My data was used for marketing without consent',
    ];

    it('files a grievance and prints the server result', async () => {
      mockFetchOk(fileGrievance, 202);
      await run(base);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/grievances`);
      expect(sentBody()).toEqual({
        dataPrincipalId: 'user_123',
        type: 'unauthorized-processing',
        description: 'My data was used for marketing without consent',
      });
      const out = stdout();
      expect(out).toContain('Grievance filed');
      expect(out).toContain(fileGrievance['grievanceId'] as string);
      expect(out).toContain(fileGrievance['referenceNumber'] as string);
      expect(out).toMatch(/responsePeriodDays\s+7/);
    });

    it('passes --record-id, --evidence and --response-period-days', async () => {
      mockFetchOk(fileGrievance, 202);
      await run([...base, '--record-id', RECORD_ID, '--evidence', '{"screenshots":["https://files.example.com/s1.png"]}', '--response-period-days', '30']);
      const body = sentBody();
      expect(body.recordId).toBe(RECORD_ID);
      expect(body.evidence).toEqual({ screenshots: ['https://files.example.com/s1.png'] });
      expect(body.responsePeriodDays).toBe(30);
    });

    it('rejects --response-period-days outside 1..90', async () => {
      mockFetchOk(fileGrievance, 202);
      for (const bad of ['0', '91', '7.5', 'x']) {
        vi.mocked(console.error).mockClear();
        await runFails([...base, '--response-period-days', bad]);
        expect(stderr()).toContain('--response-period-days must be an integer from 1 to 90');
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects --evidence that is not a JSON object', async () => {
      mockFetchOk(fileGrievance, 202);
      await runFails([...base, '--evidence', '["a"]']);
      expect(stderr()).toContain('--evidence must be a JSON object');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('exits with error for invalid --evidence JSON', async () => {
      await runFails([...base, '--evidence', 'bad-json']);
      expect(console.error).toHaveBeenCalledWith('Error: --evidence must be valid JSON.');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(fileGrievance, 202);
      await run(base);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.grievanceId).toBe(fileGrievance['grievanceId']);
      expect(parsed.status).toBe('submitted');
    });
  });

  describe('grievances get', () => {
    it('fetches and prints grievance details', async () => {
      mockFetchOk(getGrievance);
      await run(['dpdp', 'grievances', 'get', GRIEVANCE_ID]);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/grievances/${GRIEVANCE_ID}`);
      const out = stdout();
      expect(out).toContain(GRIEVANCE_ID);
      expect(out).toContain(getGrievance['referenceNumber'] as string);
      expect(out).toContain('unauthorized-processing');
      expect(out).toContain('in_review');
      expect(out).toMatch(/resolution\s+—/);
    });

    it('url-encodes the grievance id', async () => {
      mockFetchOk(getGrievance);
      await run(['dpdp', 'grievances', 'get', '../../v1/agents']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/grievances/..%2F..%2Fv1%2Fagents`);
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(getGrievance);
      await run(['dpdp', 'grievances', 'get', GRIEVANCE_ID]);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.grievanceId).toBe(GRIEVANCE_ID);
    });
  });

  describe('grievances list', () => {
    it('lists grievances with filters and pagination', async () => {
      mockFetchOk({ ...listGrievances, nextCursor: 'g2' });
      await run(['dpdp', 'grievances', 'list', '--status', 'submitted', '--principal', 'user@test.com', '--limit', '5', '--cursor', 'g1']);
      expect(fetchUrl()).toBe(
        `${BASE}/v1/dpdp/grievances?status=submitted&dataPrincipalId=user%40test.com&limit=5&cursor=g1`,
      );
      const out = stdout();
      expect(out).toContain(GRIEVANCE_ID);
      expect(out).toContain('submitted');
      expect(out).toContain('Next cursor: g2');
    });

    it('rejects an unknown --status', async () => {
      mockFetchOk(listGrievances);
      await runFails(['dpdp', 'grievances', 'list', '--status', 'open']);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('grievances update', () => {
    it('resolves a grievance with PATCH', async () => {
      mockFetchOk(updateGrievance);
      await run(['dpdp', 'grievances', 'update', GRIEVANCE_ID, '--status', 'resolved', '--resolution', 'Marketing processing stopped and the data principal informed']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/grievances/${GRIEVANCE_ID}`);
      expect(fetchInit().method).toBe('PATCH');
      expect(sentBody()).toEqual({
        status: 'resolved',
        resolution: 'Marketing processing stopped and the data principal informed',
      });
      const out = stdout();
      expect(out).toContain('Grievance updated');
      expect(out).toContain('resolved');
      expect(out).toContain('Marketing processing stopped');
    });

    it('moves a grievance to in_review without a resolution', async () => {
      mockFetchOk(getGrievance);
      await run(['dpdp', 'grievances', 'update', 'grv/1', '--status', 'in_review']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/grievances/grv%2F1`);
      expect(sentBody()).toEqual({ status: 'in_review' });
    });

    it('requires --resolution for resolved and rejected', async () => {
      mockFetchOk(updateGrievance);
      for (const status of ['resolved', 'rejected']) {
        vi.mocked(console.error).mockClear();
        await runFails(['dpdp', 'grievances', 'update', GRIEVANCE_ID, '--status', status]);
        expect(stderr()).toContain(`--resolution is required when --status is ${status}`);
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects an unknown --status', async () => {
      mockFetchOk(updateGrievance);
      await runFails(['dpdp', 'grievances', 'update', GRIEVANCE_ID, '--status', 'submitted']);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('prints message, code and requestId on INVALID_TRANSITION', async () => {
      mockFetchError(409, errors['409_INVALID_TRANSITION']);
      await runFails(['dpdp', 'grievances', 'update', GRIEVANCE_ID, '--status', 'in_review']);
      expect(stderr()).toContain('INVALID_TRANSITION');
      expect(stderr()).toContain('req-7f44');
    });
  });

  // ── erasure ───────────────────────────────────────────────────────────

  describe('erasure', () => {
    it('requests erasure with no body and prints the full result (201)', async () => {
      mockFetchOk(erasure, 201);
      await run(['dpdp', 'erasure', 'user@test.com']);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/data-principals/user%40test.com/erasure`);
      expect(fetchInit().method).toBe('POST');
      expect(fetchInit().body).toBeUndefined();
      expect((fetchInit().headers as Record<string, string>)['Content-Type']).toBeUndefined();

      const out = stdout();
      expect(out).toContain(`Erasure completed: ${REQUEST_ID}`);
      expect(out).toMatch(/recordsErased\s+2/);
      expect(out).toMatch(/grantsRevoked\s+1/);
      expect(out).toMatch(/delegatedGrantsRevoked\s+0/);
      expect(out).toMatch(/grievancesRedacted\s+1/);
      expect(out).toMatch(/exportsDeleted\s+0/);
      expect(out).toContain('consent_records (2)');
      expect(out).toContain('audit_log');
      expect(out).toContain('fiduciary_data');
      expect(out).toContain('DPDP Rules 2025 r.8(3)');
    });

    it('reports a repeat request (200) as the earlier request', async () => {
      mockFetchOk(erasure, 200);
      await run(['dpdp', 'erasure', 'user_123']);
      const out = stdout();
      expect(out).toContain(`Nothing left to erase; earlier erasure request: ${REQUEST_ID}`);
      expect(out).not.toContain('Erasure completed');
    });

    it('url-encodes a traversal principal id', async () => {
      mockFetchOk(erasure, 201);
      await run(['dpdp', 'erasure', '../../v1/agents']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/data-principals/..%2F..%2Fv1%2Fagents/erasure`);
    });

    it('accepts the explicit "request" form, for a principal named "status"', async () => {
      mockFetchOk(erasure, 201);
      await run(['dpdp', 'erasure', 'request', 'status']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/data-principals/status/erasure`);
    });

    it('gets an erasure request with "erasure status"', async () => {
      mockFetchOk(erasure);
      await run(['dpdp', 'erasure', 'status', REQUEST_ID]);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/erasure-requests/${REQUEST_ID}`);
      expect(fetchInit().method ?? 'GET').toBe('GET');
      const out = stdout();
      expect(out).toContain(REQUEST_ID);
      expect(out).toContain('completed');
      expect(out).toMatch(/recordsErased\s+2/);
    });

    it('url-encodes the erasure request id', async () => {
      mockFetchOk(erasure);
      await run(['dpdp', 'erasure', 'status', '../ER 1']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/erasure-requests/..%2FER%201`);
    });

    it('prints message, code and requestId on 404', async () => {
      mockFetchError(404, { message: 'No consent records for this data principal', code: 'NOT_FOUND', requestId: 'req-9001' });
      await runFails(['dpdp', 'erasure', 'user_404']);
      expect(stderr()).toContain('No consent records for this data principal');
      expect(stderr()).toContain('NOT_FOUND');
      expect(stderr()).toContain('req-9001');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(erasure, 201);
      await run(['dpdp', 'erasure', 'user_123']);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.requestId).toBe(REQUEST_ID);
      expect(parsed.recordsErased).toBe(2);
      expect(parsed.retained).toHaveLength(4);
    });
  });

  // ── exports ───────────────────────────────────────────────────────────

  describe('exports create', () => {
    const base = ['dpdp', 'exports', 'create', '--type', 'dpdp-audit', '--date-from', '2026-09-01', '--date-to', '2026-09-30T23:59:59.999Z'];

    it('creates an export and prints truncation details', async () => {
      mockFetchOk(createExport, 201);
      await run(base);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/exports`);
      expect(sentBody()).toEqual({ type: 'dpdp-audit', dateFrom: '2026-09-01', dateTo: '2026-09-30T23:59:59.999Z' });
      const out = stdout();
      expect(out).toContain('Export created');
      expect(out).toContain(EXPORT_ID);
      expect(out).toMatch(/truncated\s+false/);
      expect(out).toMatch(/auditLogLimit\s+1000/);
    });

    it('warns when the audit log was truncated', async () => {
      mockFetchOk({ ...createExport, truncated: true }, 201);
      await run(base);
      expect(stdout()).toContain('truncated at 1000 entries');
    });

    it('passes optional parameters', async () => {
      mockFetchOk(createExport, 201);
      await run([...base, '--format', 'json', '--include-action-log', '--include-consent-records', '--principal-id', 'user@test.com']);
      const body = sentBody();
      expect(body.format).toBe('json');
      expect(body.includeActionLog).toBe(true);
      expect(body.includeConsentRecords).toBe(true);
      expect(body.dataPrincipalId).toBe('user@test.com');
    });

    it('sends false for --no-include-action-log and --no-include-consent-records', async () => {
      mockFetchOk(createExport, 201);
      await run([...base, '--no-include-action-log', '--no-include-consent-records']);
      const body = sentBody();
      expect(body.includeActionLog).toBe(false);
      expect(body.includeConsentRecords).toBe(false);
    });

    it('rejects --format csv (the server produces JSON only)', async () => {
      mockFetchOk(createExport, 201);
      const prog = makeProg();
      prog.commands[0]!.commands.forEach((c) => c.commands.forEach((s) => s.exitOverride().configureOutput({ writeErr: () => {} })));
      await expect(prog.parseAsync([...base, '--format', 'csv'], { from: 'user' })).rejects.toThrow(/csv/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(createExport, 201);
      await run(base);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.exportId).toBe(EXPORT_ID);
      expect(parsed.type).toBe('dpdp-audit');
    });
  });

  describe('exports get', () => {
    it('fetches and prints export details', async () => {
      mockFetchOk(getExport);
      await run(['dpdp', 'exports', 'get', EXPORT_ID]);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/exports/${EXPORT_ID}`);
      const out = stdout();
      expect(out).toContain(EXPORT_ID);
      expect(out).toContain('dpdp-audit');
      expect(out).toMatch(/status\s+complete$/m);
      expect(out).toMatch(/truncated\s+true/);
      expect(out).toContain('truncated at 1000 entries');
    });

    it('url-encodes the export id', async () => {
      mockFetchOk(getExport);
      await run(['dpdp', 'exports', 'get', '../x']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/exports/..%2Fx`);
    });

    it('reports an expired export (410 GONE)', async () => {
      mockFetchError(410, errors['410_GONE']);
      const exitSpy = await runFails(['dpdp', 'exports', 'get', EXPORT_ID]);
      expect(stderr()).toContain('Export has expired and its data was purged');
      expect(stderr()).toContain('GONE');
      expect(stderr()).toContain('req-7f45');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(getExport);
      await run(['dpdp', 'exports', 'get', EXPORT_ID]);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.exportId).toBe(EXPORT_ID);
      expect(parsed.recordCount).toBe(1001);
    });
  });

  // ── principal-records ─────────────────────────────────────────────────

  describe('principal-records', () => {
    it('fetches and prints records for a data principal', async () => {
      mockFetchOk(principalRecords);
      await run(['dpdp', 'principal-records', 'user_123']);

      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/data-principals/user_123/records`);
      const out = stdout();
      expect(out).toContain('user_123');
      expect(out).toContain('1 records');
      expect(out).toContain(RECORD_ID);
      expect(out).toContain('active');
    });

    it('url-encodes the principal id and passes pagination', async () => {
      mockFetchOk({ ...principalRecords, nextCursor: 'p2' });
      await run(['dpdp', 'principal-records', 'user@test.com', '--limit', '2', '--cursor', 'p1']);
      expect(fetchUrl()).toBe(`${BASE}/v1/dpdp/data-principals/user%40test.com/records?limit=2&cursor=p1`);
      expect(stdout()).toContain('Next cursor: p2');
    });

    it('prints JSON in --json mode', async () => {
      setJsonMode(true);
      mockFetchOk(principalRecords);
      await run(['dpdp', 'principal-records', 'user_123']);
      const parsed = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string) as Json;
      expect(parsed.dataPrincipalId).toBe('user_123');
      expect(parsed.totalRecords).toBe(1);
      expect((parsed.records as Json[])[0]!.recordId).toBe(RECORD_ID);
    });
  });

  // ── error handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    it('exits with error when config is not set', async () => {
      vi.mocked(resolveConfig).mockReturnValue(null);
      const exitSpy = await runFails(['dpdp', 'consent', 'list']);
      expect(stderr()).toContain('not configured');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints message, code and requestId from the DPDP error body', async () => {
      mockFetchError(400, errors['400_INVALID_GRANT']);
      await runFails(consentCreateArgs);
      expect(stderr()).toBe('Error: Grant not found or not owned by developer (code: INVALID_GRANT, requestId: req-7f3b)');
    });

    it('uses the error field of non-DPDP error bodies', async () => {
      mockFetchError(429, { error: 'Too Many Requests', code: 'RATE_LIMITED', statusCode: 429 });
      await runFails(['dpdp', 'consent', 'list']);
      expect(stderr()).toBe('Error: Too Many Requests (code: RATE_LIMITED)');
    });

    it('falls back to HTTP status when error body has no message', async () => {
      mockFetchError(500, null);
      await runFails(['dpdp', 'consent', 'list']);
      expect(stderr()).toContain('HTTP 500');
    });

    it('sends every request with a timeout signal', async () => {
      mockFetchOk(listConsent);
      await run(['dpdp', 'consent', 'list']);
      expect(fetchInit().signal).toBeInstanceOf(AbortSignal);
    });

    it('reports a timeout', async () => {
      const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
      await runFails(['dpdp', 'consent', 'list']);
      expect(stderr()).toContain('Error: request timed out after 30s');
    });

    it('reports a network failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
      await runFails(['dpdp', 'consent', 'list']);
      expect(stderr()).toContain('Error: request failed: fetch failed');
    });
  });
});

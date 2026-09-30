import { Command, Option } from 'commander';
import chalk from 'chalk';
import { defaultConfigPath, loadConfig, resolveConfig, type CliConfig } from '../config.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

// ── Internal HTTP helper ──────────────────────────────────────────────────

/** Every DPDP request is aborted after this long. */
const REQUEST_TIMEOUT_MS = 30_000;

function validateBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid protocol: ${url.protocol} — only http/https allowed`);
  }
  return url.origin; // normalized, no path/query/fragment
}

async function getConfig(): Promise<CliConfig> {
  const fileConfig = await loadConfig(defaultConfigPath());
  const config = resolveConfig(fileConfig);
  if (!config) {
    console.error(
      'Error: Grantex is not configured.\n' +
        'Run:  grantex config set --url <url> --key <api-key>\n' +
        'Or set the GRANTEX_URL and GRANTEX_KEY environment variables.',
    );
    process.exit(1);
  }
  return config;
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

/**
 * One line for a failed response. DPDP routes send `{message, code, requestId}`;
 * authentication and rate-limit errors send `{error, code, statusCode}`.
 */
export function formatApiError(status: number, body: unknown): string {
  const b = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const message = text(b['message']) ?? text(b['error']) ?? `HTTP ${status}`;
  const code = text(b['code']);
  const requestId = text(b['requestId']);
  const details = [
    code !== undefined ? `code: ${code}` : undefined,
    requestId !== undefined ? `requestId: ${requestId}` : undefined,
  ].filter((d): d is string => d !== undefined);
  return details.length > 0 ? `${message} (${details.join(', ')})` : message;
}

/**
 * Send one request. DPDP writes are not idempotent, so nothing is retried.
 * `body === undefined` sends no body and no Content-Type.
 */
async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ data: T; status: number }> {
  const config = await getConfig();
  const safeBase = validateBaseUrl(config.baseUrl); // lgtm[js/file-access-to-http]
  const url = `${safeBase}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${String(config.apiKey)}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      fail(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const respBody: unknown = await res.json().catch(() => null);
    fail(formatApiError(res.status, respBody));
  }
  const data = (await res.json()) as T;
  return { data, status: res.status };
}

async function apiGet<T>(path: string): Promise<T> {
  return (await apiRequest<T>('GET', path)).data;
}

async function apiPost<T>(path: string, body?: unknown): Promise<{ data: T; status: number }> {
  return apiRequest<T>('POST', path, body);
}

async function apiPatch<T>(path: string, body: unknown): Promise<{ data: T; status: number }> {
  return apiRequest<T>('PATCH', path, body);
}

/** Encode one path segment so an ID can never change the route. */
const seg = (value: string) => encodeURIComponent(value);

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

function intInRange(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > max) {
    fail(`${name} must be an integer from ${min} to ${max}.`);
  }
  return n;
}

const limitOf = (v: string | undefined) => intInRange(v, '--limit', 1, 200);

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    fail(`${name} must be valid JSON.`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Purposes as the server reads them: a non-empty array of `{code, description}`. */
function parsePurposes(value: string): Purpose[] {
  const parsed = parseJson(value, '--purposes');
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p) => isPlainObject(p) && typeof p['code'] === 'string' && typeof p['description'] === 'string')
  ) {
    fail('--purposes must be a non-empty JSON array of {code, description}.');
  }
  return (parsed as Purpose[]).map((p) => ({ code: p.code, description: p.description }));
}

const dash = '—';
const orDash = (v: unknown) => (v === null || v === undefined || v === '' ? dash : String(v));
const dateOrDash = (v: string | null | undefined) => (v ? shortDate(v) : dash);

/** Print the pagination info the server returned. */
function printPage(page: { nextCursor?: string | null; totalRecords?: number }): void {
  if (isJsonMode()) {
    // stdout stays the JSON array; the page info goes to stderr.
    const info: Record<string, unknown> = {};
    if (page.totalRecords !== undefined) info['totalRecords'] = page.totalRecords;
    if (page.nextCursor) info['nextCursor'] = page.nextCursor;
    if (Object.keys(info).length > 0) console.error(JSON.stringify(info));
    return;
  }
  if (page.totalRecords !== undefined) console.log(`Total records: ${page.totalRecords}`);
  if (page.nextCursor) console.log(`Next cursor: ${page.nextCursor}`);
}

// ── Types (as the server sends them) ──────────────────────────────────────

interface Purpose {
  code: string;
  description: string;
}

interface ConsentProof {
  type: string;
  alg: string;
  kid: string | null;
  /** Absent from older servers. */
  keyPersistence?: 'persistent' | 'ephemeral';
  proofJwt: string;
  jwksUri: string;
  signedAt: string;
}

/** GET and list shape. */
interface ConsentRecord {
  recordId: string;
  grantId: string;
  /** Absent per record on older servers' principal-records responses. */
  dataPrincipalId?: string;
  dataFiduciaryName?: string;
  purposes?: Purpose[];
  scopes?: string[];
  consentNoticeId?: string;
  consentNoticeVersion?: string | null;
  status: string;
  consentGivenAt?: string;
  processingExpiresAt: string;
  retentionUntil: string;
  accessCount?: number;
  lastAccessedAt?: string | null;
  withdrawnAt?: string | null;
  withdrawnReason?: string | null;
  erasedAt?: string | null;
  createdAt: string;
}

/** POST /v1/dpdp/consent-records shape. */
interface CreatedConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  consentNoticeId: string;
  consentNoticeVersion: string | null;
  consentNoticeHash: string;
  consentProof?: ConsentProof;
  processingExpiresAt: string;
  retentionUntil: string;
  status: string;
  createdAt: string;
}

interface ConsentRecordPage {
  records: ConsentRecord[];
  totalRecords: number;
  nextCursor?: string | null;
}

interface PrincipalRecordsResponse extends ConsentRecordPage {
  dataPrincipalId: string;
}

interface WithdrawResponse {
  recordId: string;
  status: string;
  withdrawnAt: string;
  grantRevoked: boolean;
  dataDeleted: boolean;
  dataDeletionRequested?: boolean;
}

interface NoticeResponse {
  id: string;
  noticeId: string;
  version: string;
  language: string;
  contentHash: string;
  createdAt: string;
}

interface NoticeSummary extends NoticeResponse {
  title: string;
}

interface NoticeVersion {
  id: string;
  version: string;
  language: string;
  title: string;
  content: string;
  purposes: Purpose[];
  dataFiduciaryContact: string | null;
  grievanceOfficer: { name: string; email: string; phone?: string } | null;
  contentHash: string;
  createdAt: string;
}

interface GrievanceResponse {
  grievanceId: string;
  referenceNumber: string;
  type: string;
  status: string;
  dataPrincipalId?: string;
  description?: string;
  evidence?: Record<string, unknown>;
  recordId?: string | null;
  responsePeriodDays?: number;
  expectedResolutionBy: string;
  resolvedAt?: string | null;
  resolution?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

interface ErasureResponse {
  requestId: string;
  dataPrincipalId: string;
  status: string;
  recordsErased: number;
  grantsRevoked: number;
  delegatedGrantsRevoked?: number;
  grievancesRedacted?: number;
  exportsDeleted?: number;
  retained?: { category: string; count?: number; reason: string }[];
  submittedAt: string;
  completedAt?: string;
  /** Deprecated: equals completedAt. */
  expectedCompletionBy?: string;
}

interface ExportResponse {
  exportId: string;
  type: string;
  format: string;
  recordCount: number;
  truncated?: boolean;
  auditLogLimit?: number;
  dataPrincipalId?: string | null;
  data: Record<string, unknown>;
  /** GET only, and always 'complete': an expired export is 410 GONE. */
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  expiresAt: string;
  createdAt: string;
}

const GRIEVANCE_STATUSES = ['submitted', 'in_review', 'resolved', 'rejected'];
const GRIEVANCE_UPDATE_STATUSES = ['in_review', 'resolved', 'rejected'];

// ── Printers ──────────────────────────────────────────────────────────────

function printGrievance(res: GrievanceResponse): void {
  printRecord({
    grievanceId: res.grievanceId,
    referenceNumber: res.referenceNumber,
    dataPrincipalId: orDash(res.dataPrincipalId),
    recordId: orDash(res.recordId),
    type: res.type,
    status: res.status,
    description: orDash(res.description),
    responsePeriodDays: orDash(res.responsePeriodDays),
    expectedResolutionBy: shortDate(res.expectedResolutionBy),
    resolvedAt: dateOrDash(res.resolvedAt),
    resolution: orDash(res.resolution),
    createdAt: shortDate(res.createdAt),
    updatedAt: dateOrDash(res.updatedAt),
  });
}

function printErasure(res: ErasureResponse): void {
  printRecord({
    requestId: res.requestId,
    dataPrincipalId: res.dataPrincipalId,
    status: res.status,
    recordsErased: String(res.recordsErased),
    grantsRevoked: String(res.grantsRevoked),
    delegatedGrantsRevoked: orDash(res.delegatedGrantsRevoked),
    grievancesRedacted: orDash(res.grievancesRedacted),
    exportsDeleted: orDash(res.exportsDeleted),
    submittedAt: shortDate(res.submittedAt),
    completedAt: dateOrDash(res.completedAt ?? res.expectedCompletionBy),
  });
  if (res.retained && res.retained.length > 0) {
    console.log('\nRetained:');
    for (const r of res.retained) {
      const count = r.count !== undefined ? ` (${r.count})` : '';
      console.log(`  ${r.category}${count}: ${r.reason}`);
    }
  }
}

function printExport(res: ExportResponse): void {
  printRecord({
    exportId: res.exportId,
    type: res.type,
    format: res.format,
    ...(res.status !== undefined ? { status: res.status } : {}),
    ...(res.dateFrom !== undefined ? { dateFrom: shortDate(res.dateFrom) } : {}),
    ...(res.dateTo !== undefined ? { dateTo: shortDate(res.dateTo) } : {}),
    dataPrincipalId: orDash(res.dataPrincipalId),
    recordCount: String(res.recordCount),
    truncated: orDash(res.truncated),
    auditLogLimit: orDash(res.auditLogLimit),
    expiresAt: shortDate(res.expiresAt),
    createdAt: shortDate(res.createdAt),
  });
  if (res.truncated) {
    console.log(
      chalk.yellow('!') +
        ` The audit log was truncated at ${String(res.auditLogLimit)} entries; narrow the date range for a complete export.`,
    );
  }
}

// ── Command ───────────────────────────────────────────────────────────────

export function dpdpCommand(): Command {
  const cmd = new Command('dpdp').description(
    'India DPDP Act — consent records, notices, grievances, erasure, and exports',
  );

  // ── consent ────────────────────────────────────────────────────────────
  const consent = new Command('consent').description('Manage DPDP consent records');

  consent
    .command('create')
    .description('Create a consent record')
    .requiredOption('--grant-id <grantId>', 'Grant ID')
    .requiredOption('--principal-id <principalId>', "Data principal ID (the grant's principal)")
    .requiredOption('--notice-id <noticeId>', 'Consent notice ID')
    .option('--notice-version <version>', 'Consent notice version (default: the latest)')
    .requiredOption('--processing-expires-at <iso>', 'Processing expiry (ISO 8601 date-time, in the future)')
    .requiredOption('--purposes <json>', 'Purposes JSON array (e.g. [{"code":"analytics","description":"..."}])')
    .action(
      async (opts: {
        grantId: string;
        principalId: string;
        noticeId: string;
        noticeVersion?: string;
        processingExpiresAt: string;
        purposes: string;
      }) => {
        const purposes = parsePurposes(opts.purposes);

        const { data: res } = await apiPost<CreatedConsentRecord>('/v1/dpdp/consent-records', {
          grantId: opts.grantId,
          dataPrincipalId: opts.principalId,
          purposes,
          consentNoticeId: opts.noticeId,
          ...(opts.noticeVersion !== undefined ? { consentNoticeVersion: opts.noticeVersion } : {}),
          processingExpiresAt: opts.processingExpiresAt,
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Consent record created: ${res.recordId}`);
        const proof = res.consentProof;
        printRecord({
          recordId: res.recordId,
          grantId: res.grantId,
          dataPrincipalId: res.dataPrincipalId,
          consentNoticeId: res.consentNoticeId,
          consentNoticeVersion: orDash(res.consentNoticeVersion),
          consentNoticeHash: res.consentNoticeHash,
          status: res.status,
          processingExpiresAt: shortDate(res.processingExpiresAt),
          retentionUntil: shortDate(res.retentionUntil),
          createdAt: shortDate(res.createdAt),
          proofType: orDash(proof?.type),
          proofAlg: orDash(proof?.alg),
          proofKid: orDash(proof?.kid),
          proofKeyPersistence: orDash(proof?.keyPersistence),
          proofJwksUri: orDash(proof?.jwksUri),
          proofSignedAt: dateOrDash(proof?.signedAt),
        });
      },
    );

  consent
    .command('get <recordId>')
    .description('Get a consent record by ID')
    .action(async (recordId: string) => {
      const res = await apiGet<ConsentRecord>(`/v1/dpdp/consent-records/${seg(recordId)}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        recordId: res.recordId,
        grantId: res.grantId,
        dataPrincipalId: orDash(res.dataPrincipalId),
        dataFiduciaryName: orDash(res.dataFiduciaryName),
        purposes: res.purposes && res.purposes.length > 0 ? res.purposes.map((p) => p.code).join(', ') : dash,
        consentNoticeId: orDash(res.consentNoticeId),
        consentNoticeVersion: orDash(res.consentNoticeVersion),
        status: res.status,
        processingExpiresAt: shortDate(res.processingExpiresAt),
        retentionUntil: shortDate(res.retentionUntil),
        withdrawnAt: dateOrDash(res.withdrawnAt),
        withdrawnReason: orDash(res.withdrawnReason),
        erasedAt: dateOrDash(res.erasedAt),
        createdAt: shortDate(res.createdAt),
      });
    });

  consent
    .command('list')
    .description('List consent records')
    .option('--principal <principalId>', 'Filter by data principal ID')
    .option('--limit <n>', 'Page size, 1 to 200; without --limit or --cursor the newest 100 (every match with --principal)')
    .option('--cursor <cursor>', 'Cursor from the previous page (nextCursor)')
    .action(async (opts: { principal?: string; limit?: string; cursor?: string }) => {
      const limit = limitOf(opts.limit);
      const res = await apiGet<ConsentRecordPage>(
        `/v1/dpdp/consent-records${query({ dataPrincipalId: opts.principal, limit, cursor: opts.cursor })}`,
      );

      printTable(
        res.records.map((r) => ({
          ID: r.recordId,
          GRANT: r.grantId,
          PRINCIPAL: orDash(r.dataPrincipalId),
          STATUS: r.status,
          EXPIRES: shortDate(r.processingExpiresAt),
          CREATED: shortDate(r.createdAt),
        })),
        ['ID', 'GRANT', 'PRINCIPAL', 'STATUS', 'EXPIRES', 'CREATED'],
        res.records.map((r) => ({ ...r })),
      );
      printPage(res);
    });

  consent
    .command('withdraw <recordId>')
    .description('Withdraw consent for a record (DPDP Act s.6(4))')
    .requiredOption('--reason <reason>', 'Reason for withdrawal')
    .option('--revoke-grant', 'Also revoke the underlying grant')
    .option('--no-revoke-grant', 'Keep the underlying grant (default when neither is given: the server setting)')
    .option('--delete-processed-data', 'Record a request to delete the processed data')
    .addOption(new Option('--delete-data', 'Same as --delete-processed-data').hideHelp())
    .action(
      async (
        recordId: string,
        opts: { reason: string; revokeGrant?: boolean; deleteProcessedData?: boolean; deleteData?: boolean },
      ) => {
        const deleteProcessedData = opts.deleteProcessedData === true || opts.deleteData === true;
        const { data: res } = await apiPost<WithdrawResponse>(
          `/v1/dpdp/consent-records/${seg(recordId)}/withdraw`,
          {
            reason: opts.reason,
            ...(opts.revokeGrant !== undefined ? { revokeGrant: opts.revokeGrant } : {}),
            ...(deleteProcessedData ? { deleteProcessedData: true } : {}),
          },
        );

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Consent withdrawn: ${res.recordId}`);
        printRecord({
          recordId: res.recordId,
          status: res.status,
          withdrawnAt: shortDate(res.withdrawnAt),
          grantRevoked: String(res.grantRevoked),
          dataDeletionRequested: orDash(res.dataDeletionRequested),
          dataDeleted: String(res.dataDeleted),
        });
      },
    );

  cmd.addCommand(consent);

  // ── notices ────────────────────────────────────────────────────────────
  const notices = new Command('notices').description('Manage DPDP consent notices (DPDP Act s.5)');

  // The version option is --notice-version: the root program owns --version
  // (and -V) and would print the CLI version instead of running this command.
  notices
    .command('create')
    .description('Create a consent notice version')
    .requiredOption('--notice-id <noticeId>', 'Notice identifier')
    .requiredOption('--notice-version <version>', 'Notice version (e.g. 1.0)')
    .requiredOption('--title <title>', 'Notice title')
    .requiredOption('--content <content>', 'Notice content text')
    .requiredOption('--purposes <json>', 'Purposes JSON array of {code, description}')
    .option('--language <lang>', 'Language code (server default: en)')
    .option('--fiduciary-contact <contact>', 'Data fiduciary contact')
    .option('--grievance-officer <json>', 'Grievance officer JSON: {"name","email","phone"?}')
    .action(
      async (opts: {
        noticeId: string;
        noticeVersion: string;
        title: string;
        content: string;
        purposes: string;
        language?: string;
        fiduciaryContact?: string;
        grievanceOfficer?: string;
      }) => {
        const purposes = parsePurposes(opts.purposes);

        let grievanceOfficer: { name: string; email: string; phone?: string } | undefined;
        if (opts.grievanceOfficer !== undefined) {
          const g = parseJson(opts.grievanceOfficer, '--grievance-officer');
          if (
            !isPlainObject(g) ||
            typeof g['name'] !== 'string' ||
            typeof g['email'] !== 'string' ||
            (g['phone'] !== undefined && typeof g['phone'] !== 'string')
          ) {
            fail('--grievance-officer must be a JSON object with string name and email (and optional phone).');
          }
          grievanceOfficer = {
            name: g['name'],
            email: g['email'],
            ...(typeof g['phone'] === 'string' ? { phone: g['phone'] } : {}),
          };
        }

        const { data: res } = await apiPost<NoticeResponse>('/v1/dpdp/consent-notices', {
          noticeId: opts.noticeId,
          version: opts.noticeVersion,
          title: opts.title,
          content: opts.content,
          purposes,
          ...(opts.language !== undefined ? { language: opts.language } : {}),
          ...(opts.fiduciaryContact !== undefined ? { dataFiduciaryContact: opts.fiduciaryContact } : {}),
          ...(grievanceOfficer !== undefined ? { grievanceOfficer } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Consent notice created: ${res.id}`);
        printRecord({
          id: res.id,
          noticeId: res.noticeId,
          version: res.version,
          language: res.language,
          contentHash: res.contentHash,
          createdAt: shortDate(res.createdAt),
        });
      },
    );

  notices
    .command('list')
    .description('List consent notice versions')
    .option('--limit <n>', 'Page size, 1 to 200 (server default: 50)')
    .option('--cursor <cursor>', 'Cursor from the previous page (nextCursor)')
    .action(async (opts: { limit?: string; cursor?: string }) => {
      const limit = limitOf(opts.limit);
      const res = await apiGet<{ notices: NoticeSummary[]; nextCursor?: string | null }>(
        `/v1/dpdp/consent-notices${query({ limit, cursor: opts.cursor })}`,
      );
      printTable(
        res.notices.map((n) => ({
          ID: n.id,
          NOTICE: n.noticeId,
          VERSION: n.version,
          LANG: n.language,
          TITLE: n.title,
          CREATED: shortDate(n.createdAt),
        })),
        ['ID', 'NOTICE', 'VERSION', 'LANG', 'TITLE', 'CREATED'],
        res.notices.map((n) => ({ ...n })),
      );
      printPage(res);
    });

  notices
    .command('get <noticeId>')
    .description('Get every version of a consent notice, newest first')
    .action(async (noticeId: string) => {
      const res = await apiGet<{ noticeId: string; versions: NoticeVersion[] }>(
        `/v1/dpdp/consent-notices/${seg(noticeId)}`,
      );
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Notice: ${res.noticeId}  (${res.versions.length} versions)\n`);
      for (const v of res.versions) {
        const officer = v.grievanceOfficer;
        printRecord({
          id: v.id,
          version: v.version,
          language: v.language,
          title: v.title,
          purposes: v.purposes.map((p) => p.code).join(', ') || dash,
          dataFiduciaryContact: orDash(v.dataFiduciaryContact),
          grievanceOfficer: officer
            ? [officer.name, officer.email, officer.phone].filter((x) => x !== undefined && x !== '').join(', ')
            : dash,
          contentHash: v.contentHash,
          createdAt: shortDate(v.createdAt),
        });
        console.log('');
      }
    });

  cmd.addCommand(notices);

  // ── grievances ─────────────────────────────────────────────────────────
  const grievances = new Command('grievances').description('Manage DPDP grievances (DPDP Act s.13)');

  grievances
    .command('file')
    .description('File a grievance')
    .requiredOption('--principal-id <principalId>', 'Data principal ID')
    .requiredOption(
      '--type <type>',
      'Grievance type, free text up to 128 characters (e.g. consent-violation, data-breach, unauthorized-processing)',
    )
    .requiredOption('--description <desc>', 'Grievance description')
    .option('--record-id <recordId>', 'Related consent record ID')
    .option('--evidence <json>', 'Evidence JSON object (at most 16 KiB)')
    .option('--response-period-days <days>', 'Response period, 1 to 90 days (product default: 7)')
    .action(
      async (opts: {
        principalId: string;
        type: string;
        description: string;
        recordId?: string;
        evidence?: string;
        responsePeriodDays?: string;
      }) => {
        let evidence: Record<string, unknown> | undefined;
        if (opts.evidence !== undefined) {
          const parsed = parseJson(opts.evidence, '--evidence');
          if (!isPlainObject(parsed)) fail('--evidence must be a JSON object.');
          evidence = parsed;
        }
        const responsePeriodDays = intInRange(opts.responsePeriodDays, '--response-period-days', 1, 90);

        const { data: res } = await apiPost<GrievanceResponse>('/v1/dpdp/grievances', {
          dataPrincipalId: opts.principalId,
          type: opts.type,
          description: opts.description,
          ...(opts.recordId !== undefined ? { recordId: opts.recordId } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
          ...(responsePeriodDays !== undefined ? { responsePeriodDays } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Grievance filed: ${res.grievanceId}`);
        printRecord({
          grievanceId: res.grievanceId,
          referenceNumber: res.referenceNumber,
          type: res.type,
          status: res.status,
          responsePeriodDays: orDash(res.responsePeriodDays),
          expectedResolutionBy: shortDate(res.expectedResolutionBy),
          createdAt: shortDate(res.createdAt),
        });
      },
    );

  grievances
    .command('get <grievanceId>')
    .description('Get a grievance')
    .action(async (grievanceId: string) => {
      const res = await apiGet<GrievanceResponse>(`/v1/dpdp/grievances/${seg(grievanceId)}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printGrievance(res);
    });

  grievances
    .command('list')
    .description('List grievances')
    .addOption(new Option('--status <status>', 'Filter by status').choices(GRIEVANCE_STATUSES))
    .option('--principal <principalId>', 'Filter by data principal ID')
    .option('--limit <n>', 'Page size, 1 to 200 (server default: 50)')
    .option('--cursor <cursor>', 'Cursor from the previous page (nextCursor)')
    .action(async (opts: { status?: string; principal?: string; limit?: string; cursor?: string }) => {
      const limit = limitOf(opts.limit);
      const res = await apiGet<{ grievances: GrievanceResponse[]; nextCursor?: string | null }>(
        `/v1/dpdp/grievances${query({ status: opts.status, dataPrincipalId: opts.principal, limit, cursor: opts.cursor })}`,
      );
      printTable(
        res.grievances.map((g) => ({
          ID: g.grievanceId,
          REFERENCE: g.referenceNumber,
          PRINCIPAL: orDash(g.dataPrincipalId),
          TYPE: g.type,
          STATUS: g.status,
          DUE: shortDate(g.expectedResolutionBy),
        })),
        ['ID', 'REFERENCE', 'PRINCIPAL', 'TYPE', 'STATUS', 'DUE'],
        res.grievances.map((g) => ({ ...g })),
      );
      printPage(res);
    });

  grievances
    .command('update <grievanceId>')
    .description('Move a grievance to in_review, resolved or rejected')
    .addOption(
      new Option('--status <status>', 'New status').choices(GRIEVANCE_UPDATE_STATUSES).makeOptionMandatory(),
    )
    .option('--resolution <text>', 'Resolution (required for resolved and rejected)')
    .action(async (grievanceId: string, opts: { status: string; resolution?: string }) => {
      const final = opts.status === 'resolved' || opts.status === 'rejected';
      if (final && (opts.resolution === undefined || opts.resolution.trim() === '')) {
        fail(`--resolution is required when --status is ${opts.status}.`);
      }
      const { data: res } = await apiPatch<GrievanceResponse>(`/v1/dpdp/grievances/${seg(grievanceId)}`, {
        status: opts.status,
        ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
      });

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Grievance updated: ${res.grievanceId}`);
      printGrievance(res);
    });

  cmd.addCommand(grievances);

  // ── erasure ────────────────────────────────────────────────────────────
  // `dpdp erasure <principalId>` requests erasure and `dpdp erasure status
  // <requestId>` reads a request. For a principal whose ID is literally
  // "status" or "request", use `dpdp erasure request <principalId>`.
  const requestErasure = async (principalId: string) => {
    const { data: res, status } = await apiPost<ErasureResponse>(
      `/v1/dpdp/data-principals/${seg(principalId)}/erasure`,
    );

    if (isJsonMode()) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (status === 201) {
      console.log(chalk.green('✓') + ` Erasure completed: ${res.requestId}`);
    } else {
      // 200: nothing was left to erase; the server returns the earlier request.
      console.log(chalk.green('✓') + ` Nothing left to erase; earlier erasure request: ${res.requestId}`);
    }
    printErasure(res);
  };

  const erasure = new Command('erasure')
    .description("Erase a data principal's personal data (DPDP Act s.12)")
    .argument('[principalId]', 'Data principal ID')
    .action(async (principalId: string | undefined, _opts: unknown, self: Command) => {
      if (principalId === undefined) self.help({ error: true });
      await requestErasure(principalId);
    });

  erasure
    .command('request <principalId>')
    .description("Erase a data principal's personal data (same as `dpdp erasure <principalId>`)")
    .action(requestErasure);

  erasure
    .command('status <requestId>')
    .description('Get an erasure request')
    .action(async (requestId: string) => {
      const res = await apiGet<ErasureResponse>(`/v1/dpdp/erasure-requests/${seg(requestId)}`);
      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printErasure(res);
    });

  cmd.addCommand(erasure);

  // ── exports ────────────────────────────────────────────────────────────
  const exports_ = new Command('exports').description('Manage DPDP compliance exports');

  exports_
    .command('create')
    .description('Create a compliance export (JSON)')
    .requiredOption('--type <type>', 'Export type (dpdp-audit, gdpr-article-15, eu-ai-act-conformance)')
    .requiredOption('--date-from <iso>', 'Start (ISO 8601 date-time; YYYY-MM-DD means 00:00Z)')
    .requiredOption(
      '--date-to <iso>',
      'End (ISO 8601 date-time; YYYY-MM-DD means 00:00Z, so give an end-of-day time to include that day)',
    )
    .addOption(new Option('--format <format>', 'Export format (JSON only)').choices(['json']))
    .option('--include-action-log', 'Include the action log (server default)')
    .option('--no-include-action-log', 'Leave out the action log')
    .option('--include-consent-records', 'Include consent records (server default)')
    .option('--no-include-consent-records', 'Leave out consent records')
    .option('--principal-id <principalId>', 'Filter by data principal ID')
    .action(
      async (opts: {
        type: string;
        dateFrom: string;
        dateTo: string;
        format?: string;
        includeActionLog?: boolean;
        includeConsentRecords?: boolean;
        principalId?: string;
      }) => {
        const { data: res } = await apiPost<ExportResponse>('/v1/dpdp/exports', {
          type: opts.type,
          dateFrom: opts.dateFrom,
          dateTo: opts.dateTo,
          ...(opts.format !== undefined ? { format: opts.format } : {}),
          ...(opts.includeActionLog !== undefined ? { includeActionLog: opts.includeActionLog } : {}),
          ...(opts.includeConsentRecords !== undefined ? { includeConsentRecords: opts.includeConsentRecords } : {}),
          ...(opts.principalId !== undefined ? { dataPrincipalId: opts.principalId } : {}),
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Export created: ${res.exportId}`);
        printExport(res);
      },
    );

  exports_
    .command('get <exportId>')
    .description('Get an export and its data (an expired export returns 410 GONE)')
    .action(async (exportId: string) => {
      const res = await apiGet<ExportResponse>(`/v1/dpdp/exports/${seg(exportId)}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printExport(res);
    });

  cmd.addCommand(exports_);

  // ── principal-records ──────────────────────────────────────────────────
  cmd
    .command('principal-records <principalId>')
    .description('List all consent records for a data principal (right to access, DPDP Act s.11)')
    .option('--limit <n>', 'Page size, 1 to 200; without --limit or --cursor every record')
    .option('--cursor <cursor>', 'Cursor from the previous page (nextCursor)')
    .action(async (principalId: string, opts: { limit?: string; cursor?: string }) => {
      const limit = limitOf(opts.limit);
      const res = await apiGet<PrincipalRecordsResponse>(
        `/v1/dpdp/data-principals/${seg(principalId)}/records${query({ limit, cursor: opts.cursor })}`,
      );

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(`Data Principal: ${res.dataPrincipalId}  (${res.totalRecords} records)\n`);
      printTable(
        res.records.map((r) => ({
          ID: r.recordId,
          GRANT: r.grantId,
          STATUS: r.status,
          EXPIRES: shortDate(r.processingExpiresAt),
          CREATED: shortDate(r.createdAt),
        })),
        ['ID', 'GRANT', 'STATUS', 'EXPIRES', 'CREATED'],
        res.records.map((r) => ({ ...r })),
      );
      if (res.nextCursor) console.log(`Next cursor: ${res.nextCursor}`);
    });

  return cmd;
}

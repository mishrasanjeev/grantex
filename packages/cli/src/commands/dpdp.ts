import { Command } from 'commander';
import chalk from 'chalk';
import { defaultConfigPath, loadConfig, resolveConfig, type CliConfig } from '../config.js';
import { printTable, printRecord, shortDate, isJsonMode } from '../format.js';

// ── Internal HTTP helper ──────────────────────────────────────────────────

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

async function apiGet<T>(path: string): Promise<T> {
  const config = await getConfig();
  const safeBase = validateBaseUrl(config.baseUrl); // lgtm[js/file-access-to-http]
  const url = `${safeBase}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${String(config.apiKey)}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      body && typeof body === 'object' && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<{ data: T; status: number }> {
  const config = await getConfig();
  const safeBase = validateBaseUrl(config.baseUrl); // lgtm[js/file-access-to-http]
  const url = `${safeBase}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(config.apiKey)}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const respBody = await res.json().catch(() => null);
    const msg =
      respBody && typeof respBody === 'object' && 'message' in respBody
        ? String((respBody as Record<string, unknown>).message)
        : `HTTP ${res.status}`;
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
  const data = (await res.json()) as T;
  return { data, status: res.status };
}

// ── Types ─────────────────────────────────────────────────────────────────

interface ConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataFiduciaryName?: string;
  purposes: { code: string; description: string }[];
  scopes?: string[];
  consentNoticeId?: string;
  consentNoticeHash?: string;
  status: string;
  consentGivenAt?: string;
  processingExpiresAt: string;
  retentionUntil: string;
  accessCount?: number;
  withdrawnAt?: string | null;
  withdrawnReason?: string | null;
  consentProof?: Record<string, unknown>;
  createdAt: string;
}

interface WithdrawResponse {
  recordId: string;
  status: string;
  withdrawnAt: string;
  grantRevoked: boolean;
  dataDeleted: boolean;
}

interface NoticeResponse {
  id: string;
  noticeId: string;
  version: string;
  language: string;
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
  expectedResolutionBy: string;
  resolvedAt?: string | null;
  resolution?: string | null;
  createdAt: string;
}

interface ErasureResponse {
  requestId: string;
  dataPrincipalId: string;
  status: string;
  recordsErased: number;
  grantsRevoked: number;
  submittedAt: string;
  expectedCompletionBy: string;
}

interface ExportResponse {
  exportId: string;
  type: string;
  format: string;
  recordCount: number;
  data: Record<string, unknown>;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  expiresAt: string;
  createdAt: string;
}

interface PrincipalRecordsResponse {
  dataPrincipalId: string;
  records: ConsentRecord[];
  totalRecords: number;
}

// ── Command ───────────────────────────────────────────────────────────────

export function dpdpCommand(): Command {
  const cmd = new Command('dpdp').description(
    'India DPDP Act compliance — consent, grievances, erasure, and exports',
  );

  // ── consent ────────────────────────────────────────────────────────────
  const consent = new Command('consent').description('Manage DPDP consent records');

  consent
    .command('create')
    .description('Create a consent record')
    .requiredOption('--grant-id <grantId>', 'Grant ID')
    .requiredOption('--principal-id <principalId>', 'Data principal ID')
    .requiredOption('--notice-id <noticeId>', 'Consent notice ID')
    .requiredOption('--processing-expires-at <iso>', 'Processing expiration (ISO date)')
    .requiredOption('--purposes <json>', 'Purposes JSON array (e.g. [{"code":"marketing","description":"..."}])')
    .action(
      async (opts: {
        grantId: string;
        principalId: string;
        noticeId: string;
        processingExpiresAt: string;
        purposes: string;
      }) => {
        let purposes: { code: string; description: string }[];
        try {
          purposes = JSON.parse(opts.purposes) as { code: string; description: string }[];
        } catch {
          console.error('Error: --purposes must be valid JSON.');
          process.exit(1);
        }

        const { data: res } = await apiPost<ConsentRecord>('/v1/dpdp/consent-records', {
          grantId: opts.grantId,
          dataPrincipalId: opts.principalId,
          consentNoticeId: opts.noticeId,
          processingExpiresAt: opts.processingExpiresAt,
          purposes,
        });

        if (isJsonMode()) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(chalk.green('✓') + ` Consent record created: ${res.recordId}`);
        printRecord({
          recordId: res.recordId,
          grantId: res.grantId,
          dataPrincipalId: res.dataPrincipalId,
          status: res.status,
          processingExpiresAt: shortDate(res.processingExpiresAt),
          retentionUntil: shortDate(res.retentionUntil),
          createdAt: shortDate(res.createdAt),
        });
      },
    );

  consent
    .command('get <recordId>')
    .description('Get a consent record by ID')
    .action(async (recordId: string) => {
      const res = await apiGet<ConsentRecord>(`/v1/dpdp/consent-records/${recordId}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        recordId: res.recordId,
        grantId: res.grantId,
        dataPrincipalId: res.dataPrincipalId,
        status: res.status,
        processingExpiresAt: shortDate(res.processingExpiresAt),
        retentionUntil: shortDate(res.retentionUntil),
        withdrawnAt: res.withdrawnAt ? shortDate(res.withdrawnAt) : '\u2014',
        withdrawnReason: res.withdrawnReason ?? '\u2014',
        createdAt: shortDate(res.createdAt),
      });
    });

  consent
    .command('list')
    .description('List consent records')
    .option('--principal <principalId>', 'Filter by data principal ID')
    .action(async (opts: { principal?: string }) => {
      const query = opts.principal !== undefined ? `?dataPrincipalId=${encodeURIComponent(opts.principal)}` : '';
      const res = await apiGet<{ records: ConsentRecord[]; totalRecords: number }>(
        `/v1/dpdp/consent-records${query}`,
      );

      printTable(
        res.records.map((r) => ({
          ID: r.recordId,
          GRANT: r.grantId,
          PRINCIPAL: r.dataPrincipalId,
          STATUS: r.status,
          EXPIRES: shortDate(r.processingExpiresAt),
          CREATED: shortDate(r.createdAt),
        })),
        ['ID', 'GRANT', 'PRINCIPAL', 'STATUS', 'EXPIRES', 'CREATED'],
        res.records.map((r) => ({ ...r })),
      );
    });

  consent
    .command('withdraw <recordId>')
    .description('Withdraw consent for a record')
    .requiredOption('--reason <reason>', 'Reason for withdrawal')
    .option('--revoke-grant', 'Also revoke the underlying grant')
    .option('--delete-data', 'Delete processed data')
    .action(async (recordId: string, opts: { reason: string; revokeGrant?: boolean; deleteData?: boolean }) => {
      const { data: res } = await apiPost<WithdrawResponse>(
        `/v1/dpdp/consent-records/${recordId}/withdraw`,
        {
          reason: opts.reason,
          ...(opts.revokeGrant ? { revokeGrant: true } : {}),
          ...(opts.deleteData ? { deleteProcessedData: true } : {}),
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
        dataDeleted: String(res.dataDeleted),
      });
    });

  cmd.addCommand(consent);

  // ── notices ────────────────────────────────────────────────────────────
  const notices = new Command('notices').description('Manage DPDP consent notices');

  notices
    .command('create')
    .description('Create a consent notice')
    .requiredOption('--notice-id <noticeId>', 'Notice identifier')
    .requiredOption('--version <version>', 'Notice version')
    .requiredOption('--title <title>', 'Notice title')
    .requiredOption('--content <content>', 'Notice content text')
    .requiredOption('--purposes <json>', 'Purposes JSON array')
    .option('--language <lang>', 'Language code (default: en)')
    .option('--fiduciary-contact <contact>', 'Data fiduciary contact info')
    .option('--grievance-officer <json>', 'Grievance officer JSON (name, email, phone)')
    .action(
      async (opts: {
        noticeId: string;
        version: string;
        title: string;
        content: string;
        purposes: string;
        language?: string;
        fiduciaryContact?: string;
        grievanceOfficer?: string;
      }) => {
        let purposes: { code: string; description: string }[];
        try {
          purposes = JSON.parse(opts.purposes) as { code: string; description: string }[];
        } catch {
          console.error('Error: --purposes must be valid JSON.');
          process.exit(1);
        }

        let grievanceOfficer: { name: string; email: string; phone?: string } | undefined;
        if (opts.grievanceOfficer !== undefined) {
          try {
            grievanceOfficer = JSON.parse(opts.grievanceOfficer) as { name: string; email: string; phone?: string };
          } catch {
            console.error('Error: --grievance-officer must be valid JSON.');
            process.exit(1);
          }
        }

        const { data: res } = await apiPost<NoticeResponse>('/v1/dpdp/consent-notices', {
          noticeId: opts.noticeId,
          version: opts.version,
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

  cmd.addCommand(notices);

  // ── grievances ─────────────────────────────────────────────────────────
  const grievances = new Command('grievances').description('Manage DPDP grievances');

  grievances
    .command('file')
    .description('File a grievance')
    .requiredOption('--principal-id <principalId>', 'Data principal ID')
    .requiredOption('--type <type>', 'Grievance type')
    .requiredOption('--description <desc>', 'Grievance description')
    .option('--record-id <recordId>', 'Related consent record ID')
    .option('--evidence <json>', 'Evidence JSON object')
    .action(
      async (opts: {
        principalId: string;
        type: string;
        description: string;
        recordId?: string;
        evidence?: string;
      }) => {
        let evidence: Record<string, unknown> | undefined;
        if (opts.evidence !== undefined) {
          try {
            evidence = JSON.parse(opts.evidence) as Record<string, unknown>;
          } catch {
            console.error('Error: --evidence must be valid JSON.');
            process.exit(1);
          }
        }

        const { data: res } = await apiPost<GrievanceResponse>('/v1/dpdp/grievances', {
          dataPrincipalId: opts.principalId,
          type: opts.type,
          description: opts.description,
          ...(opts.recordId !== undefined ? { recordId: opts.recordId } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
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
          expectedResolutionBy: shortDate(res.expectedResolutionBy),
          createdAt: shortDate(res.createdAt),
        });
      },
    );

  grievances
    .command('get <grievanceId>')
    .description('Get grievance status')
    .action(async (grievanceId: string) => {
      const res = await apiGet<GrievanceResponse>(`/v1/dpdp/grievances/${grievanceId}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        grievanceId: res.grievanceId,
        referenceNumber: res.referenceNumber,
        type: res.type,
        status: res.status,
        description: res.description ?? '',
        expectedResolutionBy: shortDate(res.expectedResolutionBy),
        resolvedAt: res.resolvedAt ? shortDate(res.resolvedAt) : '\u2014',
        resolution: res.resolution ?? '\u2014',
        createdAt: shortDate(res.createdAt),
      });
    });

  cmd.addCommand(grievances);

  // ── erasure ────────────────────────────────────────────────────────────
  cmd
    .command('erasure <principalId>')
    .description('Request data erasure for a data principal (DPDP Section 11)')
    .action(async (principalId: string) => {
      const { data: res } = await apiPost<ErasureResponse>(
        `/v1/dpdp/data-principals/${principalId}/erasure`,
        {},
      );

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(chalk.green('✓') + ` Erasure request completed: ${res.requestId}`);
      printRecord({
        requestId: res.requestId,
        dataPrincipalId: res.dataPrincipalId,
        status: res.status,
        recordsErased: String(res.recordsErased),
        grantsRevoked: String(res.grantsRevoked),
        submittedAt: shortDate(res.submittedAt),
        expectedCompletionBy: shortDate(res.expectedCompletionBy),
      });
    });

  // ── exports ────────────────────────────────────────────────────────────
  const exports_ = new Command('exports').description('Manage DPDP compliance exports');

  exports_
    .command('create')
    .description('Create a compliance export')
    .requiredOption('--type <type>', 'Export type (dpdp-audit, gdpr-article-15, eu-ai-act-conformance)')
    .requiredOption('--date-from <iso>', 'Start date (ISO)')
    .requiredOption('--date-to <iso>', 'End date (ISO)')
    .option('--format <format>', 'Export format (default: json)')
    .option('--include-action-log', 'Include action log')
    .option('--include-consent-records', 'Include consent records')
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
        printRecord({
          exportId: res.exportId,
          type: res.type,
          format: res.format,
          recordCount: String(res.recordCount),
          expiresAt: shortDate(res.expiresAt),
          createdAt: shortDate(res.createdAt),
        });
      },
    );

  exports_
    .command('get <exportId>')
    .description('Get export status and data')
    .action(async (exportId: string) => {
      const res = await apiGet<ExportResponse>(`/v1/dpdp/exports/${exportId}`);

      if (isJsonMode()) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      printRecord({
        exportId: res.exportId,
        type: res.type,
        format: res.format,
        status: res.status ?? 'completed',
        recordCount: String(res.recordCount),
        expiresAt: shortDate(res.expiresAt),
        createdAt: shortDate(res.createdAt),
      });
    });

  cmd.addCommand(exports_);

  // ── principal-records ──────────────────────────────────────────────────
  cmd
    .command('principal-records <principalId>')
    .description('List all consent records for a data principal (right to access)')
    .action(async (principalId: string) => {
      const res = await apiGet<PrincipalRecordsResponse>(
        `/v1/dpdp/data-principals/${principalId}/records`,
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
    });

  return cmd;
}

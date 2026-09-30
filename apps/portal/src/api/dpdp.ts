import { api } from './client';

// Types mirror the auth-service DPDP routes (apps/auth-service/src/routes/dpdp.ts).
// Fields that only some routes send are optional.

// ── Shared ─────────────────────────────────────────────────────────────────

export interface Purpose {
  code: string;
  description: string;
}

export type ConsentRecordStatus = 'active' | 'withdrawn' | 'expired' | 'erased';
export type GrievanceStatus = 'submitted' | 'in_review' | 'resolved' | 'rejected';

export interface PageParams {
  /** 1..200, server default 50. */
  limit?: number;
  /** The previous page's `nextCursor`. */
  cursor?: string;
}

function query(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const seg = encodeURIComponent;

// ── Consent records ────────────────────────────────────────────────────────

/** GET /v1/dpdp/consent-records/:id and list items. No consentProof or consentNoticeHash on reads. */
export interface ConsentRecord {
  recordId: string;
  grantId: string;
  /** Absent per record on older servers' principal-records route. */
  dataPrincipalId?: string;
  dataFiduciaryName: string;
  purposes: Purpose[];
  scopes: string[];
  consentNoticeId: string;
  /** Null for records written before notice versions were stored. */
  consentNoticeVersion: string | null;
  status: ConsentRecordStatus;
  consentGivenAt: string;
  processingExpiresAt: string;
  retentionUntil: string;
  accessCount: number;
  lastAccessedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  erasedAt: string | null;
  createdAt: string;
}

export interface CreateConsentRecordRequest {
  grantId: string;
  dataPrincipalId: string;
  purposes: Purpose[];
  consentNoticeId: string;
  consentNoticeVersion?: string;
  processingExpiresAt: string;
}

export interface ConsentProof {
  type: 'JWS-EdDSA';
  alg: 'EdDSA';
  kid: string | null;
  proofJwt: string;
  jwksUri: string;
  signedAt: string;
}

export interface CreateConsentRecordResponse {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  consentNoticeId: string;
  consentNoticeVersion: string | null;
  consentNoticeHash: string;
  consentProof: ConsentProof;
  processingExpiresAt: string;
  retentionUntil: string;
  status: 'active';
  createdAt: string;
}

export interface ListConsentRecordsParams extends PageParams {
  dataPrincipalId?: string;
}

export interface ConsentRecordPage {
  records: ConsentRecord[];
  totalRecords: number;
  nextCursor: string | null;
}

export interface WithdrawConsentRequest {
  reason: string;
  revokeGrant?: boolean;
  deleteProcessedData?: boolean;
}

export interface WithdrawConsentResponse {
  recordId: string;
  status: 'withdrawn';
  withdrawnAt: string;
  grantRevoked: boolean;
  dataDeleted: boolean;
  dataDeletionRequested: boolean;
}

export interface DataPrincipalRecordsResponse extends ConsentRecordPage {
  dataPrincipalId: string;
}

// ── Erasure ────────────────────────────────────────────────────────────────

export interface RetainedCategory {
  category: string;
  count?: number;
  reason: string;
}

export interface ErasureRequest {
  requestId: string;
  dataPrincipalId: string;
  status: 'completed';
  recordsErased: number;
  grantsRevoked: number;
  delegatedGrantsRevoked: number;
  grievancesRedacted: number;
  exportsDeleted: number;
  retained: RetainedCategory[];
  submittedAt: string;
  completedAt: string;
  /** Deprecated: equals completedAt. */
  expectedCompletionBy?: string;
}

// ── Consent notices ────────────────────────────────────────────────────────

/** POST /v1/dpdp/consent-notices response. */
export interface ConsentNotice {
  id: string;
  noticeId: string;
  version: string;
  language: string;
  contentHash: string;
  createdAt: string;
}

export interface ConsentNoticeSummary extends ConsentNotice {
  title: string;
}

export interface ConsentNoticePage {
  notices: ConsentNoticeSummary[];
  nextCursor: string | null;
}

export interface GrievanceOfficer {
  name: string;
  email: string;
  phone?: string;
}

export interface ConsentNoticeVersion {
  id: string;
  version: string;
  language: string;
  title: string;
  content: string;
  purposes: Purpose[];
  dataFiduciaryContact: string | null;
  grievanceOfficer: GrievanceOfficer | null;
  contentHash: string;
  createdAt: string;
}

export interface ConsentNoticeDetail {
  noticeId: string;
  /** Newest first. */
  versions: ConsentNoticeVersion[];
}

export interface CreateConsentNoticeRequest {
  noticeId: string;
  language?: string;
  version: string;
  title: string;
  content: string;
  purposes: Purpose[];
  dataFiduciaryContact?: string;
  grievanceOfficer?: GrievanceOfficer;
}

// ── Grievances ─────────────────────────────────────────────────────────────

/** List item: no description or evidence. */
export interface GrievanceSummary {
  grievanceId: string;
  dataPrincipalId: string;
  recordId: string | null;
  type: string;
  status: GrievanceStatus;
  referenceNumber: string;
  expectedResolutionBy: string;
  responsePeriodDays: number;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Grievance extends GrievanceSummary {
  description: string;
  evidence: Record<string, unknown>;
}

export interface GrievancePage {
  grievances: GrievanceSummary[];
  nextCursor: string | null;
}

export interface ListGrievancesParams extends PageParams {
  status?: GrievanceStatus;
  dataPrincipalId?: string;
}

export interface FileGrievanceRequest {
  dataPrincipalId: string;
  recordId?: string;
  /** Free text, up to 128 characters (e.g. 'consent-violation'). */
  type: string;
  description: string;
  evidence?: Record<string, unknown>;
  /** 1..90 days; the server defaults to 7. */
  responsePeriodDays?: number;
}

export interface FileGrievanceResponse {
  grievanceId: string;
  referenceNumber: string;
  type: string;
  status: 'submitted';
  responsePeriodDays: number;
  expectedResolutionBy: string;
  createdAt: string;
}

export interface UpdateGrievanceRequest {
  status: Exclude<GrievanceStatus, 'submitted'>;
  /** Required for resolved and rejected. */
  resolution?: string;
}

// ── Exports ────────────────────────────────────────────────────────────────

export type ExportType = 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';

export interface DpdpExport {
  exportId: string;
  type: ExportType;
  format: 'json';
  recordCount: number;
  truncated: boolean;
  auditLogLimit: number;
  dataPrincipalId: string | null;
  data: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  /** GET only. */
  dateFrom?: string;
  /** GET only. */
  dateTo?: string;
  /** GET only; always 'complete' (an expired export is 410 GONE). */
  status?: 'complete';
}

export interface CreateExportRequest {
  type: ExportType;
  /** ISO date-time. A bare YYYY-MM-DD means 00:00Z of that day. */
  dateFrom: string;
  /** ISO date-time. Send an end-of-day time to include the whole last day. */
  dateTo: string;
  format?: 'json';
  includeActionLog?: boolean;
  includeConsentRecords?: boolean;
  dataPrincipalId?: string;
}

// ── API functions ──────────────────────────────────────────────────────────

export function createConsentRecord(data: CreateConsentRecordRequest): Promise<CreateConsentRecordResponse> {
  return api.post<CreateConsentRecordResponse>('/v1/dpdp/consent-records', data);
}

export function getConsentRecord(recordId: string): Promise<ConsentRecord> {
  return api.get<ConsentRecord>(`/v1/dpdp/consent-records/${seg(recordId)}`);
}

export function listConsentRecords(params: ListConsentRecordsParams = {}): Promise<ConsentRecordPage> {
  return api.get<ConsentRecordPage>(
    `/v1/dpdp/consent-records${query({ dataPrincipalId: params.dataPrincipalId, limit: params.limit, cursor: params.cursor })}`,
  );
}

export function withdrawConsent(recordId: string, data: WithdrawConsentRequest): Promise<WithdrawConsentResponse> {
  return api.post<WithdrawConsentResponse>(`/v1/dpdp/consent-records/${seg(recordId)}/withdraw`, data);
}

export function getDataPrincipalRecords(principalId: string, params: PageParams = {}): Promise<DataPrincipalRecordsResponse> {
  return api.get<DataPrincipalRecordsResponse>(
    `/v1/dpdp/data-principals/${seg(principalId)}/records${query({ limit: params.limit, cursor: params.cursor })}`,
  );
}

/** Erases a data principal. Takes no body; repeating it returns the earlier request. */
export function requestErasure(principalId: string): Promise<ErasureRequest> {
  return api.post<ErasureRequest>(`/v1/dpdp/data-principals/${seg(principalId)}/erasure`);
}

export function getErasureRequest(requestId: string): Promise<ErasureRequest> {
  return api.get<ErasureRequest>(`/v1/dpdp/erasure-requests/${seg(requestId)}`);
}

export function createConsentNotice(data: CreateConsentNoticeRequest): Promise<ConsentNotice> {
  return api.post<ConsentNotice>('/v1/dpdp/consent-notices', data);
}

export function listConsentNotices(params: PageParams = {}): Promise<ConsentNoticePage> {
  return api.get<ConsentNoticePage>(`/v1/dpdp/consent-notices${query({ limit: params.limit, cursor: params.cursor })}`);
}

export function getConsentNotice(noticeId: string): Promise<ConsentNoticeDetail> {
  return api.get<ConsentNoticeDetail>(`/v1/dpdp/consent-notices/${seg(noticeId)}`);
}

export function fileGrievance(data: FileGrievanceRequest): Promise<FileGrievanceResponse> {
  return api.post<FileGrievanceResponse>('/v1/dpdp/grievances', data);
}

export function listGrievances(params: ListGrievancesParams = {}): Promise<GrievancePage> {
  return api.get<GrievancePage>(
    `/v1/dpdp/grievances${query({
      status: params.status,
      dataPrincipalId: params.dataPrincipalId,
      limit: params.limit,
      cursor: params.cursor,
    })}`,
  );
}

export function getGrievance(grievanceId: string): Promise<Grievance> {
  return api.get<Grievance>(`/v1/dpdp/grievances/${seg(grievanceId)}`);
}

export function updateGrievance(grievanceId: string, data: UpdateGrievanceRequest): Promise<Grievance> {
  return api.patch<Grievance>(`/v1/dpdp/grievances/${seg(grievanceId)}`, data);
}

export function createExport(data: CreateExportRequest): Promise<DpdpExport> {
  return api.post<DpdpExport>('/v1/dpdp/exports', data);
}

export function getExport(exportId: string): Promise<DpdpExport> {
  return api.get<DpdpExport>(`/v1/dpdp/exports/${seg(exportId)}`);
}

import { api } from './client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataFiduciaryName: string;
  purposes: { code: string; description: string }[];
  scopes: string[];
  consentNoticeId: string;
  consentNoticeHash: string;
  consentProof: Record<string, unknown>;
  status: 'active' | 'withdrawn' | 'expired';
  consentGivenAt: string;
  processingExpiresAt: string;
  retentionUntil: string;
  accessCount: number;
  lastAccessedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  createdAt: string;
}

export interface CreateConsentRecordRequest {
  grantId: string;
  dataPrincipalId: string;
  purposes: { code: string; description: string }[];
  consentNoticeId: string;
  processingExpiresAt: string;
}

export interface CreateConsentRecordResponse {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  consentNoticeHash: string;
  consentProof: Record<string, unknown>;
  processingExpiresAt: string;
  retentionUntil: string;
  status: string;
  createdAt: string;
}

export interface WithdrawConsentRequest {
  reason: string;
  revokeGrant?: boolean;
  deleteProcessedData?: boolean;
}

export interface WithdrawConsentResponse {
  recordId: string;
  status: string;
  withdrawnAt: string;
  grantRevoked: boolean;
  dataDeleted: boolean;
}

export interface DataPrincipalRecordsResponse {
  dataPrincipalId: string;
  records: ConsentRecord[];
  totalRecords: number;
}

export interface ConsentNotice {
  id: string;
  noticeId: string;
  version: string;
  language: string;
  contentHash: string;
  createdAt: string;
}

export interface CreateConsentNoticeRequest {
  noticeId: string;
  language?: string;
  version: string;
  title: string;
  content: string;
  purposes: { code: string; description: string }[];
  dataFiduciaryContact?: string;
  grievanceOfficer?: { name: string; email: string; phone?: string };
}

export interface Grievance {
  grievanceId: string;
  dataPrincipalId: string;
  recordId: string | null;
  type: string;
  description: string;
  evidence: Record<string, unknown>;
  status: 'submitted' | 'in-progress' | 'resolved' | 'rejected';
  referenceNumber: string;
  expectedResolutionBy: string;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

export interface FileGrievanceRequest {
  dataPrincipalId: string;
  recordId?: string;
  type: string;
  description: string;
  evidence?: Record<string, unknown>;
}

export interface FileGrievanceResponse {
  grievanceId: string;
  referenceNumber: string;
  type: string;
  status: string;
  expectedResolutionBy: string;
  createdAt: string;
}

export interface DpdpExport {
  exportId: string;
  type: string;
  format: string;
  recordCount: number;
  data: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

export interface CreateExportRequest {
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  dateFrom: string;
  dateTo: string;
  format?: string;
  includeActionLog?: boolean;
  includeConsentRecords?: boolean;
  dataPrincipalId?: string;
}

// ── API functions ──────────────────────────────────────────────────────────

export function createConsentRecord(data: CreateConsentRecordRequest): Promise<CreateConsentRecordResponse> {
  return api.post<CreateConsentRecordResponse>('/v1/dpdp/consent-records', data);
}

export function withdrawConsent(recordId: string, data: WithdrawConsentRequest): Promise<WithdrawConsentResponse> {
  return api.post<WithdrawConsentResponse>(`/v1/dpdp/consent-records/${encodeURIComponent(recordId)}/withdraw`, data);
}

export function getDataPrincipalRecords(principalId: string): Promise<DataPrincipalRecordsResponse> {
  return api.get<DataPrincipalRecordsResponse>(`/v1/dpdp/data-principals/${encodeURIComponent(principalId)}/records`);
}

export function createConsentNotice(data: CreateConsentNoticeRequest): Promise<ConsentNotice> {
  return api.post<ConsentNotice>('/v1/dpdp/consent-notices', data);
}

export function fileGrievance(data: FileGrievanceRequest): Promise<FileGrievanceResponse> {
  return api.post<FileGrievanceResponse>('/v1/dpdp/grievances', data);
}

export function getGrievance(grievanceId: string): Promise<Grievance> {
  return api.get<Grievance>(`/v1/dpdp/grievances/${encodeURIComponent(grievanceId)}`);
}

export function createExport(data: CreateExportRequest): Promise<DpdpExport> {
  return api.post<DpdpExport>('/v1/dpdp/exports', data);
}

export function getExport(exportId: string): Promise<DpdpExport> {
  return api.get<DpdpExport>(`/v1/dpdp/exports/${encodeURIComponent(exportId)}`);
}

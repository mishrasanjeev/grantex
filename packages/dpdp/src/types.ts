/**
 * DPDP Act 2023 & EU AI Act compliance types for AI agents.
 */

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface DPDPConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataPrincipalDID?: string;
  dataFiduciaryId: string;
  dataFiduciaryName: string;
  purposes: ConsentPurpose[];
  scopes: string[];
  consentNoticeId: string;
  consentNoticeHash: string;
  consentGivenAt: Date;
  consentMethod: 'explicit-click' | 'api-delegated';
  processingExpiresAt: Date;
  retentionUntil: Date;
  consentProof: ConsentProof;
  status: 'active' | 'withdrawn' | 'expired';
  withdrawnAt?: Date;
  withdrawnReason?: string;
  lastAccessedAt?: Date;
  accessCount: number;
  actions: ConsentAction[];
}

export interface ConsentPurpose {
  purposeId: string;
  name: string;
  description: string;
  legalBasis: 'consent' | 'legitimate-interest' | 'contract';
  dataCategories: string[];
  retentionPeriod: string;
  thirdPartySharing: boolean;
  thirdParties?: string[];
}

export interface ConsentProof {
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  signedAt: Date;
  signature: string;
}

export interface ConsentAction {
  actionId: string;
  timestamp: Date;
  action: string;
  agentId: string;
  result: string;
  metadata?: Record<string, unknown>;
}

export interface ConsentNotice {
  noticeId: string;
  language: string;
  version: string;
  title: string;
  content: string;
  purposes: ConsentPurpose[];
  dataFiduciaryContact: string;
  grievanceOfficer?: GrievanceOfficer;
  contentHash: string;
}

export interface GrievanceOfficer {
  name: string;
  email: string;
  address?: string;
}

// ---------------------------------------------------------------------------
// Consent record creation options
// ---------------------------------------------------------------------------

export interface CreateConsentRecordOptions {
  grantId: string;
  dataPrincipalId: string;
  dataPrincipalDID?: string;
  dataFiduciaryId: string;
  dataFiduciaryName: string;
  purposes: ConsentPurpose[];
  scopes: string[];
  consentNoticeId: string;
  consentNoticeContent: string;
  consentMethod: 'explicit-click' | 'api-delegated';
  processingExpiresAt: Date;
  retentionUntil: Date;
  proofIpAddress?: string;
  proofUserAgent?: string;
  proofSessionId?: string;
  /** Ed25519 private key for signing the consent proof (Web Crypto CryptoKey). */
  signingKey?: unknown;
  apiKey: string;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Consent notice creation options
// ---------------------------------------------------------------------------

export interface CreateConsentNoticeOptions {
  language: string;
  version: string;
  title: string;
  content: string;
  purposes: ConsentPurpose[];
  dataFiduciaryContact: string;
  grievanceOfficer?: GrievanceOfficer;
  apiKey: string;
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Withdrawal
// ---------------------------------------------------------------------------

export interface WithdrawConsentOptions {
  revokeGrant?: boolean;
  deleteProcessedData?: boolean;
  apiKey: string;
  baseUrl: string;
}

export interface WithdrawalConfirmation {
  recordId: string;
  status: 'withdrawn';
  withdrawnAt: Date;
  grantRevoked: boolean;
  dataDeleted: boolean;
}

// ---------------------------------------------------------------------------
// Grievance
// ---------------------------------------------------------------------------

export interface Grievance {
  grievanceId: string;
  dataPrincipalId: string;
  recordId: string;
  type: 'unauthorized_processing' | 'withdrawal_refused' | 'data_breach' | 'other';
  description: string;
  evidence?: GrievanceEvidence;
  status: 'submitted' | 'under_review' | 'resolved' | 'escalated';
  referenceNumber: string;
  expectedResolutionBy: Date;
  resolvedAt?: Date;
  resolution?: string;
}

export interface GrievanceEvidence {
  auditEntries?: string[];
}

export interface FileGrievanceParams {
  dataPrincipalId: string;
  recordId: string;
  type: 'unauthorized_processing' | 'withdrawal_refused' | 'data_breach' | 'other';
  description: string;
  evidence?: GrievanceEvidence;
}

// ---------------------------------------------------------------------------
// Compliance export
// ---------------------------------------------------------------------------

export interface ComplianceExportRequest {
  type: 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';
  dateFrom: Date;
  dateTo: Date;
  format: 'json' | 'csv';
  includeActionLog: boolean;
  includeConsentRecords: boolean;
  dataPrincipalId?: string;
}

export interface ComplianceExportResult {
  exportId: string;
  type: string;
  status: 'complete';
  recordCount: number;
  data: unknown;
  downloadUrl?: string;
  downloadExpiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

export interface RegionConfig {
  regionCode: string;
  regionName: string;
  dataResidencyRequired: boolean;
  consentMinAge: number;
  grievanceResolutionDays: number;
  defaultLanguage: string;
  supportedLanguages: string[];
  regulatoryAuthority: string;
  regulatoryUrl: string;
}

// ---------------------------------------------------------------------------
// Purpose registry
// ---------------------------------------------------------------------------

export interface RegisteredPurpose {
  purposeId: string;
  name: string;
  description: string;
  requiredScopes: string[];
  legalBasis: 'consent' | 'legitimate-interest' | 'contract';
  dataCategories: string[];
  retentionPeriod: string;
  thirdPartySharing: boolean;
  thirdParties?: string[];
}

// ---------------------------------------------------------------------------
// Data principal rights
// ---------------------------------------------------------------------------

export interface DataPrincipalRecords {
  dataPrincipalId: string;
  records: DPDPConsentRecord[];
  totalCount: number;
}

export interface ErasureRequest {
  requestId: string;
  dataPrincipalId: string;
  status: 'submitted' | 'processing' | 'completed';
  submittedAt: Date;
  expectedCompletionBy: Date;
}

// ---------------------------------------------------------------------------
// API response wrapper (used internally for HTTP calls)
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

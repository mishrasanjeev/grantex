/**
 * DPDP Act 2023 & EU AI Act compliance types for AI agents.
 *
 * Decoded response types follow one convention: a field the server sends as
 * `null`, or that a route does not send, is omitted from the decoded object
 * (so it is typed optional). Timestamps are decoded to `Date`.
 */

// ---------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------

/**
 * A processing purpose as the Grantex auth service stores and returns it:
 * `{ code, description }`. This is the wire shape of every `purposes` array.
 */
export interface WirePurpose {
  code: string;
  description: string;
}

/**
 * The richer local purpose model used by `PurposeRegistry` and local
 * compliance checks.
 *
 * On the wire it is sent as `{ code: purposeId, description }`. The other fields
 * (`name`, `legalBasis`, `dataCategories`, `retentionPeriod`, `thirdPartySharing`,
 * `thirdParties`) are local-only: they are never sent and the server does not
 * store them.
 */
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

/** A purpose accepted as input: the wire shape, or the local model (mapped to the wire shape when sent). */
export type PurposeInput = WirePurpose | ConsentPurpose;

// ---------------------------------------------------------------------------
// Consent records
// ---------------------------------------------------------------------------

/** Consent record status values the server produces. */
export type ConsentRecordStatus = 'active' | 'withdrawn' | 'expired' | 'erased';

/**
 * A consent record as returned by `GET /v1/dpdp/consent-records/:id`, the
 * consent-records list and the data-principal records route. These reads carry
 * no consent proof and no notice hash; those come only from
 * `createConsentRecord`.
 */
export interface DPDPConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  dataFiduciaryName?: string;
  purposes: WirePurpose[];
  scopes: string[];
  consentNoticeId: string;
  /** Absent on records written before notice versions were recorded. */
  consentNoticeVersion?: string;
  status: ConsentRecordStatus;
  consentGivenAt: Date;
  processingExpiresAt: Date;
  retentionUntil: Date;
  accessCount: number;
  lastAccessedAt?: Date;
  withdrawnAt?: Date;
  withdrawnReason?: string;
  erasedAt?: Date;
  createdAt?: Date;
}

/**
 * The consent proof the server signs when a record is created: a compact JWS
 * (EdDSA) verifiable against the server's JWKS.
 */
export interface ConsentProof {
  type: 'JWS-EdDSA';
  alg: string;
  /** Key id of the signing key; null when the server's key has no id. */
  kid: string | null;
  proofJwt: string;
  jwksUri: string;
  signedAt: Date;
}

/**
 * Evidence computed on the client and returned to the caller only. None of it
 * is sent to the server; keep it in your own records if you need it.
 */
export interface LocalConsentEvidence {
  /** SHA-256 (hex) of `proofIpAddress`. The raw address is never kept or sent. */
  ipAddressHash?: string;
  userAgent?: string;
  sessionId?: string;
  /** SHA-256 (hex) of `consentNoticeContent`. */
  consentNoticeHash?: string;
  /** The canonical JSON that `signature` covers (present when `signingKey` was given). */
  signedPayload?: string;
  /** Base64 Ed25519 signature over `signedPayload` with your `signingKey`. */
  signature?: string;
}

/** The `201` response of `POST /v1/dpdp/consent-records`, decoded. */
export interface CreatedConsentRecord {
  recordId: string;
  grantId: string;
  dataPrincipalId: string;
  consentNoticeId: string;
  consentNoticeVersion?: string;
  /** SHA-256 (hex) of the notice version the consent was given against, computed by the server. */
  consentNoticeHash: string;
  consentProof: ConsentProof;
  processingExpiresAt: Date;
  retentionUntil: Date;
  status: ConsentRecordStatus;
  createdAt: Date;
  /** Client-side evidence; present only when local-only inputs were given. Never sent. */
  localEvidence?: LocalConsentEvidence;
}

/**
 * @deprecated The server does not return per-record actions. Kept so existing
 * imports compile.
 */
export interface ConsentAction {
  actionId: string;
  timestamp: Date;
  action: string;
  agentId: string;
  result: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Consent record creation options
// ---------------------------------------------------------------------------

export interface CreateConsentRecordOptions {
  grantId: string;
  dataPrincipalId: string;
  /** 1 to 50 purposes; sent as `{ code, description }`. */
  purposes: PurposeInput[];
  consentNoticeId: string;
  /** The notice version shown to the principal; the server uses the latest version when omitted. */
  consentNoticeVersion?: string;
  /** Must be in the future. */
  processingExpiresAt: Date;
  apiKey: string;
  baseUrl: string;

  // Local-only inputs: never sent. They feed `localEvidence` on the result.

  /** Local-only: hashed (SHA-256) into `localEvidence.ipAddressHash`. Never sent. */
  proofIpAddress?: string;
  /** Local-only: copied to `localEvidence.userAgent`. Never sent. */
  proofUserAgent?: string;
  /** Local-only: copied to `localEvidence.sessionId`. Never sent. */
  proofSessionId?: string;
  /** Local-only: hashed into `localEvidence.consentNoticeHash`. Never sent; the server hashes the stored notice. */
  consentNoticeContent?: string;
  /** Local-only: Ed25519 private key (Web Crypto CryptoKey) that signs `localEvidence.signedPayload`. The server signs its own proof. */
  signingKey?: unknown;

  /** @deprecated Not sent; the server does not read it. Included in `localEvidence.signedPayload` when signing. */
  dataFiduciaryId?: string;
  /** @deprecated Not sent; the server does not read it. */
  dataFiduciaryName?: string;
  /** @deprecated Not sent; the server takes the scopes from the grant. Included in `localEvidence.signedPayload` when signing. */
  scopes?: string[];
  /** @deprecated Not sent; the server does not read it. */
  dataPrincipalDID?: string;
  /** @deprecated Not sent; the server does not read it. */
  consentMethod?: 'explicit-click' | 'api-delegated';
  /** @deprecated Not sent; the server computes `retentionUntil`. */
  retentionUntil?: Date;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/** Page request for list routes: `limit` 1..200 (server default 50); `cursor` is the previous page's `nextCursor`. */
export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface ListConsentRecordsOptions extends PageOptions {
  dataPrincipalId?: string;
}

export interface ConsentRecordPage {
  records: DPDPConsentRecord[];
  totalRecords: number;
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Consent notices
// ---------------------------------------------------------------------------

/** The grievance officer published in a notice. */
export interface GrievanceOfficer {
  name: string;
  email: string;
  phone?: string;
  /** @deprecated Not part of the server contract and not sent. Use `phone` for a contact number. */
  address?: string;
}

/**
 * A consent notice as defined locally, for `validateNotice`.
 * `contentHash` is computed by `computeNoticeHash`.
 */
export interface ConsentNotice {
  noticeId: string;
  language: string;
  version: string;
  title: string;
  content: string;
  purposes: PurposeInput[];
  dataFiduciaryContact: string;
  grievanceOfficer?: GrievanceOfficer;
  contentHash: string;
}

export interface CreateConsentNoticeOptions {
  /** Your notice's stable id; each call registers one version of it. */
  noticeId: string;
  version: string;
  /** Defaults to 'en' on the server. */
  language?: string;
  title: string;
  content: string;
  purposes: PurposeInput[];
  /**
   * Contact for the data fiduciary. Optional on the server; this library
   * requires it because a notice must say how to reach the fiduciary
   * (DPDP Act s.5, DPDP Rules 2025 r.3).
   */
  dataFiduciaryContact: string;
  grievanceOfficer?: GrievanceOfficer;
  apiKey: string;
  baseUrl: string;
}

/** The `201` response of `POST /v1/dpdp/consent-notices`, decoded. */
export interface ConsentNoticeCreated {
  /** The id of this stored version. */
  id: string;
  noticeId: string;
  version: string;
  language: string;
  /** SHA-256 (hex) of `content`, computed by the server. */
  contentHash: string;
  createdAt: Date;
}

export interface ConsentNoticeSummary {
  id: string;
  noticeId: string;
  version: string;
  language: string;
  title: string;
  contentHash: string;
  createdAt: Date;
}

export interface ConsentNoticePage {
  notices: ConsentNoticeSummary[];
  nextCursor: string | null;
}

export interface ConsentNoticeVersion {
  id: string;
  version: string;
  language: string;
  title: string;
  content: string;
  purposes: WirePurpose[];
  dataFiduciaryContact?: string;
  grievanceOfficer?: GrievanceOfficer;
  contentHash: string;
  createdAt: Date;
}

/** Every version of one notice, newest first. */
export interface ConsentNoticeVersions {
  noticeId: string;
  versions: ConsentNoticeVersion[];
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
  /** Always false: Grantex does not hold the processed data. See `dataDeletionRequested`. */
  dataDeleted: boolean;
  /** True when deletion of processed data was requested (the fiduciary carries it out). */
  dataDeletionRequested?: boolean;
}

// ---------------------------------------------------------------------------
// Grievance
// ---------------------------------------------------------------------------

/** Grievance status values the server produces. */
export type GrievanceStatus = 'submitted' | 'in_review' | 'resolved' | 'rejected';

/**
 * Suggested grievance types. The server accepts any string up to 128
 * characters, so a type outside this list (including the older underscore
 * forms such as 'unauthorized_processing') is sent as given.
 */
export const GRIEVANCE_TYPES = {
  CONSENT_VIOLATION: 'consent-violation',
  DATA_BREACH: 'data-breach',
  UNAUTHORIZED_PROCESSING: 'unauthorized-processing',
  WITHDRAWAL_REFUSED: 'withdrawal-refused',
  OTHER: 'other',
} as const;

export type KnownGrievanceType = (typeof GRIEVANCE_TYPES)[keyof typeof GRIEVANCE_TYPES];

/** A grievance type: one of `GRIEVANCE_TYPES` or any other string. */
export type GrievanceType = KnownGrievanceType | (string & Record<never, never>);

/** Evidence attached to a grievance: any JSON object up to 16 KiB. */
export interface GrievanceEvidence {
  auditEntries?: string[];
  [key: string]: unknown;
}

/** A grievance as `GET` / `PATCH /v1/dpdp/grievances/:id` return it. */
export interface Grievance {
  grievanceId: string;
  dataPrincipalId: string;
  recordId?: string;
  type: GrievanceType;
  description: string;
  evidence?: GrievanceEvidence;
  status: GrievanceStatus;
  referenceNumber: string;
  expectedResolutionBy: Date;
  responsePeriodDays?: number;
  resolvedAt?: Date;
  resolution?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A grievance in a list: no description or evidence. */
export type GrievanceSummary = Omit<Grievance, 'description' | 'evidence'>;

/** The `202` response of `POST /v1/dpdp/grievances`, decoded. */
export interface GrievanceReceipt {
  grievanceId: string;
  referenceNumber: string;
  type: GrievanceType;
  status: GrievanceStatus;
  responsePeriodDays: number;
  expectedResolutionBy: Date;
  createdAt: Date;
}

export interface FileGrievanceParams {
  dataPrincipalId: string;
  /** Optional: the consent record the grievance is about (must belong to the principal). */
  recordId?: string;
  type: GrievanceType;
  description: string;
  evidence?: GrievanceEvidence;
  /**
   * Days to respond, an integer 1..90. The server default is 7, a product
   * default rather than a statutory period. Use the period you publish; DPDP
   * Rules 2025 r.14(3) caps it at 90 days.
   */
  responsePeriodDays?: number;
}

export interface ListGrievancesOptions extends PageOptions {
  status?: GrievanceStatus;
  dataPrincipalId?: string;
}

export interface GrievancePage {
  grievances: GrievanceSummary[];
  nextCursor: string | null;
}

export interface UpdateGrievanceParams {
  /** submitted -> in_review -> resolved | rejected. */
  status: 'in_review' | 'resolved' | 'rejected';
  /** Required for resolved and rejected. */
  resolution?: string;
}

// ---------------------------------------------------------------------------
// Compliance export
// ---------------------------------------------------------------------------

export type ComplianceExportType = 'dpdp-audit' | 'gdpr-article-15' | 'eu-ai-act-conformance';

export interface ComplianceExportRequest {
  type: ComplianceExportType;
  dateFrom: Date;
  /** Sent as a full ISO date-time, so the given instant (not midnight) bounds the range. */
  dateTo: Date;
  /** Only JSON is produced. */
  format?: 'json';
  /** Server default: true. */
  includeActionLog?: boolean;
  /** Server default: true. */
  includeConsentRecords?: boolean;
  dataPrincipalId?: string;
}

/**
 * An export, as `POST /v1/dpdp/exports` (201) and `GET /v1/dpdp/exports/:id`
 * (200) return it. `status`, `dateFrom` and `dateTo` are sent only by the GET.
 * There is no download URL: the data is inline in `data`.
 */
export interface ComplianceExportResult {
  exportId: string;
  type: ComplianceExportType;
  format: 'json';
  /** GET only; always 'complete' (an expired export is a 410, see `ExportExpiredError`). */
  status?: 'complete' | 'expired';
  dateFrom?: Date;
  dateTo?: Date;
  recordCount: number;
  /** True when the audit log hit `auditLogLimit` and was cut off. */
  truncated: boolean;
  auditLogLimit?: number;
  dataPrincipalId?: string;
  data: unknown;
  expiresAt: Date;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Region
// ---------------------------------------------------------------------------

export interface RegionConfig {
  regionCode: string;
  regionName: string;
  /** Whether the law requires personal data to be stored in the region. */
  dataResidencyRequired: boolean;
  /** Age of digital consent where one value applies; where it varies, the highest value. */
  consentMinAge: number;
  /** Age of digital consent across the region's jurisdictions. */
  consentMinAgeRange?: { min: number; max: number };
  /** The longest period, in days, the law allows for responding to a grievance or request. */
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
  totalRecords: number;
  /** @deprecated Use `totalRecords` (same value). */
  totalCount: number;
  nextCursor: string | null;
}

/** One category an erasure kept, and why. */
export interface ErasureRetention {
  category: string;
  count?: number;
  reason: string;
}

/** An erasure request, as the erasure POST and `GET /v1/dpdp/erasure-requests/:id` return it. */
export interface ErasureRequest {
  requestId: string;
  dataPrincipalId: string;
  /** Erasure completes synchronously. */
  status: 'completed';
  recordsErased: number;
  grantsRevoked: number;
  delegatedGrantsRevoked: number;
  grievancesRedacted: number;
  exportsDeleted: number;
  retained: ErasureRetention[];
  submittedAt: Date;
  completedAt?: Date;
  /** @deprecated Equal to `completedAt`. */
  expectedCompletionBy?: Date;
}

/** The result of `requestDataErasure`. */
export interface ErasureResult extends ErasureRequest {
  /** 201 when something was erased now; 200 when an earlier completed request was returned. */
  httpStatus: 200 | 201;
  /** True for 201. */
  created: boolean;
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

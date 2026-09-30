/**
 * @grantex/dpdp — DPDP Act 2023 & EU AI Act compliance module for AI agents.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  DPDPConsentRecord,
  ConsentRecordStatus,
  WirePurpose,
  ConsentPurpose,
  PurposeInput,
  ConsentProof,
  ConsentAction,
  CreatedConsentRecord,
  LocalConsentEvidence,
  ConsentNotice,
  ConsentNoticeCreated,
  ConsentNoticeSummary,
  ConsentNoticePage,
  ConsentNoticeVersion,
  ConsentNoticeVersions,
  GrievanceOfficer,
  CreateConsentRecordOptions,
  CreateConsentNoticeOptions,
  PageOptions,
  ListConsentRecordsOptions,
  ConsentRecordPage,
  WithdrawConsentOptions,
  WithdrawalConfirmation,
  Grievance,
  GrievanceSummary,
  GrievanceReceipt,
  GrievanceStatus,
  GrievanceType,
  KnownGrievanceType,
  GrievanceEvidence,
  FileGrievanceParams,
  ListGrievancesOptions,
  GrievancePage,
  UpdateGrievanceParams,
  ComplianceExportType,
  ComplianceExportRequest,
  ComplianceExportResult,
  RegionConfig,
  RegisteredPurpose,
  DataPrincipalRecords,
  ErasureRequest,
  ErasureResult,
  ErasureRetention,
} from './types.js';

export { GRIEVANCE_TYPES } from './types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  DpdpError,
  ConsentRequiredError,
  PurposeViolationError,
  WithdrawalError,
  GrievanceError,
  ExportError,
  ExportExpiredError,
} from './errors.js';
export type { DpdpErrorDetails } from './errors.js';

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export {
  createConsentRecord,
  getConsentRecord,
  listConsentRecords,
  listConsentRecordsPage,
} from './consent/consent-record.js';

export { ConsentRegistry } from './consent/consent-registry.js';
export type { ConsentRegistryStats } from './consent/consent-registry.js';

export {
  createConsentNotice,
  listConsentNotices,
  getConsentNotice,
  validateNotice,
  computeNoticeHash,
} from './consent/consent-notice.js';

export { withdrawConsent } from './consent/withdrawal.js';

// ---------------------------------------------------------------------------
// Purpose
// ---------------------------------------------------------------------------

export { PurposeRegistry } from './purpose/purpose-registry.js';

export { toWirePurpose } from './purpose/wire.js';

export {
  enforcePurpose,
  checkPurposeCompliance,
} from './purpose/purpose-enforcer.js';

// ---------------------------------------------------------------------------
// Data Principal Rights
// ---------------------------------------------------------------------------

export {
  getDataPrincipalRecords,
  requestDataErasure,
  getErasureRequest,
} from './data-principal/rights-api.js';

export {
  fileGrievance,
  getGrievanceStatus,
  listGrievances,
  updateGrievance,
  generateReferenceNumber,
  calculateExpectedResolution,
} from './data-principal/grievance.js';

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  requestDpdpExport,
  getExportStatus,
} from './export/dpdp-export.js';

export { requestGdprExport } from './export/gdpr-export.js';

export {
  requestEuAiActExport,
  EU_AI_ACT_ARTICLES,
} from './export/eu-ai-act-export.js';

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

export {
  REGION_IN,
  REGION_EU,
  REGIONS,
  getRegion,
} from './localization/regions.js';

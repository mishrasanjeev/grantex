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
  ConsentPurpose,
  ConsentProof,
  ConsentAction,
  ConsentNotice,
  GrievanceOfficer,
  CreateConsentRecordOptions,
  CreateConsentNoticeOptions,
  WithdrawConsentOptions,
  WithdrawalConfirmation,
  Grievance,
  GrievanceEvidence,
  FileGrievanceParams,
  ComplianceExportRequest,
  ComplianceExportResult,
  RegionConfig,
  RegisteredPurpose,
  DataPrincipalRecords,
  ErasureRequest,
} from './types.js';

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
} from './errors.js';

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export {
  createConsentRecord,
  getConsentRecord,
  listConsentRecords,
} from './consent/consent-record.js';

export { ConsentRegistry } from './consent/consent-registry.js';
export type { ConsentRegistryStats } from './consent/consent-registry.js';

export {
  createConsentNotice,
  validateNotice,
  computeNoticeHash,
} from './consent/consent-notice.js';

export { withdrawConsent } from './consent/withdrawal.js';

// ---------------------------------------------------------------------------
// Purpose
// ---------------------------------------------------------------------------

export { PurposeRegistry } from './purpose/purpose-registry.js';

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
} from './data-principal/rights-api.js';

export {
  fileGrievance,
  getGrievanceStatus,
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

/**
 * Decoders from server JSON to the package's types. Null or absent fields are
 * omitted; timestamps become Dates (never Invalid Date).
 */

import type {
  DPDPConsentRecord,
  Grievance,
  GrievanceSummary,
  GrievanceOfficer,
  WirePurpose,
  ErasureRequest,
  ComplianceExportResult,
} from './types.js';
import { asObject, opt, str, num, toDate, type Raw } from './http.js';

export function decodePurposes(value: unknown): WirePurpose[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => {
    const o = asObject(p);
    return { code: String(o.code ?? ''), description: String(o.description ?? '') };
  });
}

export function decodeConsentRecord(value: unknown, fallbackPrincipalId?: string): DPDPConsentRecord {
  const raw = asObject(value);
  return {
    recordId: raw.recordId as string,
    grantId: raw.grantId as string,
    dataPrincipalId: (str(raw.dataPrincipalId) ?? fallbackPrincipalId) as string,
    ...opt('dataFiduciaryName', str(raw.dataFiduciaryName)),
    purposes: decodePurposes(raw.purposes),
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    consentNoticeId: raw.consentNoticeId as string,
    ...opt('consentNoticeVersion', str(raw.consentNoticeVersion)),
    status: raw.status as DPDPConsentRecord['status'],
    consentGivenAt: toDate(raw.consentGivenAt) as Date,
    processingExpiresAt: toDate(raw.processingExpiresAt) as Date,
    retentionUntil: toDate(raw.retentionUntil) as Date,
    accessCount: num(raw.accessCount) ?? 0,
    ...opt('lastAccessedAt', toDate(raw.lastAccessedAt)),
    ...opt('withdrawnAt', toDate(raw.withdrawnAt)),
    ...opt('withdrawnReason', str(raw.withdrawnReason)),
    ...opt('erasedAt', toDate(raw.erasedAt)),
    ...opt('createdAt', toDate(raw.createdAt)),
  };
}

export function decodeGrievanceOfficer(value: unknown): GrievanceOfficer | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const o = value as Raw;
  return {
    name: o.name as string,
    email: o.email as string,
    ...opt('phone', str(o.phone)),
  };
}

export function decodeGrievanceSummary(value: unknown): GrievanceSummary {
  const raw = asObject(value);
  return {
    grievanceId: raw.grievanceId as string,
    dataPrincipalId: raw.dataPrincipalId as string,
    ...opt('recordId', str(raw.recordId)),
    type: raw.type as string,
    status: raw.status as Grievance['status'],
    referenceNumber: raw.referenceNumber as string,
    expectedResolutionBy: toDate(raw.expectedResolutionBy) as Date,
    ...opt('responsePeriodDays', num(raw.responsePeriodDays)),
    ...opt('resolvedAt', toDate(raw.resolvedAt)),
    ...opt('resolution', str(raw.resolution)),
    ...opt('createdAt', toDate(raw.createdAt)),
    ...opt('updatedAt', toDate(raw.updatedAt)),
  };
}

export function decodeGrievance(value: unknown): Grievance {
  const raw = asObject(value);
  const summary = decodeGrievanceSummary(raw);
  const evidence = raw.evidence !== null && typeof raw.evidence === 'object'
    ? (raw.evidence as Grievance['evidence'])
    : undefined;
  // Keep the server's key order: description and evidence follow type.
  const { grievanceId, dataPrincipalId, recordId, type, ...rest } = summary;
  return {
    grievanceId,
    dataPrincipalId,
    ...opt('recordId', recordId),
    type,
    description: raw.description as string,
    ...opt('evidence', evidence),
    ...rest,
  };
}

export function decodeErasure(value: unknown): ErasureRequest {
  const raw = asObject(value);
  return {
    requestId: raw.requestId as string,
    dataPrincipalId: raw.dataPrincipalId as string,
    status: raw.status as ErasureRequest['status'],
    recordsErased: num(raw.recordsErased) ?? 0,
    grantsRevoked: num(raw.grantsRevoked) ?? 0,
    delegatedGrantsRevoked: num(raw.delegatedGrantsRevoked) ?? 0,
    grievancesRedacted: num(raw.grievancesRedacted) ?? 0,
    exportsDeleted: num(raw.exportsDeleted) ?? 0,
    retained: Array.isArray(raw.retained) ? (raw.retained as ErasureRequest['retained']) : [],
    submittedAt: toDate(raw.submittedAt) as Date,
    ...opt('completedAt', toDate(raw.completedAt)),
    ...opt('expectedCompletionBy', toDate(raw.expectedCompletionBy)),
  };
}

export function decodeExport(value: unknown): ComplianceExportResult {
  const raw = asObject(value);
  return {
    exportId: raw.exportId as string,
    type: raw.type as ComplianceExportResult['type'],
    ...opt('dateFrom', toDate(raw.dateFrom)),
    ...opt('dateTo', toDate(raw.dateTo)),
    format: (str(raw.format) ?? 'json') as 'json',
    ...opt('status', str(raw.status) as ComplianceExportResult['status']),
    recordCount: num(raw.recordCount) ?? 0,
    truncated: raw.truncated === true,
    ...opt('auditLogLimit', num(raw.auditLogLimit)),
    ...opt('dataPrincipalId', str(raw.dataPrincipalId)),
    data: raw.data,
    expiresAt: toDate(raw.expiresAt) as Date,
    createdAt: toDate(raw.createdAt) as Date,
  };
}

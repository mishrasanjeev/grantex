/**
 * Consent record creation and retrieval.
 *
 * DPDP Act 2023, Sections 5-6 (Consent & Notice).
 */

import type {
  CreateConsentRecordOptions,
  DPDPConsentRecord,
} from '../types.js';
import { ConsentRequiredError, DpdpError } from '../errors.js';
import { computeNoticeHash } from './consent-notice.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashIpAddress(ip: string): string {
  // We compute a simple hex-encoded SHA-256 hash synchronously using the
  // Web Crypto API. Because `crypto.subtle.digest` is async we provide a
  // sync fallback using Node's built-in crypto module which is available in
  // Node 18+.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(ip).digest('hex');
}

async function signRecord(
  payload: string,
  signingKey: unknown,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    signingKey as Parameters<typeof crypto.subtle.sign>[1],
    data,
  );
  return Buffer.from(sig).toString('base64');
}

function buildSignaturePayload(
  opts: CreateConsentRecordOptions,
  noticeHash: string,
  consentGivenAt: Date,
): string {
  return JSON.stringify({
    grantId: opts.grantId,
    dataPrincipalId: opts.dataPrincipalId,
    dataFiduciaryId: opts.dataFiduciaryId,
    purposes: opts.purposes.map((p) => p.purposeId),
    scopes: opts.scopes,
    consentNoticeHash: noticeHash,
    consentGivenAt: consentGivenAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePurposes(purposes: CreateConsentRecordOptions['purposes']): void {
  if (!purposes || purposes.length === 0) {
    throw new ConsentRequiredError('At least one purpose is required');
  }

  for (const p of purposes) {
    const missing: string[] = [];
    if (!p.purposeId) missing.push('purposeId');
    if (!p.name) missing.push('name');
    if (!p.description) missing.push('description');
    if (!p.legalBasis) missing.push('legalBasis');
    if (!p.dataCategories || p.dataCategories.length === 0) missing.push('dataCategories');
    if (!p.retentionPeriod) missing.push('retentionPeriod');
    if (p.thirdPartySharing === undefined) missing.push('thirdPartySharing');

    if (missing.length > 0) {
      throw new DpdpError(
        `Purpose "${p.purposeId || '(unnamed)'}" is missing mandatory fields: ${missing.join(', ')}`,
        'INVALID_PURPOSE',
        400,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a DPDP consent record linked to a Grantex grant token.
 *
 * The record is persisted server-side via `POST /v1/dpdp/consent-records`
 * and includes an Ed25519 signature over the canonical payload.
 */
export async function createConsentRecord(
  opts: CreateConsentRecordOptions,
): Promise<DPDPConsentRecord> {
  validatePurposes(opts.purposes);

  const consentGivenAt = new Date();
  const noticeHash = await computeNoticeHash(opts.consentNoticeContent);

  // Build the signature payload
  const payload = buildSignaturePayload(opts, noticeHash, consentGivenAt);

  let signature = '';
  if (opts.signingKey) {
    signature = await signRecord(payload, opts.signingKey);
  }

  const body = {
    grantId: opts.grantId,
    dataPrincipalId: opts.dataPrincipalId,
    ...(opts.dataPrincipalDID !== undefined ? { dataPrincipalDID: opts.dataPrincipalDID } : {}),
    dataFiduciaryId: opts.dataFiduciaryId,
    dataFiduciaryName: opts.dataFiduciaryName,
    purposes: opts.purposes,
    scopes: opts.scopes,
    consentNoticeId: opts.consentNoticeId,
    consentNoticeHash: noticeHash,
    consentGivenAt: consentGivenAt.toISOString(),
    consentMethod: opts.consentMethod,
    processingExpiresAt: opts.processingExpiresAt.toISOString(),
    retentionUntil: opts.retentionUntil.toISOString(),
    consentProof: {
      ...(opts.proofIpAddress !== undefined
        ? { ipAddress: hashIpAddress(opts.proofIpAddress) }
        : {}),
      ...(opts.proofUserAgent !== undefined ? { userAgent: opts.proofUserAgent } : {}),
      ...(opts.proofSessionId !== undefined ? { sessionId: opts.proofSessionId } : {}),
      signedAt: consentGivenAt.toISOString(),
      signature,
    },
  };

  const res = await fetch(`${opts.baseUrl}/v1/dpdp/consent-records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new DpdpError(
      (errBody.message as string) ?? `Failed to create consent record (${res.status})`,
      'CREATE_FAILED',
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return deserializeRecord(data);
}

/**
 * Fetch a single consent record by ID.
 */
export async function getConsentRecord(
  recordId: string,
  apiKey: string,
  baseUrl: string,
): Promise<DPDPConsentRecord> {
  const res = await fetch(`${baseUrl}/v1/dpdp/consent-records/${recordId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new DpdpError(
      `Failed to get consent record ${recordId} (${res.status})`,
      'GET_FAILED',
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;
  return deserializeRecord(data);
}

/**
 * List all consent records for a data principal.
 */
export async function listConsentRecords(
  principalId: string,
  apiKey: string,
  baseUrl: string,
): Promise<DPDPConsentRecord[]> {
  const res = await fetch(
    `${baseUrl}/v1/dpdp/consent-records?dataPrincipalId=${encodeURIComponent(principalId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  if (!res.ok) {
    throw new DpdpError(
      `Failed to list consent records (${res.status})`,
      'LIST_FAILED',
      res.status,
    );
  }

  const body = (await res.json()) as { records: Record<string, unknown>[] };
  return (body.records ?? []).map(deserializeRecord);
}

// ---------------------------------------------------------------------------
// Deserialization
// ---------------------------------------------------------------------------

function deserializeRecord(raw: Record<string, unknown>): DPDPConsentRecord {
  const proof = raw.consentProof as Record<string, unknown> | undefined;
  const actions = (raw.actions as Record<string, unknown>[] | undefined) ?? [];

  return {
    recordId: raw.recordId as string,
    grantId: raw.grantId as string,
    dataPrincipalId: raw.dataPrincipalId as string,
    ...(raw.dataPrincipalDID !== undefined
      ? { dataPrincipalDID: raw.dataPrincipalDID as string }
      : {}),
    dataFiduciaryId: raw.dataFiduciaryId as string,
    dataFiduciaryName: raw.dataFiduciaryName as string,
    purposes: raw.purposes as DPDPConsentRecord['purposes'],
    scopes: raw.scopes as string[],
    consentNoticeId: raw.consentNoticeId as string,
    consentNoticeHash: raw.consentNoticeHash as string,
    consentGivenAt: new Date(raw.consentGivenAt as string),
    consentMethod: raw.consentMethod as DPDPConsentRecord['consentMethod'],
    processingExpiresAt: new Date(raw.processingExpiresAt as string),
    retentionUntil: new Date(raw.retentionUntil as string),
    consentProof: {
      ...(proof?.ipAddress !== undefined ? { ipAddress: proof.ipAddress as string } : {}),
      ...(proof?.userAgent !== undefined ? { userAgent: proof.userAgent as string } : {}),
      ...(proof?.sessionId !== undefined ? { sessionId: proof.sessionId as string } : {}),
      signedAt: new Date((proof?.signedAt as string) ?? (raw.consentGivenAt as string)),
      signature: (proof?.signature as string) ?? '',
    },
    status: raw.status as DPDPConsentRecord['status'],
    ...(raw.withdrawnAt !== undefined ? { withdrawnAt: new Date(raw.withdrawnAt as string) } : {}),
    ...(raw.withdrawnReason !== undefined ? { withdrawnReason: raw.withdrawnReason as string } : {}),
    ...(raw.lastAccessedAt !== undefined
      ? { lastAccessedAt: new Date(raw.lastAccessedAt as string) }
      : {}),
    accessCount: (raw.accessCount as number) ?? 0,
    actions: actions.map((a) => ({
      actionId: a.actionId as string,
      timestamp: new Date(a.timestamp as string),
      action: a.action as string,
      agentId: a.agentId as string,
      result: a.result as string,
      ...(a.metadata !== undefined ? { metadata: a.metadata as Record<string, unknown> } : {}),
    })),
  };
}

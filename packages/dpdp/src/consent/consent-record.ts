/**
 * Consent record creation and retrieval.
 *
 * DPDP Act 2023, s.6 (consent) given against a notice under s.5.
 */

import { createHash } from 'node:crypto';
import type {
  ConsentRecordPage,
  CreateConsentRecordOptions,
  CreatedConsentRecord,
  DPDPConsentRecord,
  ListConsentRecordsOptions,
  LocalConsentEvidence,
} from '../types.js';
import { ConsentRequiredError, DpdpError } from '../errors.js';
import { computeNoticeHash } from './consent-notice.js';
import { asObject, dpdpRequest, dpdpUrl, nextCursorOf, num, opt, seg, str, toDate, type HttpFailure } from '../http.js';
import { decodeConsentRecord } from '../decode.js';
import { missingWireFields, purposeLabel, toWirePurpose } from '../purpose/wire.js';

const RECORDS = seg('consent-records');

function failure(fallback: string, code: string) {
  return (f: HttpFailure) =>
    new DpdpError(f.message ?? `${fallback} (${f.statusCode})`, f.code ?? code, f.statusCode, f.requestId);
}

// ---------------------------------------------------------------------------
// Local-only evidence
// ---------------------------------------------------------------------------

function hashIpAddress(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

async function signPayload(payload: string, signingKey: unknown): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: 'Ed25519' },
    signingKey as Parameters<typeof crypto.subtle.sign>[1],
    new TextEncoder().encode(payload),
  );
  return Buffer.from(sig).toString('base64');
}

/**
 * Evidence built on the client from the local-only options. Returned to the
 * caller; never sent to the server. Undefined when no local-only input was given.
 */
async function buildLocalEvidence(
  opts: CreateConsentRecordOptions,
): Promise<LocalConsentEvidence | undefined> {
  const evidence: LocalConsentEvidence = {
    ...opt('ipAddressHash', opts.proofIpAddress !== undefined ? hashIpAddress(opts.proofIpAddress) : undefined),
    ...opt('userAgent', opts.proofUserAgent),
    ...opt('sessionId', opts.proofSessionId),
    ...opt(
      'consentNoticeHash',
      opts.consentNoticeContent !== undefined ? await computeNoticeHash(opts.consentNoticeContent) : undefined,
    ),
  };

  if (opts.signingKey) {
    const signedPayload = JSON.stringify({
      grantId: opts.grantId,
      dataPrincipalId: opts.dataPrincipalId,
      ...opt('dataFiduciaryId', opts.dataFiduciaryId),
      purposes: opts.purposes.map((p) => toWirePurpose(p).code),
      ...opt('scopes', opts.scopes),
      consentNoticeId: opts.consentNoticeId,
      ...opt('consentNoticeVersion', opts.consentNoticeVersion),
      ...opt('consentNoticeHash', evidence.consentNoticeHash),
      processingExpiresAt: opts.processingExpiresAt.toISOString(),
      signedAt: new Date().toISOString(),
    });
    evidence.signedPayload = signedPayload;
    evidence.signature = await signPayload(signedPayload, opts.signingKey);
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePurposes(purposes: CreateConsentRecordOptions['purposes']): void {
  if (!purposes || purposes.length === 0) {
    throw new ConsentRequiredError('At least one purpose is required');
  }

  for (const p of purposes) {
    const missing = missingWireFields(p);
    if (missing.length > 0) {
      const label = purposeLabel(p);
      throw new DpdpError(
        `Purpose "${label === '?' ? '(unnamed)' : label}" is missing mandatory fields: ${missing.join(', ')}`,
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
 * Create a DPDP consent record linked to a Grantex grant.
 *
 * `POST /v1/dpdp/consent-records` with `{ grantId, dataPrincipalId, purposes,
 * consentNoticeId, consentNoticeVersion?, processingExpiresAt }`. The server
 * hashes the notice version and signs the consent proof (a JWS, EdDSA); the
 * result carries both. Local-only options (IP address, user agent, session,
 * notice content, signing key) are never sent: they produce `localEvidence`.
 */
export async function createConsentRecord(
  opts: CreateConsentRecordOptions,
): Promise<CreatedConsentRecord> {
  validatePurposes(opts.purposes);

  const localEvidence = await buildLocalEvidence(opts);

  const body = {
    grantId: opts.grantId,
    dataPrincipalId: opts.dataPrincipalId,
    purposes: opts.purposes.map(toWirePurpose),
    consentNoticeId: opts.consentNoticeId,
    ...opt('consentNoticeVersion', opts.consentNoticeVersion),
    processingExpiresAt: opts.processingExpiresAt.toISOString(),
  };

  const { data } = await dpdpRequest(
    { method: 'POST', url: dpdpUrl(opts.baseUrl, [RECORDS]), apiKey: opts.apiKey, body },
    failure('Failed to create consent record', 'CREATE_FAILED'),
  );

  const raw = asObject(data);
  const proof = asObject(raw.consentProof);
  return {
    recordId: raw.recordId as string,
    grantId: raw.grantId as string,
    dataPrincipalId: raw.dataPrincipalId as string,
    consentNoticeId: raw.consentNoticeId as string,
    ...opt('consentNoticeVersion', str(raw.consentNoticeVersion)),
    consentNoticeHash: raw.consentNoticeHash as string,
    consentProof: {
      type: proof.type as 'JWS-EdDSA',
      alg: proof.alg as string,
      kid: str(proof.kid) ?? null,
      proofJwt: proof.proofJwt as string,
      jwksUri: proof.jwksUri as string,
      signedAt: toDate(proof.signedAt) as Date,
    },
    processingExpiresAt: toDate(raw.processingExpiresAt) as Date,
    retentionUntil: toDate(raw.retentionUntil) as Date,
    status: raw.status as CreatedConsentRecord['status'],
    createdAt: toDate(raw.createdAt) as Date,
    ...opt('localEvidence', localEvidence),
  };
}

/**
 * Fetch a single consent record by ID.
 *
 * `GET /v1/dpdp/consent-records/:recordId`
 */
export async function getConsentRecord(
  recordId: string,
  apiKey: string,
  baseUrl: string,
): Promise<DPDPConsentRecord> {
  const { data } = await dpdpRequest(
    { method: 'GET', url: dpdpUrl(baseUrl, [RECORDS, recordId]), apiKey },
    failure(`Failed to get consent record ${recordId}`, 'GET_FAILED'),
  );
  return decodeConsentRecord(data);
}

/**
 * List consent records, newest first, optionally for one data principal.
 *
 * `GET /v1/dpdp/consent-records?dataPrincipalId=&limit=&cursor=`
 */
export async function listConsentRecordsPage(
  options: ListConsentRecordsOptions,
  apiKey: string,
  baseUrl: string,
): Promise<ConsentRecordPage> {
  const { data } = await dpdpRequest(
    {
      method: 'GET',
      url: dpdpUrl(baseUrl, [RECORDS], {
        dataPrincipalId: options.dataPrincipalId,
        limit: options.limit,
        cursor: options.cursor,
      }),
      apiKey,
    },
    failure('Failed to list consent records', 'LIST_FAILED'),
  );
  const raw = asObject(data);
  const records = Array.isArray(raw.records) ? raw.records : [];
  return {
    records: records.map((r) => decodeConsentRecord(r)),
    totalRecords: num(raw.totalRecords) ?? records.length,
    nextCursor: nextCursorOf(raw),
  };
}

/**
 * List one page of consent records for a data principal (the first page unless
 * `page.cursor` is given). Use {@link listConsentRecordsPage} for `totalRecords`
 * and `nextCursor`.
 */
export async function listConsentRecords(
  principalId: string,
  apiKey: string,
  baseUrl: string,
  page: { limit?: number; cursor?: string } = {},
): Promise<DPDPConsentRecord[]> {
  const result = await listConsentRecordsPage({ dataPrincipalId: principalId, ...page }, apiKey, baseUrl);
  return result.records;
}

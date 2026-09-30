import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { config } from '../config.js';
import { getSql, type TxSql } from '../db/client.js';
import {
  newConsentRecordId,
  newNoticeId,
  newGrievanceId,
  newExportId,
  newGrievanceReference,
  newErasureRequestId,
} from '../lib/ids.js';
import { getEdKeyPair, signWithEd25519 } from '../lib/crypto.js';
import { emitEvent } from '../lib/events.js';
import { appendPlatformAuditEntries, lockAuditChain, type PlatformAuditEntry } from '../lib/audit-chain.js';
import { publishGrantRevocation, revokeGrantInTx, type RevokedGrantTree } from '../lib/revoke.js';
import { noticeHash, noticeHashOfRow, noticeValidation } from '../lib/dpdp-notice.js';
import { CanonicalizationError } from '../lib/decisions/canonical.js';
import { ARTICLE15_RECORD_LIMIT, euAiActSections, gdprArticle15, sectionsSummary } from '../lib/dpdp-evidence.js';

// ── Limits ─────────────────────────────────────────────────────────────────

export const MAX_ID = 256;
export const MAX_CODE = 128;
export const MAX_SHORT_TEXT = 1_000;
export const MAX_LONG_TEXT = 5_000;
const MAX_NOTICE_CONTENT = 100_000;
const MAX_PURPOSES = 50;
const MAX_EVIDENCE_BYTES = 16_384;
/** Rows of the audit log an export carries; `truncated` says when there were more. */
export const EXPORT_AUDIT_LOG_LIMIT = 1_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DEFAULT_RESPONSE_PERIOD_DAYS = 7;
/** DPDP Rules 2025 r.14(3): a published grievance response period may not exceed 90 days. */
const MAX_RESPONSE_PERIOD_DAYS = 90;
const EXPORT_LIFETIME_MS = 7 * 86_400_000;

/** What replaces a grievance's free text when its data principal is erased. */
export const ERASED_TEXT_MARKER = '[erased at the request of the data principal]';

const GRIEVANCE_STATUSES = ['submitted', 'in_review', 'resolved', 'rejected'] as const;
type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];
/** submitted -> in_review -> resolved | rejected; nothing leaves resolved or rejected. */
const GRIEVANCE_TRANSITIONS: Record<Exclude<GrievanceStatus, 'submitted'>, GrievanceStatus[]> = {
  in_review: ['submitted'],
  resolved: ['in_review'],
  rejected: ['in_review'],
};

/**
 * eu-ai-act-evidence is the structured EU AI Act pack (lib/dpdp-evidence.ts);
 * eu-ai-act-conformance keeps its generic keys and gains the same sections.
 */
const EXPORT_TYPES = ['dpdp-audit', 'gdpr-article-15', 'eu-ai-act-conformance', 'eu-ai-act-evidence'] as const;
const EXPORT_FORMATS = ['json'] as const;

/** Reserved (`grantex.`) audit actions: a tenant cannot write them through POST /v1/audit/log. */
export const DPDP_AUDIT_ACTIONS = {
  consentCreated: 'grantex.dpdp.consent_created',
  consentWithdrawn: 'grantex.dpdp.consent_withdrawn',
  consentExpired: 'grantex.dpdp.consent_expired',
  erasureCompleted: 'grantex.dpdp.erasure_completed',
  grievanceFiled: 'grantex.dpdp.grievance_filed',
  grievanceUpdated: 'grantex.dpdp.grievance_updated',
  noticeCreated: 'grantex.dpdp.notice_created',
  exportCreated: 'grantex.dpdp.export_created',
} as const;

// ── Validation ─────────────────────────────────────────────────────────────

export class InputError extends Error {
  constructor(message: string, readonly code = 'BAD_REQUEST') {
    super(message);
  }
}

export type Body = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireBody(value: unknown): Body {
  if (!isPlainObject(value)) throw new InputError('Request body must be a JSON object');
  return value;
}

export function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new InputError(`${field} is required and must be a non-empty string`);
  if (value.length > max) throw new InputError(`${field} must be at most ${max} characters`);
  return value;
}

export function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, max);
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new InputError(`${field} must be a boolean`);
  return value;
}

interface Purpose { code: string; description: string }

function requirePurposes(value: unknown): Purpose[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError('purposes must be a non-empty array of { code, description }');
  }
  if (value.length > MAX_PURPOSES) throw new InputError(`purposes must have at most ${MAX_PURPOSES} entries`);
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw new InputError(`purposes[${index}] must be an object { code, description }`);
    return {
      code: requireString(item['code'], `purposes[${index}].code`, MAX_CODE),
      description: requireString(item['description'], `purposes[${index}].description`, MAX_SHORT_TEXT),
    };
  });
}

/** An RFC 3339 date-time (as Date.toISOString() writes it, with or without fractional seconds or an offset). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireDate(value: unknown, field: string, options: { dateOnly?: boolean } = {}): Date {
  if (typeof value !== 'string' || !(ISO_DATE_TIME.test(value) || (options.dateOnly && ISO_DATE.test(value)))) {
    throw new InputError(`${field} must be an ISO 8601 date-time`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InputError(`${field} must be a valid date`);
  return date;
}

export interface PageRequest { limit: number; cursor: { t: string; id: string } | null }

export function parsePage(query: Record<string, unknown>): PageRequest {
  let limit = DEFAULT_PAGE_SIZE;
  if (query['limit'] !== undefined) {
    const raw = String(query['limit']);
    if (!/^\d+$/.test(raw)) throw new InputError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    limit = Number(raw);
    if (limit < 1 || limit > MAX_PAGE_SIZE) throw new InputError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  let cursor: PageRequest['cursor'] = null;
  if (query['cursor'] !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(String(query['cursor']), 'base64url').toString('utf8')) as unknown;
      if (!isPlainObject(decoded) || typeof decoded['t'] !== 'string' || typeof decoded['id'] !== 'string'
          || decoded['id'].length > MAX_ID || Number.isNaN(new Date(decoded['t']).getTime())) {
        throw new Error('shape');
      }
      cursor = { t: decoded['t'], id: decoded['id'] };
    } catch {
      throw new InputError('cursor is not valid; pass the nextCursor of a previous page');
    }
  }
  return { limit, cursor };
}

/** The cursor after the last row of a page, or null when there is no further page. */
export function nextCursor(rows: Record<string, unknown>[], limit: number): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1]!;
  // created_at_cursor is created_at as text, so the cursor keeps Postgres's
  // microseconds and a page boundary inside one millisecond loses nothing.
  return Buffer.from(JSON.stringify({ t: last['created_at_cursor'], id: last['id'] }), 'utf8').toString('base64url');
}

export function sendError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.status(status).send({ message, code, requestId: request.id });
}

/** Run `parse`; an InputError becomes a 400 and `undefined` is returned. */
export function parseOr400<T>(reply: FastifyReply, request: FastifyRequest, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (err) {
    if (err instanceof InputError) {
      void sendError(reply, request, 400, err.code, err.message);
      return undefined;
    }
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
}

/**
 * A JSONB parameter. Passing JSON.stringify(value) instead stores a JSON
 * *string* (the driver encodes the string again), which is what these routes
 * used to do; migration 127 repairs the rows written that way.
 */
export function json(tx: TxSql, value: unknown) {
  return tx.json(value as postgres.JSONValue);
}

/** Append platform entries to the developer's audit chain, inside the caller's transaction. */
export async function appendDpdpAudit(tx: TxSql, developerId: string, entries: PlatformAuditEntry[]): Promise<void> {
  const head = await lockAuditChain(tx, developerId);
  await appendPlatformAuditEntries(tx, developerId, head, entries);
}

function consentRecordResponse(r: Record<string, unknown>) {
  return {
    recordId: r['id'],
    grantId: r['grant_id'],
    dataPrincipalId: r['data_principal_id'],
    dataFiduciaryName: r['data_fiduciary_name'],
    purposes: r['purposes'],
    scopes: r['scopes'],
    consentNoticeId: r['consent_notice_id'],
    consentNoticeVersion: r['consent_notice_version'] ?? null,
    consentNoticeLanguage: r['consent_notice_language'] ?? null,
    // null for records made before the notice hash was kept.
    noticeHash: r['notice_hash'] ?? null,
    status: r['status'],
    consentGivenAt: r['consent_given_at'],
    processingExpiresAt: r['processing_expires_at'],
    retentionUntil: r['retention_until'],
    // Principal access is not tracked by these developer reads; the stored
    // values are returned as they are.
    accessCount: r['access_count'],
    lastAccessedAt: r['last_accessed_at'] ?? null,
    withdrawnAt: r['withdrawn_at'] ?? null,
    withdrawnReason: r['withdrawn_reason'] ?? null,
    erasedAt: r['erased_at'] ?? null,
    createdAt: r['created_at'],
  };
}

function grievanceResponse(g: Record<string, unknown>, options: { detail: boolean }) {
  return {
    grievanceId: g['id'],
    dataPrincipalId: g['data_principal_id'],
    recordId: g['record_id'] ?? null,
    type: g['type'],
    ...(options.detail ? { description: g['description'], evidence: g['evidence'] } : {}),
    status: g['status'],
    referenceNumber: g['reference_number'],
    expectedResolutionBy: g['expected_resolution_by'],
    responsePeriodDays: g['response_period_days'],
    resolvedAt: g['resolved_at'] ?? null,
    resolution: g['resolution'] ?? null,
    createdAt: g['created_at'],
    updatedAt: g['updated_at'] ?? null,
  };
}

function erasureResponse(row: Record<string, unknown>) {
  const completedAt = iso(row['completed_at']);
  return {
    requestId: row['id'],
    dataPrincipalId: row['data_principal_id'],
    status: row['status'],
    recordsErased: row['records_erased'],
    grantsRevoked: row['grants_revoked'],
    delegatedGrantsRevoked: row['delegated_grants_revoked'],
    grievancesRedacted: row['grievances_redacted'],
    exportsDeleted: row['exports_deleted'],
    retained: row['retained'],
    submittedAt: iso(row['submitted_at']),
    completedAt,
    // Deprecated: erasure completes synchronously, so this is completedAt.
    // It used to be seven days after submission while status already said
    // 'completed'.
    expectedCompletionBy: completedAt,
  };
}

/**
 * What an erasure keeps, and why. Grantex holds the consent artefacts and
 * logs, not the fiduciary's processed personal data.
 */
function retainedAfterErasure(recordCount: number, grievanceCount: number): Array<Record<string, unknown>> {
  return [
    {
      category: 'consent_records',
      count: recordCount,
      reason: 'Kept and marked erased, not deleted: the Data Fiduciary bears the burden of proving that consent '
        + 'was given (DPDP Act s.6(10)), and DPDP Rules 2025 r.8(3) require processing logs and associated data '
        + 'to be retained for at least one year.',
    },
    {
      category: 'audit_log',
      reason: 'Audit entries are neither modified nor deleted: DPDP Rules 2025 r.6(1)(e) and r.8(3) require logs '
        + 'to be retained for at least one year, and the entries form a tamper-evident hash chain.',
    },
    {
      category: 'grievances',
      count: grievanceCount,
      reason: 'Kept as the record of grievance handling (DPDP Act s.13), with the description and evidence '
        + 'replaced by a fixed marker.',
    },
    {
      category: 'fiduciary_data',
      reason: 'Grantex holds no personal data the Data Fiduciary processed under these consents; erasing it in '
        + "the fiduciary's own systems and its processors' (DPDP Act s.8(7)) remains the fiduciary's step.",
    },
  ];
}

const CONSENT_RECORD_COLUMNS = (sql: ReturnType<typeof getSql>) => sql`
  id, grant_id, data_principal_id, data_fiduciary_name, purposes, scopes,
  consent_notice_id, consent_notice_version, consent_notice_language, notice_hash, status, consent_given_at,
  processing_expires_at, retention_until, access_count, last_accessed_at,
  withdrawn_at, withdrawn_reason, erased_at, created_at, created_at::text AS created_at_cursor`;

// ── Notice structure (DPDP Act s.5; DPDP Rules 2025 r.3) ───────────────────

const MAX_URL = 2_048;
const MAX_NOTICE_ITEMS = 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optionalHttpUrl(value: unknown, field: string): string | null {
  const raw = optionalString(value, field, MAX_URL);
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`${field} must be an absolute http or https URL`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) {
    throw new InputError(`${field} must be an absolute http or https URL`);
  }
  return raw;
}

function optionalItems<T>(value: unknown, field: string, max: number, parse: (item: Body, index: number) => T): T[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new InputError(`${field} must be a non-empty array`);
  if (value.length > max) throw new InputError(`${field} must have at most ${max} entries`);
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw new InputError(`${field}[${index}] must be an object`);
    return parse(item, index);
  });
}

/** The optional structured notice fields; each is validated when present. */
function parseNoticeStructure(body: Body, purposes: Purpose[]) {
  const codes = new Set(purposes.map((p) => p.code));
  const contact = body['contact'];
  let parsedContact: Record<string, string> | null = null;
  if (contact !== undefined && contact !== null) {
    if (!isPlainObject(contact)) throw new InputError('contact must be an object { name?, designation?, email?, phone?, address? }');
    const entry = {
      name: optionalString(contact['name'], 'contact.name', MAX_CODE),
      designation: optionalString(contact['designation'], 'contact.designation', MAX_CODE),
      email: optionalString(contact['email'], 'contact.email', MAX_ID),
      phone: optionalString(contact['phone'], 'contact.phone', 64),
      address: optionalString(contact['address'], 'contact.address', MAX_SHORT_TEXT),
    };
    if (!entry.email && !entry.phone) throw new InputError('contact needs an email or a phone');
    if (entry.email && !EMAIL.test(entry.email)) throw new InputError('contact.email must be an email address');
    parsedContact = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as Record<string, string>;
  }
  return {
    itemisedPersonalData: optionalItems(body['itemisedPersonalData'], 'itemisedPersonalData', MAX_NOTICE_ITEMS, (item, i) => ({
      category: requireString(item['category'], `itemisedPersonalData[${i}].category`, MAX_CODE),
      description: requireString(item['description'], `itemisedPersonalData[${i}].description`, MAX_SHORT_TEXT),
    })),
    purposeDetails: optionalItems(body['purposeDetails'], 'purposeDetails', MAX_PURPOSES, (item, i) => {
      const code = requireString(item['code'], `purposeDetails[${i}].code`, MAX_CODE);
      if (!codes.has(code)) throw new InputError(`purposeDetails[${i}].code must be one of the notice's purposes codes`);
      return {
        code,
        description: requireString(item['description'], `purposeDetails[${i}].description`, MAX_SHORT_TEXT),
        goodsOrServices: requireString(item['goodsOrServices'], `purposeDetails[${i}].goodsOrServices`, MAX_SHORT_TEXT),
      };
    }),
    withdrawalUrl: optionalHttpUrl(body['withdrawalUrl'], 'withdrawalUrl'),
    rightsUrl: optionalHttpUrl(body['rightsUrl'], 'rightsUrl'),
    boardComplaintUrl: optionalHttpUrl(body['boardComplaintUrl'], 'boardComplaintUrl'),
    contact: parsedContact,
  };
}

const NOTICE_STRUCTURE_COLUMNS = (sql: ReturnType<typeof getSql>) => sql`
  itemised_personal_data, purpose_details, withdrawal_url, rights_url, board_complaint_url, contact`;

/** Every column the notice hash covers, with the stored hash and the content hash. */
const NOTICE_BIND_COLUMNS = (sql: ReturnType<typeof getSql>) => sql`
  id, notice_id, version, language, title, content, purposes, data_fiduciary_contact, grievance_officer,
  content_hash, notice_hash, ${NOTICE_STRUCTURE_COLUMNS(sql)}`;

/** The structured fields of a stored notice, and the r.3 check over them as they are now. */
function noticeStructureResponse(n: Record<string, unknown>) {
  const structure = {
    itemisedPersonalData: (n['itemised_personal_data'] as unknown[] | null) ?? null,
    purposeDetails: (n['purpose_details'] as unknown[] | null) ?? null,
    withdrawalUrl: (n['withdrawal_url'] as string | null) ?? null,
    rightsUrl: (n['rights_url'] as string | null) ?? null,
    boardComplaintUrl: (n['board_complaint_url'] as string | null) ?? null,
    contact: (n['contact'] as Record<string, unknown> | null) ?? null,
  };
  return {
    ...structure,
    validation: noticeValidation({ ...structure, language: n['language'] as string }, { enforced: config.dpdpNoticeRequireRule3 }),
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────

export async function dpdpRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/dpdp/consent-records — Create DPDP consent record
  app.post('/v1/dpdp/consent-records', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const processingExpiresAt = requireDate(body['processingExpiresAt'], 'processingExpiresAt');
      if (processingExpiresAt.getTime() <= Date.now()) throw new InputError('processingExpiresAt must be in the future');
      return {
        grantId: requireString(body['grantId'], 'grantId', MAX_ID),
        dataPrincipalId: requireString(body['dataPrincipalId'], 'dataPrincipalId', MAX_ID),
        purposes: requirePurposes(body['purposes']),
        consentNoticeId: requireString(body['consentNoticeId'], 'consentNoticeId', MAX_ID),
        consentNoticeVersion: optionalString(body['consentNoticeVersion'], 'consentNoticeVersion', MAX_CODE),
        consentNoticeLanguage: optionalString(body['consentNoticeLanguage'], 'consentNoticeLanguage', 35),
        processingExpiresAt,
      };
    });
    if (!input) return reply;
    const {
      grantId, dataPrincipalId, purposes, consentNoticeId, consentNoticeVersion, consentNoticeLanguage, processingExpiresAt,
    } = input;

    const sql = getSql();

    // The grant must be the developer's, active and unexpired: a consent
    // record over a grant that no longer authorises anything would record
    // consent for processing that cannot happen. Fail closed.
    const grantRows = await sql`
      SELECT id, scopes, principal_id, status, expires_at FROM grants
      WHERE id = ${grantId} AND developer_id = ${developerId}
    `;
    const grant = grantRows[0];
    if (!grant) return sendError(reply, request, 400, 'INVALID_GRANT', 'Grant not found or not owned by developer');
    if (grant['status'] !== 'active' || new Date(grant['expires_at'] as string).getTime() <= Date.now()) {
      return sendError(reply, request, 400, 'INVALID_GRANT', 'Grant is not active (revoked, suspended or expired)');
    }
    // The documented model: the data principal is the grant's principal (the
    // end user who gave consent). Enforced only under the flag, because
    // existing integrations may key their data principals differently.
    if (config.dpdpEnforceGrantPrincipal && grant['principal_id'] !== dataPrincipalId) {
      return sendError(reply, request, 400, 'PRINCIPAL_MISMATCH', "dataPrincipalId must be the grant's principal");
    }

    // The notice shown to the principal. With consentNoticeLanguage: the
    // pinned version in that language, or the newest notice row in that
    // language (a translation of an older version registered later does not
    // displace a newer version in this language). Without it: the pinned
    // version, or the version of the newest row of any language, as before
    // notices had several languages; the newest row of that version is bound
    // and its language recorded. Under DPDP_REQUIRE_NOTICE_LANGUAGE a version
    // in several languages needs consentNoticeLanguage instead, since each
    // language is its own text with its own hash.
    // Plain queries (no nested fragments), one per case.
    const noticeRows = consentNoticeLanguage !== undefined && consentNoticeVersion !== undefined
      ? await sql`
          SELECT id, notice_id, version, language, title, content, purposes, data_fiduciary_contact, grievance_officer,
                 content_hash, notice_hash, itemised_personal_data, purpose_details, withdrawal_url, rights_url,
                 board_complaint_url, contact
          FROM dpdp_consent_notices
          WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId}
            AND version = ${consentNoticeVersion} AND language = ${consentNoticeLanguage}
        `
      : consentNoticeLanguage !== undefined
        ? await sql`
            SELECT id, notice_id, version, language, title, content, purposes, data_fiduciary_contact, grievance_officer,
                   content_hash, notice_hash, itemised_personal_data, purpose_details, withdrawal_url, rights_url,
                   board_complaint_url, contact
            FROM dpdp_consent_notices
            WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId} AND language = ${consentNoticeLanguage}
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          `
        : consentNoticeVersion !== undefined
          ? await sql`
              SELECT id, notice_id, version, language, title, content, purposes, data_fiduciary_contact, grievance_officer,
                     content_hash, notice_hash, itemised_personal_data, purpose_details, withdrawal_url, rights_url,
                     board_complaint_url, contact
              FROM dpdp_consent_notices
              WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId} AND version = ${consentNoticeVersion}
              ORDER BY created_at DESC, id DESC
            `
          : await sql`
              SELECT id, notice_id, version, language, title, content, purposes, data_fiduciary_contact, grievance_officer,
                     content_hash, notice_hash, itemised_personal_data, purpose_details, withdrawal_url, rights_url,
                     board_complaint_url, contact
              FROM dpdp_consent_notices
              WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId}
                AND version = (
                  SELECT version FROM dpdp_consent_notices
                  WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId}
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1
                )
              ORDER BY created_at DESC, id DESC
            `;
    if (consentNoticeLanguage === undefined && noticeRows.length > 1 && config.dpdpRequireNoticeLanguage) {
      return sendError(reply, request, 400, 'NOTICE_LANGUAGE_REQUIRED',
        `The notice version exists in several languages (${noticeRows.map((row) => row['language'] as string).join(', ')}); pass consentNoticeLanguage`);
    }
    const notice = noticeRows[0];
    if (!notice) {
      let message = consentNoticeVersion !== undefined ? 'Consent notice version not found' : 'Consent notice not found';
      if (consentNoticeLanguage !== undefined) {
        // Say whether the notice (or version) exists in another language.
        const other = consentNoticeVersion !== undefined
          ? await sql`
              SELECT 1 FROM dpdp_consent_notices
              WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId} AND version = ${consentNoticeVersion}
              LIMIT 1
            `
          : await sql`
              SELECT 1 FROM dpdp_consent_notices
              WHERE notice_id = ${consentNoticeId} AND developer_id = ${developerId}
              LIMIT 1
            `;
        if (other.length > 0) {
          message = consentNoticeVersion !== undefined ? 'Consent notice version not found in this language'
            : 'Consent notice not found in this language';
        }
      }
      return sendError(reply, request, 400, 'INVALID_NOTICE', message);
    }

    const id = newConsentRecordId();
    const consentNoticeHash = notice['content_hash'] as string;
    const noticeVersion = notice['version'] as string;
    const noticeLanguage = (notice['language'] as string | undefined) ?? null;
    const boundNoticeHash = noticeHashOfRow(notice);
    const scopes = grant['scopes'] as string[];
    // Default retention: 30 days after processing expires
    const retentionUntil = new Date(processingExpiresAt.getTime() + 30 * 86400_000);
    const consentGivenAt = new Date();

    // The proof is evidence the fiduciary may need for as long as the record
    // is kept (DPDP Act s.6(10)), so it carries no exp. Without a signing key
    // no record is created: a record without its proof is not evidence.
    let proofJwt: string;
    try {
      proofJwt = await signWithEd25519({
        recordId: id,
        grantId,
        dataPrincipalId,
        consentNoticeId,
        consentNoticeVersion: noticeVersion,
        consentNoticeHash,
        // The whole notice (lib/dpdp-notice.ts noticeHash) and its language;
        // consentNoticeHash covers the text only.
        consentNoticeLanguage: noticeLanguage,
        noticeHash: boundNoticeHash,
        purposes: purposes.map((p) => p.code),
        consentGivenAt: consentGivenAt.toISOString(),
      }, { expiresInSeconds: null });
    } catch {
      return sendError(reply, request, 503, 'CONSENT_PROOF_UNAVAILABLE',
        'The consent proof could not be signed; no consent record was created');
    }
    const kid = getEdKeyPair()?.kid ?? null;
    const consentProof = {
      // A compact JWS (RFC 7515 §7.1) signed with EdDSA over Ed25519
      // (RFC 8037), verifiable with the key `kid` names in the JWKS.
      type: 'JWS-EdDSA',
      alg: 'EdDSA',
      kid,
      proofJwt,
      jwksUri: `${config.publicBaseUrl.replace(/\/$/, '')}/.well-known/jwks.json`,
      signedAt: consentGivenAt.toISOString(),
    };

    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`
        INSERT INTO dpdp_consent_records (
          id, developer_id, grant_id, data_principal_id,
          data_fiduciary_id, data_fiduciary_name,
          purposes, scopes, consent_notice_id, consent_notice_version, consent_notice_hash,
          consent_given_at, processing_expires_at, retention_until, consent_proof, consent_notice_language,
          notice_hash
        )
        VALUES (
          ${id}, ${developerId}, ${grantId}, ${dataPrincipalId},
          ${developerId}, ${request.developer.name ?? 'Unknown'},
          ${json(tx, purposes)}, ${scopes}, ${consentNoticeId}, ${noticeVersion}, ${consentNoticeHash},
          ${consentGivenAt}, ${processingExpiresAt}, ${retentionUntil}, ${json(tx, consentProof)}, ${noticeLanguage},
          ${boundNoticeHash}
        )
      `;
      await appendDpdpAudit(tx, developerId, [{
        action: DPDP_AUDIT_ACTIONS.consentCreated,
        grantId,
        metadata: {
          record_id: id, data_principal_id: dataPrincipalId,
          consent_notice_id: consentNoticeId, consent_notice_version: noticeVersion,
          consent_notice_language: noticeLanguage, notice_hash: boundNoticeHash,
          purposes: purposes.map((p) => p.code),
        },
      }]);
    });

    emitEvent(developerId, 'dpdp.consent.created', {
      recordId: id,
      grantId,
      dataPrincipalId,
    }).catch(() => {});

    return reply.status(201).send({
      recordId: id,
      grantId,
      dataPrincipalId,
      consentNoticeId,
      consentNoticeVersion: noticeVersion,
      consentNoticeLanguage: noticeLanguage,
      consentNoticeHash,
      noticeHash: boundNoticeHash,
      consentProof,
      processingExpiresAt: processingExpiresAt.toISOString(),
      retentionUntil: retentionUntil.toISOString(),
      status: 'active',
      createdAt: consentGivenAt.toISOString(),
    });
  });

  // POST /v1/dpdp/consent-records/:recordId/withdraw — Withdraw consent
  // It can revoke the record's grant (with the grants delegated from it,
  // through lib/revoke.ts), but it stays in the plan rate-limit bucket and
  // fails closed, unlike the containment routes (plugins/dynamicRateLimit.ts):
  // it is a compliance operation, not the incident path.
  app.post<{ Params: { recordId: string } }>(
    '/v1/dpdp/consent-records/:recordId/withdraw',
    async (request, reply) => {
      const { recordId } = request.params;
      const developerId = request.developer.id;
      const input = parseOr400(reply, request, () => {
        const body = requireBody(request.body);
        return {
          reason: requireString(body['reason'], 'reason', MAX_SHORT_TEXT),
          revokeGrant: optionalBoolean(body['revokeGrant'], 'revokeGrant'),
          deleteProcessedData: optionalBoolean(body['deleteProcessedData'], 'deleteProcessedData') ?? false,
        };
      });
      if (!input) return reply;
      // DPDP Act s.6(6): after a withdrawal, processing must cease. With
      // DPDP_WITHDRAWAL_REVOKES_GRANT=true an omitted revokeGrant means true.
      const revokeGrant = input.revokeGrant ?? config.dpdpWithdrawalRevokesGrant;
      const withdrawnAt = new Date();
      const sql = getSql();

      let refusedStatus: string | null | undefined;
      let grantId = '';
      let dataPrincipalId = '';
      let tree: RevokedGrantTree | null = null;
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        // Only an active record is withdrawn, so of two concurrent
        // withdrawals the second waits on the row and then matches nothing.
        const rows = await tx`
          UPDATE dpdp_consent_records
          SET status = 'withdrawn', withdrawn_at = ${withdrawnAt}, withdrawn_reason = ${input.reason}
          WHERE id = ${recordId} AND developer_id = ${developerId} AND status = 'active'
          RETURNING grant_id, data_principal_id
        `;
        const row = rows[0];
        if (!row) {
          const existing = await tx`
            SELECT status FROM dpdp_consent_records WHERE id = ${recordId} AND developer_id = ${developerId}
          `;
          refusedStatus = (existing[0]?.['status'] as string | undefined) ?? null;
          return;
        }
        grantId = row['grant_id'] as string;
        dataPrincipalId = row['data_principal_id'] as string;
        if (revokeGrant) tree = await revokeGrantInTx(tx, grantId, developerId);
        const revoked = tree as RevokedGrantTree | null;
        await appendDpdpAudit(tx, developerId, [{
          action: DPDP_AUDIT_ACTIONS.consentWithdrawn,
          grantId,
          metadata: {
            record_id: recordId,
            data_principal_id: dataPrincipalId,
            grant_revoked: revoked !== null,
            delegated_grants_revoked: revoked ? revoked.rows.length - 1 : 0,
            data_deletion_requested: input.deleteProcessedData,
          },
        }]);
      });

      if (refusedStatus !== undefined) {
        if (refusedStatus === null) return sendError(reply, request, 404, 'NOT_FOUND', 'Consent record not found');
        if (refusedStatus === 'withdrawn') return sendError(reply, request, 409, 'ALREADY_WITHDRAWN', 'Consent already withdrawn');
        if (refusedStatus === 'erased') return sendError(reply, request, 409, 'CONSENT_ERASED', 'Consent record was erased');
        return sendError(reply, request, 409, 'CONSENT_EXPIRED', 'Consent record has expired');
      }

      const revocation = await publishGrantRevocation(developerId, tree);

      emitEvent(developerId, 'dpdp.consent.withdrawn', {
        recordId,
        reason: input.reason,
        grantRevoked: revocation.revoked,
        dataDeleted: false,
        dataDeletionRequested: input.deleteProcessedData,
      }).catch(() => {});

      // Grantex holds no processed personal data of the fiduciary: deleting
      // it is the fiduciary's step (DPDP Act s.8(7)), so the request goes to
      // the developer rather than rewriting the tamper-evident audit log.
      if (input.deleteProcessedData) {
        emitEvent(developerId, 'dpdp.data_deletion.requested', {
          recordId,
          grantId,
          dataPrincipalId,
          requestedAt: withdrawnAt.toISOString(),
        }).catch(() => {});
      }

      return reply.send({
        recordId,
        status: 'withdrawn',
        withdrawnAt: withdrawnAt.toISOString(),
        grantRevoked: revocation.revoked,
        // True only when Grantex deleted something itself; it holds none of
        // the fiduciary's processed data, so a withdrawal never does.
        dataDeleted: false,
        dataDeletionRequested: input.deleteProcessedData,
      });
    },
  );

  // GET /v1/dpdp/data-principals/:principalId/records — Right to access (DPDP section 11)
  // A developer read: it does not count as the principal's own access, so
  // access_count and last_accessed_at are returned as stored, not bumped.
  app.get<{ Params: { principalId: string }; Querystring: Record<string, unknown> }>(
    '/v1/dpdp/data-principals/:principalId/records',
    async (request, reply) => {
      const { principalId } = request.params;
      const developerId = request.developer.id;
      const page = parseOr400(reply, request, () => parsePage(request.query));
      if (!page) return reply;
      const sql = getSql();

      const rows = await sql`
        SELECT ${CONSENT_RECORD_COLUMNS(sql)}
        FROM dpdp_consent_records
        WHERE data_principal_id = ${principalId} AND developer_id = ${developerId}
          ${page.cursor ? sql`AND (created_at, id) < (${page.cursor.t}::timestamptz, ${page.cursor.id})` : sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${page.limit + 1}
      `;
      const [count] = await sql`
        SELECT COUNT(*)::int AS total FROM dpdp_consent_records
        WHERE data_principal_id = ${principalId} AND developer_id = ${developerId}
      `;

      return reply.send({
        dataPrincipalId: principalId,
        records: rows.slice(0, page.limit).map(consentRecordResponse),
        totalRecords: Number(count?.['total'] ?? 0),
        nextCursor: nextCursor(rows, page.limit),
      });
    },
  );

  // POST /v1/dpdp/consent-notices — Register consent notice version
  app.post('/v1/dpdp/consent-notices', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const grievanceOfficer = body['grievanceOfficer'];
      if (grievanceOfficer !== undefined && grievanceOfficer !== null) {
        if (!isPlainObject(grievanceOfficer)) throw new InputError('grievanceOfficer must be an object { name, email, phone? }');
        requireString(grievanceOfficer['name'], 'grievanceOfficer.name', MAX_CODE);
        requireString(grievanceOfficer['email'], 'grievanceOfficer.email', MAX_ID);
        optionalString(grievanceOfficer['phone'], 'grievanceOfficer.phone', 64);
      }
      const purposes = requirePurposes(body['purposes']);
      return {
        noticeId: requireString(body['noticeId'], 'noticeId', MAX_ID),
        version: requireString(body['version'], 'version', MAX_CODE),
        title: requireString(body['title'], 'title', MAX_SHORT_TEXT),
        content: requireString(body['content'], 'content', MAX_NOTICE_CONTENT),
        purposes,
        language: optionalString(body['language'], 'language', 35) ?? 'en',
        dataFiduciaryContact: optionalString(body['dataFiduciaryContact'], 'dataFiduciaryContact', MAX_SHORT_TEXT) ?? null,
        grievanceOfficer: isPlainObject(grievanceOfficer) ? grievanceOfficer : null,
        ...parseNoticeStructure(body, purposes),
      };
    });
    if (!input) return reply;

    // DPDP Rules 2025 r.3: reported always, refused only under the flag.
    const enforced = config.dpdpNoticeRequireRule3;
    const validation = noticeValidation(input, { enforced });
    if (enforced && !validation.complete) {
      return sendError(reply, request, 400, 'NOTICE_INCOMPLETE',
        `The notice is missing DPDP Rules 2025 r.3 elements: ${validation.missing.join(', ')}`
        + (validation.language.englishOrEighthSchedule ? '' : ' (language must be English or an Eighth Schedule language, as an ISO 639 code)'));
    }

    const sql = getSql();
    const id = newNoticeId();
    const contentHash = sha256(input.content);
    let hash: string;
    try {
      hash = noticeHash(input);
    } catch (err) {
      if (err instanceof CanonicalizationError) {
        return sendError(reply, request, 400, 'BAD_REQUEST', `The notice has no canonical JSON form: ${err.message}`);
      }
      throw err;
    }
    const createdAt = new Date();

    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`
          INSERT INTO dpdp_consent_notices (
            id, developer_id, notice_id, language, version, title, content,
            purposes, data_fiduciary_contact, grievance_officer, content_hash, created_at,
            itemised_personal_data, purpose_details, withdrawal_url, rights_url, board_complaint_url, contact,
            notice_hash
          )
          VALUES (
            ${id}, ${developerId}, ${input.noticeId}, ${input.language}, ${input.version},
            ${input.title}, ${input.content}, ${json(tx, input.purposes)},
            ${input.dataFiduciaryContact}, ${input.grievanceOfficer ? json(tx, input.grievanceOfficer) : null},
            ${contentHash}, ${createdAt},
            ${input.itemisedPersonalData ? json(tx, input.itemisedPersonalData) : null},
            ${input.purposeDetails ? json(tx, input.purposeDetails) : null},
            ${input.withdrawalUrl}, ${input.rightsUrl}, ${input.boardComplaintUrl},
            ${input.contact ? json(tx, input.contact) : null},
            ${hash}
          )
        `;
        await appendDpdpAudit(tx, developerId, [{
          action: DPDP_AUDIT_ACTIONS.noticeCreated,
          metadata: {
            notice_id: input.noticeId, version: input.version, language: input.language, content_hash: contentHash,
            notice_hash: hash,
            rule3_missing: validation.missing,
          },
        }]);
      });
    } catch (err) {
      // Only the (developer, notice, version, language) unique index is a
      // conflict; anything else is a real failure and propagates.
      if ((err as { code?: string }).code === '23505') {
        return sendError(reply, request, 409, 'CONFLICT', 'Notice version already exists in this language');
      }
      throw err;
    }

    return reply.status(201).send({
      id,
      noticeId: input.noticeId,
      version: input.version,
      language: input.language,
      contentHash,
      noticeHash: hash,
      createdAt: createdAt.toISOString(),
      validation,
    });
  });

  // GET /v1/dpdp/consent-notices — List notice versions, newest first
  app.get<{ Querystring: Record<string, unknown> }>('/v1/dpdp/consent-notices', async (request, reply) => {
    const developerId = request.developer.id;
    const page = parseOr400(reply, request, () => parsePage(request.query));
    if (!page) return reply;
    const sql = getSql();
    const rows = await sql`
      SELECT ${NOTICE_BIND_COLUMNS(sql)}, created_at, created_at::text AS created_at_cursor
      FROM dpdp_consent_notices
      WHERE developer_id = ${developerId}
        ${page.cursor ? sql`AND (created_at, id) < (${page.cursor.t}::timestamptz, ${page.cursor.id})` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${page.limit + 1}
    `;
    return reply.send({
      notices: rows.slice(0, page.limit).map((n) => ({
        id: n['id'],
        noticeId: n['notice_id'],
        version: n['version'],
        language: n['language'],
        title: n['title'],
        contentHash: n['content_hash'],
        noticeHash: noticeHashOfRow(n),
        createdAt: n['created_at'],
        ...noticeStructureResponse(n),
      })),
      nextCursor: nextCursor(rows, page.limit),
    });
  });

  // GET /v1/dpdp/consent-notices/:noticeId — Every version of one notice, newest first
  app.get<{ Params: { noticeId: string } }>('/v1/dpdp/consent-notices/:noticeId', async (request, reply) => {
    const developerId = request.developer.id;
    const sql = getSql();
    const rows = await sql`
      SELECT ${NOTICE_BIND_COLUMNS(sql)}, created_at
      FROM dpdp_consent_notices
      WHERE developer_id = ${developerId} AND notice_id = ${request.params.noticeId}
      ORDER BY created_at DESC, id DESC
    `;
    if (rows.length === 0) return sendError(reply, request, 404, 'NOT_FOUND', 'Consent notice not found');
    return reply.send({
      noticeId: request.params.noticeId,
      versions: rows.map((n) => ({
        id: n['id'],
        version: n['version'],
        language: n['language'],
        title: n['title'],
        content: n['content'],
        purposes: n['purposes'],
        dataFiduciaryContact: n['data_fiduciary_contact'] ?? null,
        grievanceOfficer: n['grievance_officer'] ?? null,
        contentHash: n['content_hash'],
        noticeHash: noticeHashOfRow(n),
        createdAt: n['created_at'],
        ...noticeStructureResponse(n),
      })),
    });
  });

  // POST /v1/dpdp/grievances — File grievance (DPDP section 13)
  app.post('/v1/dpdp/grievances', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const evidence = body['evidence'];
      if (evidence !== undefined && evidence !== null) {
        if (!isPlainObject(evidence)) throw new InputError('evidence must be an object');
        if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_EVIDENCE_BYTES) {
          throw new InputError(`evidence must be at most ${MAX_EVIDENCE_BYTES} bytes as JSON`);
        }
      }
      const period = body['responsePeriodDays'];
      if (period !== undefined && period !== null
          && (typeof period !== 'number' || !Number.isInteger(period) || period < 1 || period > MAX_RESPONSE_PERIOD_DAYS)) {
        throw new InputError(`responsePeriodDays must be an integer from 1 to ${MAX_RESPONSE_PERIOD_DAYS} (DPDP Rules 2025 r.14(3))`);
      }
      return {
        dataPrincipalId: requireString(body['dataPrincipalId'], 'dataPrincipalId', MAX_ID),
        recordId: optionalString(body['recordId'], 'recordId', MAX_ID) ?? null,
        type: requireString(body['type'], 'type', MAX_CODE),
        description: requireString(body['description'], 'description', MAX_LONG_TEXT),
        evidence: isPlainObject(evidence) ? evidence : {},
        responsePeriodDays: typeof period === 'number' ? period : DEFAULT_RESPONSE_PERIOD_DAYS,
      };
    });
    if (!input) return reply;

    const sql = getSql();
    if (input.recordId !== null) {
      // The record must be this developer's, and about this principal.
      const records = await sql`
        SELECT data_principal_id FROM dpdp_consent_records
        WHERE id = ${input.recordId} AND developer_id = ${developerId}
      `;
      if (!records[0]) return sendError(reply, request, 400, 'INVALID_RECORD', 'Consent record not found');
      if (records[0]['data_principal_id'] !== input.dataPrincipalId) {
        return sendError(reply, request, 400, 'INVALID_RECORD', 'Consent record belongs to another data principal');
      }
    }

    const id = newGrievanceId();
    const referenceNumber = newGrievanceReference();
    const createdAt = new Date();
    // The fiduciary's published response period (7 days unless it says otherwise).
    const expectedResolutionBy = new Date(createdAt.getTime() + input.responsePeriodDays * 86400_000);

    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`
        INSERT INTO dpdp_grievances (
          id, developer_id, data_principal_id, record_id,
          type, description, evidence, reference_number, expected_resolution_by,
          response_period_days, created_at
        )
        VALUES (
          ${id}, ${developerId}, ${input.dataPrincipalId}, ${input.recordId},
          ${input.type}, ${input.description}, ${json(tx, input.evidence)},
          ${referenceNumber}, ${expectedResolutionBy}, ${input.responsePeriodDays}, ${createdAt}
        )
      `;
      await appendDpdpAudit(tx, developerId, [{
        action: DPDP_AUDIT_ACTIONS.grievanceFiled,
        metadata: {
          grievance_id: id, reference_number: referenceNumber, type: input.type,
          data_principal_id: input.dataPrincipalId, record_id: input.recordId,
        },
      }]);
    });

    emitEvent(developerId, 'dpdp.grievance.filed', {
      grievanceId: id,
      referenceNumber,
      type: input.type,
      dataPrincipalId: input.dataPrincipalId,
    }).catch(() => {});

    return reply.status(202).send({
      grievanceId: id,
      referenceNumber,
      type: input.type,
      status: 'submitted',
      responsePeriodDays: input.responsePeriodDays,
      expectedResolutionBy: expectedResolutionBy.toISOString(),
      createdAt: createdAt.toISOString(),
    });
  });

  // GET /v1/dpdp/grievances — List grievances, newest first
  app.get<{ Querystring: Record<string, unknown> }>('/v1/dpdp/grievances', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const status = request.query['status'];
      if (status !== undefined && !GRIEVANCE_STATUSES.includes(status as GrievanceStatus)) {
        throw new InputError(`status must be one of: ${GRIEVANCE_STATUSES.join(', ')}`);
      }
      return {
        page: parsePage(request.query),
        status: status as GrievanceStatus | undefined,
        dataPrincipalId: optionalString(request.query['dataPrincipalId'], 'dataPrincipalId', MAX_ID),
      };
    });
    if (!input) return reply;
    const { page } = input;
    const sql = getSql();
    const rows = await sql`
      SELECT id, data_principal_id, record_id, type, status, reference_number, expected_resolution_by,
             response_period_days, resolved_at, resolution, created_at, updated_at,
             created_at::text AS created_at_cursor
      FROM dpdp_grievances
      WHERE developer_id = ${developerId}
        ${input.status ? sql`AND status = ${input.status}` : sql``}
        ${input.dataPrincipalId ? sql`AND data_principal_id = ${input.dataPrincipalId}` : sql``}
        ${page.cursor ? sql`AND (created_at, id) < (${page.cursor.t}::timestamptz, ${page.cursor.id})` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${page.limit + 1}
    `;
    return reply.send({
      grievances: rows.slice(0, page.limit).map((g) => grievanceResponse(g, { detail: false })),
      nextCursor: nextCursor(rows, page.limit),
    });
  });

  // GET /v1/dpdp/grievances/:grievanceId — Get grievance status
  app.get<{ Params: { grievanceId: string } }>(
    '/v1/dpdp/grievances/:grievanceId',
    async (request, reply) => {
      const { grievanceId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, data_principal_id, record_id, type, description, evidence,
               status, reference_number, expected_resolution_by, response_period_days,
               resolved_at, resolution, created_at, updated_at
        FROM dpdp_grievances
        WHERE id = ${grievanceId} AND developer_id = ${developerId}
      `;

      const grievance = rows[0];
      if (!grievance) return sendError(reply, request, 404, 'NOT_FOUND', 'Grievance not found');
      return reply.send(grievanceResponse(grievance, { detail: true }));
    },
  );

  // PATCH /v1/dpdp/grievances/:grievanceId — Move a grievance along
  // submitted -> in_review -> resolved | rejected.
  app.patch<{ Params: { grievanceId: string } }>(
    '/v1/dpdp/grievances/:grievanceId',
    async (request, reply) => {
      const { grievanceId } = request.params;
      const developerId = request.developer.id;
      const input = parseOr400(reply, request, () => {
        const body = requireBody(request.body);
        const status = body['status'];
        if (status !== 'in_review' && status !== 'resolved' && status !== 'rejected') {
          throw new InputError('status must be one of: in_review, resolved, rejected');
        }
        const final = status !== 'in_review';
        return {
          status: status as keyof typeof GRIEVANCE_TRANSITIONS,
          resolution: final ? requireString(body['resolution'], 'resolution', MAX_LONG_TEXT) : null,
        };
      });
      if (!input) return reply;
      const from = GRIEVANCE_TRANSITIONS[input.status];
      const sql = getSql();

      let updated: Record<string, unknown> | undefined;
      let current: string | null = null;
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = input.resolution !== null
          ? await tx`
              UPDATE dpdp_grievances
              SET status = ${input.status}, resolution = ${input.resolution}, resolved_at = NOW(), updated_at = NOW()
              WHERE id = ${grievanceId} AND developer_id = ${developerId} AND status = ANY(${from})
              RETURNING *
            `
          : await tx`
              UPDATE dpdp_grievances
              SET status = ${input.status}, updated_at = NOW()
              WHERE id = ${grievanceId} AND developer_id = ${developerId} AND status = ANY(${from})
              RETURNING *
            `;
        updated = rows[0];
        if (!updated) {
          const existing = await tx`SELECT status FROM dpdp_grievances WHERE id = ${grievanceId} AND developer_id = ${developerId}`;
          current = (existing[0]?.['status'] as string | undefined) ?? null;
          return;
        }
        await appendDpdpAudit(tx, developerId, [{
          action: DPDP_AUDIT_ACTIONS.grievanceUpdated,
          metadata: {
            grievance_id: grievanceId,
            reference_number: updated['reference_number'],
            data_principal_id: updated['data_principal_id'],
            previous_status: from[0],
            status: input.status,
          },
        }]);
      });

      if (!updated) {
        if (current === null) return sendError(reply, request, 404, 'NOT_FOUND', 'Grievance not found');
        return sendError(reply, request, 409, 'INVALID_TRANSITION',
          `A grievance cannot move from ${current as string} to ${input.status}`);
      }

      emitEvent(developerId, 'dpdp.grievance.updated', {
        grievanceId,
        referenceNumber: updated['reference_number'],
        previousStatus: from[0],
        status: input.status,
      }).catch(() => {});

      return reply.send(grievanceResponse(updated, { detail: true }));
    },
  );

  // POST /v1/dpdp/exports — Generate compliance export
  app.post('/v1/dpdp/exports', async (request, reply) => {
    const developerId = request.developer.id;
    const input = parseOr400(reply, request, () => {
      const body = requireBody(request.body);
      const type = body['type'];
      if (typeof type !== 'string' || !EXPORT_TYPES.includes(type as (typeof EXPORT_TYPES)[number])) {
        throw new InputError(`Invalid type. Must be one of: ${EXPORT_TYPES.join(', ')}`);
      }
      const from = requireDate(body['dateFrom'], 'dateFrom', { dateOnly: true });
      const to = requireDate(body['dateTo'], 'dateTo', { dateOnly: true });
      if (from.getTime() > to.getTime()) throw new InputError('dateFrom must not be after dateTo');
      const format = body['format'] ?? 'json';
      // Only JSON is produced; accepting another format and returning JSON
      // anyway would misreport what the export is.
      if (!EXPORT_FORMATS.includes(format as (typeof EXPORT_FORMATS)[number])) {
        throw new InputError(`format must be one of: ${EXPORT_FORMATS.join(', ')}`);
      }
      const principal = optionalString(body['dataPrincipalId'], 'dataPrincipalId', MAX_ID);
      if (type === 'eu-ai-act-evidence' && principal !== undefined) {
        throw new InputError('dataPrincipalId is not accepted for eu-ai-act-evidence: the pack covers the operator, not one person');
      }
      // GDPR Art. 15 is a data subject's access right: an export for nobody
      // in particular is not one. Refused only under the flag.
      if (type === 'gdpr-article-15' && principal === undefined && config.dpdpExportGdprRequiresPrincipal) {
        throw new InputError('dataPrincipalId is required for a gdpr-article-15 export');
      }
      return {
        type: type as (typeof EXPORT_TYPES)[number],
        from,
        to,
        format: format as string,
        includeActionLog: optionalBoolean(body['includeActionLog'], 'includeActionLog') ?? true,
        includeConsentRecords: optionalBoolean(body['includeConsentRecords'], 'includeConsentRecords') ?? true,
        dataPrincipalId: principal ?? null,
      };
    });
    if (!input) return reply;
    const { type, from, to, format, dataPrincipalId } = input;

    const sql = getSql();
    // Exports past their expiry keep no data; purge this developer's now.
    await sql`
      UPDATE dpdp_exports SET data = NULL, status = 'expired'
      WHERE developer_id = ${developerId} AND expires_at <= NOW() AND status <> 'expired'
    `;

    const id = newExportId();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + EXPORT_LIFETIME_MS);

    const exportData: Record<string, unknown> = {
      exportType: type,
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      generatedAt: createdAt.toISOString(),
      developerId,
      ...(dataPrincipalId ? { dataPrincipalId } : {}),
    };

    let recordCount = 0;
    let truncated = false;
    // The structured pack replaces the generic keys; every other type keeps them.
    const generic = type !== 'eu-ai-act-evidence';

    if (generic && input.includeConsentRecords) {
      const consentRows = await sql`
        SELECT id, grant_id, data_principal_id, purposes, scopes, status,
               consent_notice_id, consent_notice_version,
               consent_given_at, processing_expires_at, withdrawn_at, erased_at
        FROM dpdp_consent_records
        WHERE developer_id = ${developerId}
          AND created_at >= ${from} AND created_at <= ${to}
          ${dataPrincipalId ? sql`AND data_principal_id = ${dataPrincipalId}` : sql``}
        ORDER BY created_at DESC
      `;
      exportData['consentRecords'] = consentRows;
      recordCount += consentRows.length;
    }

    if (generic && input.includeActionLog) {
      // audit_entries.principal_id is the principal namespace of the grant
      // the entry was written under, which is the DPDP data principal only
      // when the integration keys both the same way (enforced by
      // DPDP_ENFORCE_GRANT_PRINCIPAL). A principal export therefore takes the
      // entries written under the grants of that principal's consent
      // records, entries naming the principal directly, and the platform's
      // DPDP entries about the principal.
      const auditRows = await sql`
        SELECT id, action, status, metadata, timestamp
        FROM audit_entries
        WHERE developer_id = ${developerId}
          AND timestamp >= ${from} AND timestamp <= ${to}
          ${dataPrincipalId ? sql`AND (
            principal_id = ${dataPrincipalId}
            OR grant_id IN (
              SELECT grant_id FROM dpdp_consent_records
              WHERE developer_id = ${developerId} AND data_principal_id = ${dataPrincipalId}
            )
            OR (principal_id = 'platform' AND metadata->>'data_principal_id' = ${dataPrincipalId})
          )` : sql``}
        ORDER BY timestamp DESC, id DESC
        LIMIT ${EXPORT_AUDIT_LOG_LIMIT + 1}
      `;
      truncated = auditRows.length > EXPORT_AUDIT_LOG_LIMIT;
      const kept = auditRows.slice(0, EXPORT_AUDIT_LOG_LIMIT);
      exportData['auditLog'] = kept;
      recordCount += kept.length;
    }

    // Add grievances for DPDP exports
    if (type === 'dpdp-audit') {
      const grievanceRows = await sql`
        SELECT id, reference_number, type, status, response_period_days, created_at, resolved_at
        FROM dpdp_grievances
        WHERE developer_id = ${developerId}
          AND created_at >= ${from} AND created_at <= ${to}
          ${dataPrincipalId ? sql`AND data_principal_id = ${dataPrincipalId}` : sql``}
        ORDER BY created_at DESC
      `;
      exportData['grievances'] = grievanceRows;
      recordCount += grievanceRows.length;
    }

    // Regulation (EU) 2024/1689 sections, over the developer's records. Not
    // added to a conformance export filtered to one principal, since the
    // sections are not per person.
    if (type === 'eu-ai-act-evidence' || (type === 'eu-ai-act-conformance' && !dataPrincipalId)) {
      const sections = await euAiActSections(sql, developerId, from, to);
      Object.assign(exportData, sections);
      // Each section has its own truncated flag. For eu-ai-act-conformance
      // the top-level flag keeps meaning what it meant: the audit log cap.
      if (type === 'eu-ai-act-evidence') {
        const summary = sectionsSummary(sections);
        truncated = summary.truncated;
        recordCount += summary.itemCount;
      }
    }

    if (type === 'gdpr-article-15' && dataPrincipalId) {
      // The data principal's own grievances for the period, as the copy the
      // article15 scope names; capped like the article15 records.
      const grievanceRows = await sql`
        SELECT id, reference_number, record_id, type, description, status, response_period_days,
               expected_resolution_by, created_at, resolved_at
        FROM dpdp_grievances
        WHERE developer_id = ${developerId} AND data_principal_id = ${dataPrincipalId}
          AND created_at >= ${from} AND created_at <= ${to}
        ORDER BY created_at DESC, id DESC
        LIMIT ${ARTICLE15_RECORD_LIMIT + 1}
      `;
      const grievancesTruncated = grievanceRows.length > ARTICLE15_RECORD_LIMIT;
      const grievances = grievanceRows.slice(0, ARTICLE15_RECORD_LIMIT);
      exportData['grievances'] = grievances;
      recordCount += grievances.length;
      truncated = truncated || grievancesTruncated;
      const article15 = await gdprArticle15(sql, developerId, dataPrincipalId, {
        grievanceCount: grievances.length, grievancesTruncated,
      });
      // article15.truncated says whether the block, or the grievances copy, left rows out.
      exportData['article15'] = article15;
    }

    exportData['truncated'] = truncated;
    exportData['auditLogLimit'] = EXPORT_AUDIT_LOG_LIMIT;

    await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`
        INSERT INTO dpdp_exports (
          id, developer_id, type, date_from, date_to,
          format, record_count, data, expires_at, data_principal_id, truncated, created_at
        )
        VALUES (
          ${id}, ${developerId}, ${type}, ${from}, ${to},
          ${format}, ${recordCount}, ${json(tx, exportData)}, ${expiresAt},
          ${dataPrincipalId}, ${truncated}, ${createdAt}
        )
      `;
      await appendDpdpAudit(tx, developerId, [{
        action: DPDP_AUDIT_ACTIONS.exportCreated,
        metadata: {
          export_id: id, type, record_count: recordCount, truncated,
          ...(dataPrincipalId ? { data_principal_id: dataPrincipalId } : {}),
        },
      }]);
    });

    return reply.status(201).send({
      exportId: id,
      type,
      format,
      recordCount,
      truncated,
      auditLogLimit: EXPORT_AUDIT_LOG_LIMIT,
      dataPrincipalId,
      data: exportData,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
    });
  });

  // GET /v1/dpdp/exports/:exportId — Get export status/data
  app.get<{ Params: { exportId: string } }>(
    '/v1/dpdp/exports/:exportId',
    async (request, reply) => {
      const { exportId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT id, type, date_from, date_to, format, status, record_count, truncated,
               data_principal_id, data, expires_at, created_at
        FROM dpdp_exports
        WHERE id = ${exportId} AND developer_id = ${developerId}
      `;

      const exp = rows[0];
      if (!exp) return sendError(reply, request, 404, 'NOT_FOUND', 'Export not found');

      if (exp['status'] === 'expired' || new Date(exp['expires_at'] as string).getTime() <= Date.now()) {
        // Past its expiry the export's data is purged, not served.
        await sql`
          UPDATE dpdp_exports SET data = NULL, status = 'expired'
          WHERE id = ${exportId} AND developer_id = ${developerId}
        `;
        return sendError(reply, request, 410, 'GONE', 'Export has expired and its data was purged');
      }

      return reply.send({
        exportId: exp['id'],
        type: exp['type'],
        dateFrom: exp['date_from'],
        dateTo: exp['date_to'],
        format: exp['format'],
        status: exp['status'],
        recordCount: exp['record_count'],
        truncated: exp['truncated'] ?? false,
        auditLogLimit: EXPORT_AUDIT_LOG_LIMIT,
        dataPrincipalId: exp['data_principal_id'] ?? null,
        data: exp['data'],
        expiresAt: exp['expires_at'],
        createdAt: exp['created_at'],
      });
    },
  );

  // GET /v1/dpdp/consent-records/:recordId — Fetch single consent record by ID
  // A developer read: access_count and last_accessed_at are not bumped.
  app.get<{ Params: { recordId: string } }>(
    '/v1/dpdp/consent-records/:recordId',
    async (request, reply) => {
      const { recordId } = request.params;
      const developerId = request.developer.id;
      const sql = getSql();

      const rows = await sql`
        SELECT ${CONSENT_RECORD_COLUMNS(sql)}
        FROM dpdp_consent_records
        WHERE id = ${recordId} AND developer_id = ${developerId}
      `;
      if (rows.length === 0) return sendError(reply, request, 404, 'NOT_FOUND', 'Consent record not found');
      return reply.send(consentRecordResponse(rows[0]!));
    },
  );

  // GET /v1/dpdp/consent-records — List consent records with optional dataPrincipalId filter
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/dpdp/consent-records',
    async (request, reply) => {
      const developerId = request.developer.id;
      const input = parseOr400(reply, request, () => ({
        page: parsePage(request.query),
        dataPrincipalId: optionalString(request.query['dataPrincipalId'], 'dataPrincipalId', MAX_ID),
      }));
      if (!input) return reply;
      const { page, dataPrincipalId } = input;
      const sql = getSql();

      const rows = await sql`
        SELECT ${CONSENT_RECORD_COLUMNS(sql)}
        FROM dpdp_consent_records
        WHERE developer_id = ${developerId}
          ${dataPrincipalId ? sql`AND data_principal_id = ${dataPrincipalId}` : sql``}
          ${page.cursor ? sql`AND (created_at, id) < (${page.cursor.t}::timestamptz, ${page.cursor.id})` : sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${page.limit + 1}
      `;
      const [count] = await sql`
        SELECT COUNT(*)::int AS total FROM dpdp_consent_records
        WHERE developer_id = ${developerId}
          ${dataPrincipalId ? sql`AND data_principal_id = ${dataPrincipalId}` : sql``}
      `;

      return reply.send({
        records: rows.slice(0, page.limit).map(consentRecordResponse),
        totalRecords: Number(count?.['total'] ?? 0),
        nextCursor: nextCursor(rows, page.limit),
      });
    },
  );

  // POST /v1/dpdp/data-principals/:principalId/erasure — Right to erasure (DPDP Act s.12)
  // Plan rate-limit bucket, failing closed, as for withdrawal above: it
  // revokes the principal's grants.
  //
  // What it does, in one transaction: revokes the principal's active grants
  // (with their delegated grants), marks the consent records erased, redacts
  // the principal's grievance text and deletes stored exports about the
  // principal, and records the request. What it keeps, and why, is in
  // `retained`: the consent records and the audit log stay (DPDP Rules 2025
  // r.8(3) and r.6(1)(e); DPDP Act s.6(10)). A repeat for a principal with
  // nothing left to erase returns the completed request instead of a new one.
  app.post<{ Params: { principalId: string } }>(
    '/v1/dpdp/data-principals/:principalId/erasure',
    async (request, reply) => {
      const { principalId } = request.params;
      const developerId = request.developer.id;
      if (principalId.length > MAX_ID) return sendError(reply, request, 400, 'BAD_REQUEST', `principalId must be at most ${MAX_ID} characters`);
      const sql = getSql();

      let outcome: 'not_found' | 'existing' | 'completed' = 'not_found';
      let requestRow: Record<string, unknown> | undefined;
      const trees: RevokedGrantTree[] = [];
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        // One erasure of a principal at a time, so a repeat waits for the
        // first and then finds it.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`dpdp-erasure:${developerId}:${principalId}`}, 0))`;
        const records = await tx`
          SELECT id, grant_id, status FROM dpdp_consent_records
          WHERE data_principal_id = ${principalId} AND developer_id = ${developerId}
          ORDER BY id
          FOR UPDATE
        `;
        if (records.length === 0) return;
        const pending = records.filter((r) => r['status'] !== 'erased');
        const previous = await tx`
          SELECT * FROM dpdp_erasure_requests
          WHERE developer_id = ${developerId} AND data_principal_id = ${principalId}
          ORDER BY submitted_at DESC, id DESC
          LIMIT 1
        `;
        if (previous[0] && pending.length === 0) {
          outcome = 'existing';
          requestRow = previous[0];
          return;
        }

        const submittedAt = new Date();
        const grantIds = [...new Set(records.map((r) => r['grant_id'] as string).filter(Boolean))].sort();
        for (const grantId of grantIds) {
          // Only active grants are revoked, and only those are counted.
          const tree = await revokeGrantInTx(tx, grantId, developerId);
          if (tree) trees.push(tree);
        }
        const pendingIds = pending.map((r) => r['id'] as string);
        if (pendingIds.length > 0) {
          await tx`
            UPDATE dpdp_consent_records
            SET status = 'erased', erased_at = ${submittedAt},
                withdrawn_at = COALESCE(withdrawn_at, ${submittedAt}),
                withdrawn_reason = COALESCE(withdrawn_reason, 'Data erasure request')
            WHERE id = ANY(${pendingIds}) AND developer_id = ${developerId}
          `;
        }
        const grievances = await tx`
          UPDATE dpdp_grievances
          SET description = ${ERASED_TEXT_MARKER}, evidence = ${json(tx, { redacted: true })}, updated_at = NOW()
          WHERE developer_id = ${developerId} AND data_principal_id = ${principalId}
            AND description <> ${ERASED_TEXT_MARKER}
          RETURNING id
        `;
        const [grievanceTotal] = await tx`
          SELECT COUNT(*)::int AS total FROM dpdp_grievances
          WHERE developer_id = ${developerId} AND data_principal_id = ${principalId}
        `;
        // Stored exports filtered to the principal, or carrying the principal
        // id anywhere in their data (matched as a whole JSON string).
        const exports = await tx`
          DELETE FROM dpdp_exports
          WHERE developer_id = ${developerId}
            AND (data_principal_id = ${principalId}
                 OR (data IS NOT NULL AND position(${JSON.stringify(principalId)} IN data::text) > 0))
          RETURNING id
        `;
        const completedAt = new Date();
        const grantsRevoked = trees.length;
        const delegatedGrantsRevoked = trees.reduce((sum, tree) => sum + tree.rows.length - 1, 0);
        const retained = retainedAfterErasure(records.length, Number(grievanceTotal?.['total'] ?? 0));
        requestRow = {
          id: newErasureRequestId(),
          data_principal_id: principalId,
          status: 'completed',
          records_erased: pendingIds.length,
          grants_revoked: grantsRevoked,
          delegated_grants_revoked: delegatedGrantsRevoked,
          grievances_redacted: grievances.length,
          exports_deleted: exports.length,
          retained,
          submitted_at: submittedAt,
          completed_at: completedAt,
        };
        await tx`
          INSERT INTO dpdp_erasure_requests (
            id, developer_id, data_principal_id, status, records_erased, grants_revoked,
            delegated_grants_revoked, grievances_redacted, exports_deleted, retained,
            submitted_at, completed_at
          )
          VALUES (
            ${requestRow['id'] as string}, ${developerId}, ${principalId}, 'completed', ${pendingIds.length}, ${grantsRevoked},
            ${delegatedGrantsRevoked}, ${grievances.length}, ${exports.length}, ${json(tx, retained)},
            ${submittedAt}, ${completedAt}
          )
        `;
        await appendDpdpAudit(tx, developerId, [{
          action: DPDP_AUDIT_ACTIONS.erasureCompleted,
          metadata: {
            request_id: requestRow!['id'],
            data_principal_id: principalId,
            records_erased: pendingIds.length,
            grants_revoked: grantsRevoked,
            delegated_grants_revoked: delegatedGrantsRevoked,
            grievances_redacted: grievances.length,
            exports_deleted: exports.length,
          },
        }]);
        outcome = 'completed';
      });

      if (outcome === 'not_found') {
        return sendError(reply, request, 404, 'NOT_FOUND', 'No consent records found for this data principal');
      }
      const body = erasureResponse(requestRow!);
      if (outcome === 'existing') return reply.status(200).send(body);

      for (const tree of trees) await publishGrantRevocation(developerId, tree);
      emitEvent(developerId, 'dpdp.erasure.completed', {
        requestId: body.requestId,
        dataPrincipalId: principalId,
        recordsErased: body.recordsErased,
        grantsRevoked: body.grantsRevoked,
        delegatedGrantsRevoked: body.delegatedGrantsRevoked,
      }).catch(() => {});

      return reply.status(201).send(body);
    },
  );

  // GET /v1/dpdp/erasure-requests/:requestId — A completed erasure request
  app.get<{ Params: { requestId: string } }>(
    '/v1/dpdp/erasure-requests/:requestId',
    async (request, reply) => {
      const developerId = request.developer.id;
      const sql = getSql();
      const rows = await sql`
        SELECT * FROM dpdp_erasure_requests
        WHERE id = ${request.params.requestId} AND developer_id = ${developerId}
      `;
      if (!rows[0]) return sendError(reply, request, 404, 'NOT_FOUND', 'Erasure request not found');
      return reply.send(erasureResponse(rows[0]));
    },
  );
}

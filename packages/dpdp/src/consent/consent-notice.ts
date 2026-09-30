/**
 * Consent notice creation, listing and validation.
 *
 * DPDP Act 2023, s.5 and DPDP Rules 2025, r.3 — a notice must be clear,
 * itemise the personal data and each processing purpose, and say how the
 * data principal can withdraw consent and make a complaint.
 */

import type {
  ConsentNotice,
  ConsentNoticeCreated,
  ConsentNoticePage,
  ConsentNoticeVersions,
  CreateConsentNoticeOptions,
  PageOptions,
} from '../types.js';
import { DpdpError } from '../errors.js';
import { asObject, dpdpRequest, dpdpUrl, nextCursorOf, opt, seg, str, toDate, type HttpFailure } from '../http.js';
import { isWirePurpose, purposeLabel, toWirePurpose } from '../purpose/wire.js';
import { decodeGrievanceOfficer, decodePurposes } from '../decode.js';

const NOTICES = seg('consent-notices');

function failure(fallback: string, code: string) {
  return (f: HttpFailure) =>
    new DpdpError(f.message ?? `${fallback} (${f.statusCode})`, f.code ?? code, f.statusCode, f.requestId);
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of consent notice content.
 * Returns a hex-encoded string (the same value the server stores as `contentHash`).
 */
export async function computeNoticeHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a consent notice has the fields a notice needs
 * (DPDP Act s.5, DPDP Rules 2025 r.3). A purpose may be the wire shape
 * `{ code, description }` or the local `ConsentPurpose` model.
 */
export function validateNotice(notice: ConsentNotice): string[] {
  const errors: string[] = [];

  if (!notice.noticeId) errors.push('noticeId is required');
  if (!notice.language) errors.push('language is required');
  if (!notice.version) errors.push('version is required');
  if (!notice.title) errors.push('title is required');
  if (!notice.content) errors.push('content is required');
  if (!notice.dataFiduciaryContact) errors.push('dataFiduciaryContact is required');
  if (!notice.contentHash) errors.push('contentHash is required');

  if (!notice.purposes || notice.purposes.length === 0) {
    errors.push('At least one purpose must be specified');
  } else {
    for (const p of notice.purposes) {
      if (isWirePurpose(p)) {
        if (!p.code) errors.push('Purpose missing code');
      } else {
        if (!p.purposeId) errors.push('Purpose missing purposeId');
        if (!p.name) errors.push(`Purpose "${purposeLabel(p)}" missing name`);
      }
      if (!p.description) errors.push(`Purpose "${purposeLabel(p)}" missing description`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Register a consent notice version with the Grantex auth service.
 *
 * `POST /v1/dpdp/consent-notices`. The server computes `contentHash`; a
 * repeated `(noticeId, version)` fails with 409 `CONFLICT`.
 */
export async function createConsentNotice(
  opts: CreateConsentNoticeOptions,
): Promise<ConsentNoticeCreated> {
  const language = opts.language ?? 'en';
  const validationErrors = validateNotice({
    noticeId: opts.noticeId,
    language,
    version: opts.version,
    title: opts.title,
    content: opts.content,
    purposes: opts.purposes,
    dataFiduciaryContact: opts.dataFiduciaryContact,
    // Validation only: the server computes and stores its own hash.
    contentHash: await computeNoticeHash(opts.content),
  });
  if (validationErrors.length > 0) {
    throw new DpdpError(
      `Invalid consent notice: ${validationErrors.join('; ')}`,
      'INVALID_NOTICE',
      400,
    );
  }

  const officer = opts.grievanceOfficer;
  const body = {
    noticeId: opts.noticeId,
    version: opts.version,
    language,
    title: opts.title,
    content: opts.content,
    purposes: opts.purposes.map(toWirePurpose),
    ...opt('dataFiduciaryContact', opts.dataFiduciaryContact || undefined),
    ...(officer
      ? { grievanceOfficer: { name: officer.name, email: officer.email, ...opt('phone', officer.phone) } }
      : {}),
  };

  const { data } = await dpdpRequest(
    { method: 'POST', url: dpdpUrl(opts.baseUrl, [NOTICES]), apiKey: opts.apiKey, body },
    failure('Failed to create consent notice', 'CREATE_NOTICE_FAILED'),
  );

  const raw = asObject(data);
  return {
    id: raw.id as string,
    noticeId: raw.noticeId as string,
    version: raw.version as string,
    language: raw.language as string,
    contentHash: raw.contentHash as string,
    createdAt: toDate(raw.createdAt) as Date,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List notice versions, newest first.
 *
 * `GET /v1/dpdp/consent-notices?limit=&cursor=`
 */
export async function listConsentNotices(
  options: PageOptions,
  apiKey: string,
  baseUrl: string,
): Promise<ConsentNoticePage> {
  const { data } = await dpdpRequest(
    {
      method: 'GET',
      url: dpdpUrl(baseUrl, [NOTICES], { limit: options.limit, cursor: options.cursor }),
      apiKey,
    },
    failure('Failed to list consent notices', 'LIST_NOTICES_FAILED'),
  );
  const raw = asObject(data);
  const notices = Array.isArray(raw.notices) ? raw.notices : [];
  return {
    notices: notices.map((n) => {
      const o = asObject(n);
      return {
        id: o.id as string,
        noticeId: o.noticeId as string,
        version: o.version as string,
        language: o.language as string,
        title: o.title as string,
        contentHash: o.contentHash as string,
        createdAt: toDate(o.createdAt) as Date,
      };
    }),
    nextCursor: nextCursorOf(raw),
  };
}

/**
 * Every version of one notice, newest first.
 *
 * `GET /v1/dpdp/consent-notices/:noticeId`
 */
export async function getConsentNotice(
  noticeId: string,
  apiKey: string,
  baseUrl: string,
): Promise<ConsentNoticeVersions> {
  const { data } = await dpdpRequest(
    { method: 'GET', url: dpdpUrl(baseUrl, [NOTICES, noticeId]), apiKey },
    failure(`Failed to get consent notice ${noticeId}`, 'GET_NOTICE_FAILED'),
  );
  const raw = asObject(data);
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  return {
    noticeId: raw.noticeId as string,
    versions: versions.map((v) => {
      const o = asObject(v);
      return {
        id: o.id as string,
        version: o.version as string,
        language: o.language as string,
        title: o.title as string,
        content: o.content as string,
        purposes: decodePurposes(o.purposes),
        ...opt('dataFiduciaryContact', str(o.dataFiduciaryContact)),
        ...opt('grievanceOfficer', decodeGrievanceOfficer(o.grievanceOfficer)),
        contentHash: o.contentHash as string,
        createdAt: toDate(o.createdAt) as Date,
      };
    }),
  };
}


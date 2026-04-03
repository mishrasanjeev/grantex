/**
 * Consent notice creation and validation.
 *
 * DPDP Act 2023, Section 5 — notice must be clear, itemised, and
 * include a description of each processing purpose.
 */

import type { ConsentNotice, CreateConsentNoticeOptions } from '../types.js';
import { DpdpError } from '../errors.js';

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of consent notice content.
 * Returns a hex-encoded string.
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
 * Validate that a consent notice has all required fields per DPDP Act Section 5.
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
      if (!p.purposeId) errors.push(`Purpose missing purposeId`);
      if (!p.name) errors.push(`Purpose "${p.purposeId || '?'}" missing name`);
      if (!p.description) errors.push(`Purpose "${p.purposeId || '?'}" missing description`);
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
 * `POST /v1/dpdp/consent-notices`
 */
export async function createConsentNotice(
  opts: CreateConsentNoticeOptions,
): Promise<ConsentNotice> {
  const contentHash = await computeNoticeHash(opts.content);

  const body = {
    language: opts.language,
    version: opts.version,
    title: opts.title,
    content: opts.content,
    purposes: opts.purposes,
    dataFiduciaryContact: opts.dataFiduciaryContact,
    ...(opts.grievanceOfficer !== undefined
      ? { grievanceOfficer: opts.grievanceOfficer }
      : {}),
    contentHash,
  };

  const notice: ConsentNotice = {
    noticeId: '', // will be set by server
    ...body,
  };

  const validationErrors = validateNotice({ ...notice, noticeId: 'pending' });
  if (validationErrors.length > 0) {
    throw new DpdpError(
      `Invalid consent notice: ${validationErrors.join('; ')}`,
      'INVALID_NOTICE',
      400,
    );
  }

  const res = await fetch(`${opts.baseUrl}/v1/dpdp/consent-notices`, {
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
      (errBody.message as string) ?? `Failed to create consent notice (${res.status})`,
      'CREATE_NOTICE_FAILED',
      res.status,
    );
  }

  return (await res.json()) as ConsentNotice;
}

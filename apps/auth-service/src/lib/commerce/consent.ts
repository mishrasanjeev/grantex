import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { type TxSql } from '../../db/client.js';
import {
  newCommerceConsentRecordId,
  newConsentRequestId,
} from './ids.js';
import { consumeVerifiedChallengeTx } from './consent-challenge.js';

type Sql = ReturnType<typeof postgres>;

export const CONSENT_TTL_SECONDS_DEFAULT = 600;          // spec §14: 10 min
export const CONSENT_TEXT_VERSION = '2026-05-01';

export type PassportType = 'browse' | 'checkout';

export interface CreateConsentInput {
  tenantId: string;
  merchantId: string;
  agentId: string;
  passportType: PassportType;
  requestedScopes: string[];
  maxAmount: number | null;
  currency: string | null;
  agentAuthMethod: 'jwt' | 'api_key';
  ipHash: string | null;
  userAgentHash: string | null;
  ttlSeconds?: number;
  /**
   * Optional hint: the agent claims it expects this user_principal_id
   * to authorize. Approval enforces the authenticated principal matches
   * this hint when set. The hint is NEVER trusted as the user identity —
   * approval always sets user_principal_id from the verified session.
   */
  userPrincipalHint?: string | null;
}

export interface CreatedConsent {
  id: string;
  consentRequestId: string;
  expiresAt: string;
}

export async function createConsentRequest(
  sql: Sql,
  input: CreateConsentInput,
): Promise<CreatedConsent> {
  const id = newCommerceConsentRecordId();
  const consentRequestId = newConsentRequestId();
  const ttl = Math.max(60, Math.min(input.ttlSeconds ?? CONSENT_TTL_SECONDS_DEFAULT, CONSENT_TTL_SECONDS_DEFAULT));
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await sql`
    INSERT INTO commerce_consent_records (
      id, tenant_id, merchant_id, agent_id, consent_request_id,
      passport_type, requested_scopes, max_amount, currency,
      consent_text_version, agent_auth_method, ip_hash, user_agent_hash,
      user_principal_hint, expires_at
    ) VALUES (
      ${id}, ${input.tenantId}, ${input.merchantId}, ${input.agentId}, ${consentRequestId},
      ${input.passportType}, ${input.requestedScopes}, ${input.maxAmount}, ${input.currency},
      ${CONSENT_TEXT_VERSION}, ${input.agentAuthMethod}, ${input.ipHash}, ${input.userAgentHash},
      ${input.userPrincipalHint ?? null}, ${expiresAt.toISOString()}
    )
  `;
  return { id, consentRequestId, expiresAt: expiresAt.toISOString() };
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  merchantId: string;
  agentId: string;
  consentRequestId: string;
  passportType: PassportType;
  requestedScopes: string[];
  approvedScopes: string[] | null;
  maxAmount: number | null;
  currency: string | null;
  consentTextVersion: string;
  presentedPayloadHash: string | null;
  status: 'requested' | 'granted' | 'denied' | 'expired';
  agentAuthMethod: 'jwt' | 'api_key' | null;
  expiresAt: string;
  approvedAt: string | null;
  deniedAt: string | null;
  userPrincipalId: string | null;
  userPrincipalHint: string | null;
  createdAt: string;
}

interface ConsentRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  agent_id: string;
  consent_request_id: string;
  passport_type: string;
  requested_scopes: string[];
  approved_scopes: string[] | null;
  max_amount: string | number | null;
  currency: string | null;
  consent_text_version: string;
  presented_payload_hash: string | null;
  status: string;
  agent_auth_method: string | null;
  expires_at: Date | string;
  approved_at: Date | string | null;
  denied_at: Date | string | null;
  user_principal_id: string | null;
  user_principal_hint: string | null;
  created_at: Date | string;
}

function asIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToRecord(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    merchantId: row.merchant_id,
    agentId: row.agent_id,
    consentRequestId: row.consent_request_id,
    passportType: row.passport_type as PassportType,
    requestedScopes: row.requested_scopes,
    approvedScopes: row.approved_scopes,
    maxAmount: row.max_amount == null ? null : Number(row.max_amount),
    currency: row.currency,
    consentTextVersion: row.consent_text_version,
    presentedPayloadHash: row.presented_payload_hash,
    status: row.status as ConsentRecord['status'],
    agentAuthMethod: row.agent_auth_method as ConsentRecord['agentAuthMethod'],
    expiresAt: asIso(row.expires_at) ?? '',
    approvedAt: asIso(row.approved_at),
    deniedAt: asIso(row.denied_at),
    userPrincipalId: row.user_principal_id,
    userPrincipalHint: row.user_principal_hint,
    createdAt: asIso(row.created_at) ?? '',
  };
}

export async function findConsentByRequestId(
  sql: Sql,
  consentRequestId: string,
): Promise<ConsentRecord | null> {
  const rows = await sql<ConsentRow[]>`
    SELECT * FROM commerce_consent_records WHERE consent_request_id = ${consentRequestId} LIMIT 1
  `;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function findConsentById(sql: Sql, id: string): Promise<ConsentRecord | null> {
  const rows = await sql<ConsentRow[]>`
    SELECT * FROM commerce_consent_records WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Canonical JSON of the displayed consent payload. Hash of this is
 * stored as presented_payload_hash on first GET; exchange recomputes
 * and compares (Finding 4) to defend against bait-and-switch.
 */
export function canonicalPresentedPayload(record: ConsentRecord): string {
  return JSON.stringify({
    consent_request_id: record.consentRequestId,
    tenant_id: record.tenantId,
    merchant_id: record.merchantId,
    agent_id: record.agentId,
    passport_type: record.passportType,
    requested_scopes: [...record.requestedScopes].sort(),
    max_amount: record.maxAmount,
    currency: record.currency,
    consent_text_version: record.consentTextVersion,
    expires_at: record.expiresAt,
  });
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Capture-on-first-GET semantics:
 *   - If the record is `requested` and has no presented_payload_hash,
 *     compute and store it under SELECT...FOR UPDATE.
 *   - If the record is `requested` and already has a hash (multi-tab
 *     re-render), return the existing record.
 *   - If the record is past expires_at and still `requested`, transition
 *     to `expired` and return that.
 *   - If the record is already `granted`/`denied`/`expired`, return as-is.
 *
 * Returns null when no such consent_request_id exists. CSRF concerns
 * are now the route's responsibility (Finding 1 redesign — the per-form
 * CSRF token is derived from the principal session token, so no
 * per-consent CSRF state lives in the DB).
 */
export async function presentConsentForUser(
  sql: Sql,
  consentRequestId: string,
): Promise<ConsentRecord | null> {
  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx<ConsentRow[]>`
      SELECT * FROM commerce_consent_records
       WHERE consent_request_id = ${consentRequestId}
       FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    const record = rowToRecord(row);

    if (record.status !== 'requested') return record;

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      await tx`
        UPDATE commerce_consent_records SET status = 'expired', updated_at = NOW()
         WHERE id = ${record.id} AND status = 'requested'
      `;
      return { ...record, status: 'expired' as const };
    }

    if (record.presentedPayloadHash) {
      // Already presented (multi-tab refresh) — same hash, same payload.
      return record;
    }

    // First presentation: capture the hash now.
    const newRecord = { ...record, presentedPayloadHash: null };
    const presentedPayloadHash = sha256hex(canonicalPresentedPayload(newRecord));
    await tx`
      UPDATE commerce_consent_records
         SET presented_payload_hash = ${presentedPayloadHash},
             updated_at = NOW()
       WHERE id = ${record.id}
    `;
    return { ...record, presentedPayloadHash };
  });
}

export type ConsentDecisionResult =
  | { ok: true; record: ConsentRecord; consumedChallengeId: string }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'already_decided'
        | 'principal_hint_mismatch'
        | 'challenge_required';
    };

/**
 * Atomically:
 *   1. SELECT FOR UPDATE the consent record.
 *   2. Validate state, hint match.
 *   3. SELECT FOR UPDATE the verified challenge for this
 *      (consent_request_id, principal_id) pair and mark it `used`.
 *      Without a verified challenge, refuse the decision —
 *      challenge_required closes the M2 P0: a developer-minted
 *      principal session alone is no longer sufficient.
 *   4. UPDATE the consent → granted/denied.
 *
 * All four steps run inside one sql.begin() so a successful decision
 * always coincides with challenge consumption — the agent cannot reuse
 * a verified challenge to approve/deny a different consent.
 *
 * Hint enforcement (P2 fix): user_principal_hint is now checked for
 * BOTH approve AND deny. Previously deny ignored the hint, which let a
 * different principal in the same tenant burn the single-use consent.
 */
async function decideConsent(
  sql: Sql,
  consentRequestId: string,
  decision: 'granted' | 'denied',
  principalId: string,
): Promise<ConsentDecisionResult> {
  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx<ConsentRow[]>`
      SELECT * FROM commerce_consent_records
       WHERE consent_request_id = ${consentRequestId}
       FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return { ok: false as const, reason: 'not_found' as const };
    const record = rowToRecord(row);

    if (record.status === 'expired'
      || new Date(record.expiresAt).getTime() < Date.now()) {
      if (record.status === 'requested') {
        await tx`
          UPDATE commerce_consent_records SET status = 'expired', updated_at = NOW()
           WHERE id = ${record.id} AND status = 'requested'
        `;
      }
      return { ok: false as const, reason: 'expired' as const };
    }
    if (record.status !== 'requested') {
      return { ok: false as const, reason: 'already_decided' as const };
    }

    // P2 fix: enforce hint match for BOTH approve and deny. Previously
    // only granted enforced; deny path let any same-tenant principal burn
    // the single-use consent intended for someone else.
    if (record.userPrincipalHint && record.userPrincipalHint !== principalId) {
      return { ok: false as const, reason: 'principal_hint_mismatch' as const };
    }

    // P0 fix: consume a verified consent challenge for this specific
    // (consent_request_id, principal_id) atomically with the status
    // transition. Without a verified challenge — independently issued
    // by Grantex through a channel the agent/developer cannot read —
    // refuse the decision.
    const consumed = await consumeVerifiedChallengeTx(tx, {
      consentRequestId, principalId,
    });
    if (!consumed.consumed) {
      return { ok: false as const, reason: 'challenge_required' as const };
    }

    if (decision === 'granted') {
      const updated = await tx<ConsentRow[]>`
        UPDATE commerce_consent_records
           SET status = 'granted',
               approved_scopes = requested_scopes,
               approved_at = NOW(),
               user_principal_id = ${principalId},
               updated_at = NOW()
         WHERE id = ${record.id} AND status = 'requested'
         RETURNING *
      `;
      if (!updated[0]) return { ok: false as const, reason: 'already_decided' as const };
      return {
        ok: true as const,
        record: rowToRecord(updated[0]),
        consumedChallengeId: consumed.challengeId,
      };
    } else {
      const updated = await tx<ConsentRow[]>`
        UPDATE commerce_consent_records
           SET status = 'denied',
               denied_at = NOW(),
               user_principal_id = ${principalId},
               updated_at = NOW()
         WHERE id = ${record.id} AND status = 'requested'
         RETURNING *
      `;
      if (!updated[0]) return { ok: false as const, reason: 'already_decided' as const };
      return {
        ok: true as const,
        record: rowToRecord(updated[0]),
        consumedChallengeId: consumed.challengeId,
      };
    }
  });
}

export function approveConsent(
  sql: Sql,
  consentRequestId: string,
  authenticatedPrincipalId: string,
): Promise<ConsentDecisionResult> {
  return decideConsent(sql, consentRequestId, 'granted', authenticatedPrincipalId);
}

export function denyConsent(
  sql: Sql,
  consentRequestId: string,
  authenticatedPrincipalId: string,
): Promise<ConsentDecisionResult> {
  return decideConsent(sql, consentRequestId, 'denied', authenticatedPrincipalId);
}

/**
 * Per-form CSRF token derivation (Finding 1):
 *   csrf = sha256(principal_session_token + ':' + consent_request_id)
 *
 * The principal session token is the secret. An attacker on another
 * origin cannot read the cookie (HttpOnly, SameSite=Strict) and cannot
 * compute this token without it. The token is bound to the specific
 * consent_request_id so a leaked token from one consent can't approve
 * another.
 */
export function deriveConsentCsrfToken(
  principalSessionToken: string,
  consentRequestId: string,
): string {
  return sha256hex(`${principalSessionToken}:${consentRequestId}`);
}

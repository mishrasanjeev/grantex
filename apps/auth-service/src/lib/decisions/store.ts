/**
 * Postgres operations for decision grants (PRD G-3). Every operation that
 * changes authority runs in one transaction with row locks taken in a fixed
 * order (case, request, its grants, then the developer's audit chain), so
 * concurrent approvals and consumptions serialise instead of racing:
 *
 * - a `jti` is consumed by `UPDATE ... WHERE consumed_at IS NULL`, so of two
 *   parallel consumptions exactly one succeeds;
 * - `UNIQUE (request_id, approver_sub)` and `UNIQUE (request_id,
 *   approval_position)` make a second approval by the same person, or a third
 *   approval, impossible even under a race;
 * - the audit entry is written in the same transaction as the change it
 *   records, so there is no minted or consumed grant without its entry.
 */
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import { ulid } from 'ulid';
import { computeAuditHash } from '../hash.js';
import { newAuditEntryId } from '../ids.js';
import { decrypt, encrypt } from '../vault-crypto.js';
import { computeActionHash, type DecisionAction } from './action.js';
import { canonicalize } from './canonical.js';
import type { ApproverIdp } from './approver-oidc.js';
import { approverEmailHash, encryptApproverName } from './personal-data.js';
import {
  DecisionError,
  DecisionSubReason,
  approverAuthMethod,
  approverSubject,
  assertStepUp,
  decisionGrantExpiry,
  serverDwellMs,
  type ApproverClaims,
  type DwellPolicy,
  type StepUpPolicy,
} from './policy.js';
import {
  signDecisionGrant,
  verifyDecisionGrantSignature,
  DecisionTokenError,
  type DecisionGrantClaims,
  type FourEyesClaim,
} from './token.js';

export type Sql = ReturnType<typeof postgres>;

export const newDecisionRequestId = (): string => `dreq_${ulid()}`;
export const newDecisionGrantId = (): string => `dgnt_${ulid()}`;
export const newApproverSessionId = (): string => `dsess_${ulid()}`;
export const newPageViewId = (): string => `dview_${ulid()}`;
export const newApproverIdpId = (): string => `dapi_${ulid()}`;

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const contentHash = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('base64url')}`;

export interface DecisionRequestRow {
  id: string;
  developer_id: string;
  case_id: string;
  case_version: string;
  connector: string;
  action: DecisionAction;
  action_hash: string;
  approvals_required: number;
  memo_ref: string | null;
  memo_content: string;
  memo_hash: string;
  policy_score_ref: string | null;
  policy_score: unknown;
  policy_score_hash: string;
  agent_id: string | null;
  grant_id: string | null;
  status: 'pending' | 'approved' | 'consumed' | 'superseded' | 'cancelled';
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface DecisionGrantRow {
  jti: string;
  developer_id: string;
  request_id: string;
  session_id: string;
  approver_sub: string;
  approver_email_hash: string | null;
  approver_auth: string;
  dwell_ms: number;
  dwell_source: 'server';
  case_id: string;
  case_version: string;
  action_hash: string;
  approval_position: number;
  first_jti: string | null;
  claims: DecisionGrantClaims;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

export interface ApproverSessionRow {
  id: string;
  developer_id: string;
  idp_id: string;
  issuer: string;
  idp_subject: string;
  subject: string;
  email_hash: string | null;
  name_encrypted: string | null;
  acr: string | null;
  amr: string[];
  approver_auth: string;
  auth_time: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface ApproverIdpRow {
  id: string;
  developer_id: string;
  issuer: string;
  client_id: string;
  client_secret_encrypted: string | null;
  acr_values: string[];
  require_verified_email: boolean;
  display_name: string;
  status: 'active' | 'disabled';
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function tx(value: unknown): Sql {
  return value as Sql;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '23505';
}

// ── Audit ────────────────────────────────────────────────────────────────

export interface DecisionAuditEntry {
  developerId: string;
  action: 'decision.requested' | 'decision.approved' | 'decision.consumed' | 'decision.consume_refused'
    | 'decision.case_changed' | 'decision.cancelled' | 'decision.approver_signed_in'
    | 'decision.approver_idp_added' | 'decision.approver_idp_disabled';
  principalId: string;
  agentId?: string | null;
  grantId?: string | null;
  status?: 'success' | 'blocked';
  metadata: Record<string, unknown>;
}

/**
 * Appends an entry to the developer's audit hash chain inside the caller's
 * transaction (same lock and hash as POST /v1/audit/log). Decision records are
 * security records, so the plan's audit-entry limit does not apply to them.
 */
export async function appendDecisionAudit(sql: Sql, entry: DecisionAuditEntry): Promise<string> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${entry.developerId}, 0))`;
  const last = await sql<{ hash: string }[]>`
    SELECT hash FROM audit_entries
    WHERE developer_id = ${entry.developerId}
    ORDER BY timestamp DESC, id DESC
    LIMIT 1
  `;
  const prevHash = last[0]?.hash ?? null;
  const id = newAuditEntryId();
  const timestamp = new Date().toISOString();
  const fields = {
    id,
    agentId: entry.agentId ?? '',
    agentDid: '',
    grantId: entry.grantId ?? '',
    principalId: entry.principalId,
    developerId: entry.developerId,
    action: entry.action,
    metadata: entry.metadata,
    timestamp,
    prevHash,
    status: entry.status ?? 'success',
  };
  const hash = computeAuditHash(fields);
  await sql`
    INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
    VALUES (${id}, ${fields.agentId}, ${fields.agentDid}, ${fields.grantId}, ${fields.principalId}, ${fields.developerId},
            ${fields.action}, ${sql.json(fields.metadata as postgres.JSONValue)}, ${hash}, ${prevHash}, ${timestamp}, ${fields.status})
  `;
  return id;
}

// ── Approver identity providers (service administrator only) ─────────────

export interface CreateApproverIdpInput {
  developerId: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  acrValues: string[];
  requireVerifiedEmail: boolean;
  displayName: string;
  actor: string;
}

export async function createApproverIdp(sql: Sql, input: CreateApproverIdpInput): Promise<ApproverIdpRow> {
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const developer = await t`SELECT id FROM developers WHERE id = ${input.developerId}`;
    if (developer.length === 0) throw new DecisionError(DecisionSubReason.MALFORMED, 404, 'Developer not found');
    const id = newApproverIdpId();
    let rows: ApproverIdpRow[];
    try {
      await t`SAVEPOINT approver_idp_insert`;
      rows = await t<ApproverIdpRow[]>`
        INSERT INTO decision_approver_idps
          (id, developer_id, issuer, client_id, client_secret_encrypted, acr_values, require_verified_email, display_name, created_by)
        VALUES (${id}, ${input.developerId}, ${input.issuer}, ${input.clientId},
                ${input.clientSecret !== undefined ? encrypt(input.clientSecret) : null}, ${input.acrValues},
                ${input.requireVerifiedEmail}, ${input.displayName}, ${input.actor})
        RETURNING *
      `;
      await t`RELEASE SAVEPOINT approver_idp_insert`;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DecisionError(DecisionSubReason.CLOSED, 409, 'This identity provider client is already configured for the developer');
      }
      throw err;
    }
    await appendDecisionAudit(t, {
      developerId: input.developerId,
      action: 'decision.approver_idp_added',
      principalId: `admin:${input.actor}`,
      metadata: {
        idp_id: id,
        issuer: input.issuer,
        client_id: input.clientId,
        confidential_client: input.clientSecret !== undefined,
        acr_values: input.acrValues,
        require_verified_email: input.requireVerifiedEmail,
        actor: input.actor,
      },
    });
    return rows[0]!;
  }) as Promise<ApproverIdpRow>;
}

export async function listApproverIdps(sql: Sql, developerId: string): Promise<ApproverIdpRow[]> {
  return sql<ApproverIdpRow[]>`
    SELECT * FROM decision_approver_idps WHERE developer_id = ${developerId} ORDER BY created_at
  `;
}

export async function disableApproverIdp(sql: Sql, developerId: string, idpId: string, actor: string): Promise<ApproverIdpRow | null> {
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const rows = await t<ApproverIdpRow[]>`
      UPDATE decision_approver_idps SET status = 'disabled', updated_at = NOW()
      WHERE id = ${idpId} AND developer_id = ${developerId} AND status = 'active'
      RETURNING *
    `;
    if (!rows[0]) return null;
    // Sessions from a disabled provider end immediately.
    await t`
      UPDATE decision_approver_sessions SET revoked_at = NOW()
      WHERE idp_id = ${idpId} AND revoked_at IS NULL
    `;
    await appendDecisionAudit(t, {
      developerId,
      action: 'decision.approver_idp_disabled',
      principalId: `admin:${actor}`,
      metadata: { idp_id: idpId, issuer: rows[0].issuer, actor },
    });
    return rows[0];
  }) as Promise<ApproverIdpRow | null>;
}

export function toApproverIdp(row: ApproverIdpRow): ApproverIdp {
  return {
    id: row.id,
    issuer: row.issuer,
    clientId: row.client_id,
    ...(row.client_secret_encrypted !== null ? { clientSecret: decrypt(row.client_secret_encrypted) } : {}),
    acrValues: row.acr_values,
  };
}

// ── Browser sign-in ──────────────────────────────────────────────────────

export async function createLoginState(
  sql: Sql,
  input: { developerId: string; idpId: string; requestId: string; state: string; nonce: string; codeVerifier: string; browserBinding: string; ttlSeconds: number },
): Promise<void> {
  await sql`
    INSERT INTO decision_login_states
      (state_hash, developer_id, idp_id, request_id, nonce, code_verifier_encrypted, browser_binding_hash, expires_at)
    VALUES (${sha256Hex(input.state)}, ${input.developerId}, ${input.idpId}, ${input.requestId}, ${input.nonce},
            ${encrypt(input.codeVerifier)}, ${sha256Hex(input.browserBinding)}, NOW() + make_interval(secs => ${input.ttlSeconds}))
  `;
}

export interface LoginState {
  developerId: string;
  idpId: string;
  requestId: string;
  nonce: string;
  codeVerifier: string;
}

/** Consumes a sign-in state once, only for the browser that started it. */
export async function consumeLoginState(sql: Sql, state: string, browserBinding: string | undefined): Promise<LoginState | null> {
  if (typeof state !== 'string' || state.length === 0 || state.length > 128 || !browserBinding) return null;
  const rows = await sql<{ developer_id: string; idp_id: string; request_id: string; nonce: string; code_verifier_encrypted: string }[]>`
    UPDATE decision_login_states SET used_at = NOW()
    WHERE state_hash = ${sha256Hex(state)} AND used_at IS NULL AND expires_at > NOW()
      AND browser_binding_hash = ${sha256Hex(browserBinding)}
    RETURNING developer_id, idp_id, request_id, nonce, code_verifier_encrypted
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    developerId: row.developer_id,
    idpId: row.idp_id,
    requestId: row.request_id,
    nonce: row.nonce,
    codeVerifier: decrypt(row.code_verifier_encrypted),
  };
}

// ── Approver sessions ────────────────────────────────────────────────────

export interface CreateApproverSessionInput {
  developerId: string;
  idp: ApproverIdpRow;
  claims: ApproverClaims;
  nonce: string;
  stepUp: StepUpPolicy;
  nowSeconds: number;
}

/** Creates a session after a verified sign-in; returns the row and the secret for the cookie. */
export async function createApproverSession(sql: Sql, input: CreateApproverSessionInput): Promise<{ session: ApproverSessionRow; secret: string }> {
  assertStepUp(input.claims, input.nowSeconds, input.stepUp);
  if (input.idp.require_verified_email && input.claims.verifiedEmail === undefined) {
    throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 403, 'This identity provider must supply a verified email for approvers');
  }
  const secret = randomBytes(32).toString('base64url');
  const id = newApproverSessionId();
  const subject = approverSubject(input.idp.issuer, input.claims.subject);
  const expiresAt = new Date((input.claims.authTime + input.stepUp.maxAgeSeconds) * 1000);
  return sql.begin(async (raw) => {
    const t = tx(raw);
    let rows: ApproverSessionRow[];
    try {
      await t`SAVEPOINT approver_session_insert`;
      rows = await t<ApproverSessionRow[]>`
        INSERT INTO decision_approver_sessions
          (id, developer_id, idp_id, issuer, idp_subject, subject, email_hash, name_encrypted, acr, amr, approver_auth,
           auth_time, nonce, session_secret_hash, expires_at)
        VALUES (${id}, ${input.developerId}, ${input.idp.id}, ${input.idp.issuer}, ${input.claims.subject}, ${subject},
                ${input.claims.verifiedEmail !== undefined ? approverEmailHash(input.claims.verifiedEmail) : null},
                ${input.claims.name !== undefined ? encryptApproverName(input.claims.name) : null},
                ${input.claims.acr ?? null}, ${input.claims.amr}, ${approverAuthMethod(input.claims)},
                ${new Date(input.claims.authTime * 1000)}, ${input.nonce}, ${sha256Hex(secret)}, ${expiresAt})
        RETURNING *
      `;
      await t`RELEASE SAVEPOINT approver_session_insert`;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DecisionError(DecisionSubReason.CONSUMED, 409, 'This sign-in has already been used');
      }
      throw err;
    }
    const session = rows[0]!;
    await appendDecisionAudit(t, {
      developerId: input.developerId,
      action: 'decision.approver_signed_in',
      principalId: subject,
      metadata: {
        session_id: id,
        idp_id: input.idp.id,
        idp: input.idp.issuer,
        approver_auth: session.approver_auth,
        acr: session.acr,
        amr: session.amr,
        auth_time: input.claims.authTime,
        email_hash: session.email_hash,
        expires_at: expiresAt.toISOString(),
      },
    });
    return { session, secret };
  }) as Promise<{ session: ApproverSessionRow; secret: string }>;
}

/** The live session for a cookie secret, or null. */
export async function sessionBySecret(sql: Sql, secret: string | undefined): Promise<ApproverSessionRow | null> {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const rows = await sql<ApproverSessionRow[]>`
    SELECT s.* FROM decision_approver_sessions s
    JOIN decision_approver_idps i ON i.id = s.idp_id
    WHERE s.session_secret_hash = ${sha256Hex(secret)}
      AND s.revoked_at IS NULL AND s.expires_at > NOW() AND i.status = 'active'
  `;
  return rows[0] ?? null;
}

export async function revokeApproverSession(sql: Sql, sessionId: string): Promise<void> {
  await sql`UPDATE decision_approver_sessions SET revoked_at = NOW() WHERE id = ${sessionId} AND revoked_at IS NULL`;
}

// ── Cases ────────────────────────────────────────────────────────────────

export interface CaseVersionResult {
  caseId: string;
  caseVersion: string;
  previousVersion: string | null;
  supersededRequests: number;
  revokedGrants: number;
}

/** Locks the case row, creating it first when absent (safe under concurrent creation). */
async function lockCase(t: Sql, developerId: string, caseId: string, caseVersion: string): Promise<{ current: string; created: boolean }> {
  const inserted = await t`
    INSERT INTO decision_cases (developer_id, case_id, case_version)
    VALUES (${developerId}, ${caseId}, ${caseVersion})
    ON CONFLICT (developer_id, case_id) DO NOTHING
    RETURNING case_id
  `;
  const rows = await t<{ case_version: string }[]>`
    SELECT case_version FROM decision_cases
    WHERE developer_id = ${developerId} AND case_id = ${caseId}
    FOR UPDATE
  `;
  return { current: rows[0]!.case_version, created: inserted.length > 0 };
}

/**
 * Registers the current version of a case. A different version supersedes
 * the case's open requests and revokes its unconsumed decision grants
 * (`case_changed`).
 */
export async function setCaseVersion(sql: Sql, developerId: string, caseId: string, caseVersion: string): Promise<CaseVersionResult> {
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const { current, created } = await lockCase(t, developerId, caseId, caseVersion);
    const previousVersion = created ? null : current;
    if (!created && current !== caseVersion) {
      await t`
        UPDATE decision_cases SET case_version = ${caseVersion}, updated_at = NOW()
        WHERE developer_id = ${developerId} AND case_id = ${caseId}
      `;
    }
    const superseded = await t`
      UPDATE decision_requests SET status = 'superseded', updated_at = NOW()
      WHERE developer_id = ${developerId} AND case_id = ${caseId}
        AND status IN ('pending', 'approved') AND case_version <> ${caseVersion}
      RETURNING id
    `;
    const revoked = await t`
      UPDATE decision_grants SET revoked_at = NOW(), revoked_reason = 'case_changed'
      WHERE developer_id = ${developerId} AND case_id = ${caseId}
        AND consumed_at IS NULL AND revoked_at IS NULL AND case_version <> ${caseVersion}
      RETURNING jti
    `;
    if (previousVersion !== null && previousVersion !== caseVersion) {
      await appendDecisionAudit(t, {
        developerId,
        action: 'decision.case_changed',
        principalId: 'platform',
        metadata: {
          case_id: caseId,
          previous_case_version: previousVersion,
          case_version: caseVersion,
          superseded_requests: superseded.map((r) => r['id']),
          revoked_decision_grants: revoked.map((r) => r['jti']),
        },
      });
    }
    return {
      caseId,
      caseVersion,
      previousVersion,
      supersededRequests: superseded.length,
      revokedGrants: revoked.length,
    };
  }) as Promise<CaseVersionResult>;
}

// ── Requests ─────────────────────────────────────────────────────────────

export const MAX_MEMO_LENGTH = 65_536;
export const MAX_POLICY_SCORE_BYTES = 32_768;

export interface ReviewContent {
  memo: string;
  memoHash: string;
  policyScore: unknown;
  policyScoreHash: string;
}

/**
 * Validates the memo (text) and policy score (JSON value) a person will
 * review, and computes their hashes: SHA-256 of the memo's UTF-8 and of the
 * policy score's RFC 8785 canonical JSON. A supplied hash must match.
 */
export function reviewContent(memo: unknown, memoHash: unknown, policyScore: unknown, policyScoreHash: unknown): ReviewContent {
  if (typeof memo !== 'string' || memo.length === 0 || memo.length > MAX_MEMO_LENGTH || memo.includes('\u0000')) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, `memo.content must be 1-${MAX_MEMO_LENGTH} characters of text`);
  }
  let canonicalScore: string;
  try {
    canonicalScore = canonicalize(policyScore);
  } catch {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'policyScore.content must be a JSON value');
  }
  if (policyScore === null || typeof policyScore !== 'object' || Buffer.byteLength(canonicalScore) > MAX_POLICY_SCORE_BYTES) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, `policyScore.content must be a JSON object or array of at most ${MAX_POLICY_SCORE_BYTES} bytes`);
  }
  const computedMemo = contentHash(memo);
  const computedScore = contentHash(canonicalScore);
  if (memoHash !== undefined && memoHash !== computedMemo) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'memo.hash does not match memo.content');
  }
  if (policyScoreHash !== undefined && policyScoreHash !== computedScore) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'policyScore.hash does not match policyScore.content');
  }
  return { memo, memoHash: computedMemo, policyScore, policyScoreHash: computedScore };
}

export interface CreateDecisionRequestInput {
  developerId: string;
  action: DecisionAction;
  connector: string;
  caseVersion: string;
  approvalsRequired: 1 | 2;
  expiresInSeconds: number;
  review: ReviewContent;
  memoRef?: string;
  policyScoreRef?: string;
  agentId?: string;
  grantId?: string;
}

export async function createDecisionRequest(
  sql: Sql,
  input: CreateDecisionRequestInput,
): Promise<{ request: DecisionRequestRow; created: boolean }> {
  const actionHash = computeActionHash(input.action);
  const caseId = input.action.case_id;
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const { current } = await lockCase(t, input.developerId, caseId, input.caseVersion);
    if (current !== input.caseVersion) {
      throw new DecisionError(
        DecisionSubReason.CASE_CHANGED,
        409,
        'caseVersion is not the current version of this case; register the new version first',
      );
    }
    const id = newDecisionRequestId();
    const inserted = await t<DecisionRequestRow[]>`
      INSERT INTO decision_requests
        (id, developer_id, case_id, case_version, connector, action, action_hash, approvals_required,
         memo_ref, memo_content, memo_hash, policy_score_ref, policy_score, policy_score_hash, agent_id, grant_id, expires_at)
      VALUES (${id}, ${input.developerId}, ${caseId}, ${input.caseVersion}, ${input.connector},
              ${t.json(input.action as unknown as postgres.JSONValue)}, ${actionHash}, ${input.approvalsRequired},
              ${input.memoRef ?? null}, ${input.review.memo}, ${input.review.memoHash},
              ${input.policyScoreRef ?? null}, ${t.json(input.review.policyScore as postgres.JSONValue)}, ${input.review.policyScoreHash},
              ${input.agentId ?? null}, ${input.grantId ?? null},
              NOW() + make_interval(secs => ${input.expiresInSeconds}))
      ON CONFLICT (developer_id, action_hash, case_version) WHERE status IN ('pending', 'approved') DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) {
      await appendDecisionAudit(t, {
        developerId: input.developerId,
        action: 'decision.requested',
        principalId: 'platform',
        agentId: input.agentId ?? null,
        grantId: input.grantId ?? null,
        metadata: {
          request_id: id,
          action: input.action,
          action_hash: actionHash,
          connector: input.connector,
          case_version: input.caseVersion,
          approvals_required: input.approvalsRequired,
          memo_hash: input.review.memoHash,
          policy_score_hash: input.review.policyScoreHash,
          ...(input.memoRef !== undefined ? { memo_ref: input.memoRef } : {}),
          ...(input.policyScoreRef !== undefined ? { policy_score_ref: input.policyScoreRef } : {}),
        },
      });
      return { request: inserted[0], created: true };
    }
    const existing = await t<DecisionRequestRow[]>`
      SELECT * FROM decision_requests
      WHERE developer_id = ${input.developerId} AND action_hash = ${actionHash}
        AND case_version = ${input.caseVersion} AND status IN ('pending', 'approved')
    `;
    const row = existing[0];
    if (!row) throw new Error('decision request insert conflicted but no open request was found');
    if (row.approvals_required !== input.approvalsRequired || row.connector !== input.connector
        || row.memo_hash !== input.review.memoHash || row.policy_score_hash !== input.review.policyScoreHash) {
      throw new DecisionError(
        DecisionSubReason.CLOSED,
        409,
        'An open decision request for this action exists with a different connector, approval requirement, memo or policy score',
      );
    }
    return { request: row, created: false };
  }) as Promise<{ request: DecisionRequestRow; created: boolean }>;
}

export async function getDecisionRequest(
  sql: Sql,
  developerId: string,
  requestId: string,
): Promise<{ request: DecisionRequestRow; grants: DecisionGrantRow[] } | null> {
  const rows = await sql<DecisionRequestRow[]>`
    SELECT * FROM decision_requests WHERE id = ${requestId} AND developer_id = ${developerId}
  `;
  const request = rows[0];
  if (!request) return null;
  const grants = await sql<DecisionGrantRow[]>`
    SELECT * FROM decision_grants
    WHERE request_id = ${requestId} AND developer_id = ${developerId}
    ORDER BY approval_position
  `;
  return { request, grants };
}

/** The developer a request belongs to, for the sign-in page (no content). */
export async function requestDeveloper(sql: Sql, requestId: string): Promise<string | null> {
  const rows = await sql<{ developer_id: string }[]>`SELECT developer_id FROM decision_requests WHERE id = ${requestId}`;
  return rows[0]?.developer_id ?? null;
}

export async function cancelDecisionRequest(sql: Sql, developerId: string, requestId: string): Promise<DecisionRequestRow | null> {
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const rows = await t<DecisionRequestRow[]>`
      UPDATE decision_requests SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${requestId} AND developer_id = ${developerId} AND status IN ('pending', 'approved')
      RETURNING *
    `;
    const row = rows[0];
    if (!row) return null;
    const revoked = await t`
      UPDATE decision_grants SET revoked_at = NOW(), revoked_reason = 'cancelled'
      WHERE request_id = ${requestId} AND developer_id = ${developerId}
        AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING jti
    `;
    await appendDecisionAudit(t, {
      developerId,
      action: 'decision.cancelled',
      principalId: 'platform',
      agentId: row.agent_id,
      grantId: row.grant_id,
      metadata: { request_id: requestId, revoked_decision_grants: revoked.map((r) => r['jti']) },
    });
    return row;
  }) as Promise<DecisionRequestRow | null>;
}

// ── Approval (only from the approval page) ───────────────────────────────

export interface ApproveInput {
  session: ApproverSessionRow;
  requestId: string;
  /** The action hash embedded in the page the approver submitted. */
  actionHash: unknown;
  viewId: string;
  stepUp: StepUpPolicy;
  dwellPolicy: DwellPolicy;
}

export interface ApproveResult {
  token: string;
  claims: DecisionGrantClaims;
  request: DecisionRequestRow;
  approvalsReceived: number;
}

function refusalForStatus(status: DecisionRequestRow['status']): DecisionError {
  switch (status) {
    case 'superseded':
      return new DecisionError(DecisionSubReason.CASE_CHANGED, 409, 'The case changed after this decision was requested');
    case 'consumed':
      return new DecisionError(DecisionSubReason.CONSUMED, 409, 'This decision has already been used');
    default:
      return new DecisionError(DecisionSubReason.CLOSED, 409, `This decision request is ${status}`);
  }
}

export async function approveDecisionRequest(sql: Sql, input: ApproveInput): Promise<ApproveResult> {
  const session = input.session;
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const requests = await t<DecisionRequestRow[]>`
      SELECT * FROM decision_requests
      WHERE id = ${input.requestId} AND developer_id = ${session.developer_id}
      FOR UPDATE
    `;
    const request = requests[0];
    if (!request) throw new DecisionError(DecisionSubReason.UNKNOWN_GRANT, 404, 'Decision request not found');
    const live = await t<ApproverSessionRow[]>`
      SELECT s.* FROM decision_approver_sessions s
      JOIN decision_approver_idps i ON i.id = s.idp_id
      WHERE s.id = ${session.id} AND s.revoked_at IS NULL AND s.expires_at > NOW() AND i.status = 'active'
    `;
    if (!live[0]) throw new DecisionError(DecisionSubReason.STEP_UP_REQUIRED, 403, 'Your approver session has ended; sign in again');
    assertStepUp(
      { ...(session.acr !== null ? { acr: session.acr } : {}), amr: session.amr, authTime: Math.floor(session.auth_time.getTime() / 1000) },
      nowSeconds,
      input.stepUp,
    );

    if (request.status !== 'pending') throw refusalForStatus(request.status);
    if (request.expires_at.getTime() <= now.getTime()) {
      throw new DecisionError(DecisionSubReason.EXPIRED, 410, 'This decision request has expired');
    }
    const current = await t<{ case_version: string }[]>`
      SELECT case_version FROM decision_cases WHERE developer_id = ${session.developer_id} AND case_id = ${request.case_id}
    `;
    if (!current[0] || current[0].case_version !== request.case_version) {
      throw new DecisionError(DecisionSubReason.CASE_CHANGED, 409, 'The case changed after this decision was requested');
    }
    if (typeof input.actionHash !== 'string' || input.actionHash !== request.action_hash) {
      throw new DecisionError(
        DecisionSubReason.ACTION_MISMATCH,
        409,
        'The action approved is not the action this request is for; reload the decision and review it again',
      );
    }

    const views = await t<{ rendered_at: Date; now: Date }[]>`
      UPDATE decision_page_views SET submitted_at = NOW()
      WHERE id = ${input.viewId} AND request_id = ${request.id} AND session_id = ${session.id}
        AND submitted_at IS NULL
      RETURNING rendered_at, NOW() AS now
    `;
    const view = views[0];
    if (!view) throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'The approval page was not rendered for this session, or was already submitted');
    // Both timestamps come from the database clock.
    const dwellMs = serverDwellMs(view.rendered_at.getTime(), view.now.getTime(), input.dwellPolicy);

    const existing = await t<DecisionGrantRow[]>`
      SELECT * FROM decision_grants
      WHERE request_id = ${request.id}
      ORDER BY approval_position
      FOR UPDATE
    `;
    const sub = session.subject;
    const sameApprover = existing.find((g) => g.approver_sub === sub
      || (session.email_hash !== null && g.approver_email_hash !== null && g.approver_email_hash === session.email_hash));
    if (sameApprover) {
      throw new DecisionError(
        DecisionSubReason.SAME_APPROVER,
        409,
        'This decision needs a second approver; the same person cannot approve it twice',
      );
    }
    const position = existing.length + 1;
    if (position > request.approvals_required) throw new DecisionError(DecisionSubReason.CLOSED, 409, 'This decision request is already approved');
    const first = existing[0];

    let fourEyes: FourEyesClaim | undefined;
    if (request.approvals_required === 2) {
      fourEyes = position === 1
        ? { approvals_required: 2, position: 1 }
        : { approvals_required: 2, position: 2, first_jti: first!.jti, first_sub: first!.approver_sub };
    }
    const jti = newDecisionGrantId();
    const exp = decisionGrantExpiry(nowSeconds, request.expires_at.getTime());
    if (exp <= nowSeconds) throw new DecisionError(DecisionSubReason.EXPIRED, 410, 'This decision request has expired');
    const token = await signDecisionGrant({
      sub,
      jti,
      iat: nowSeconds,
      exp,
      dev: session.developer_id,
      idp: session.issuer,
      approver_auth: session.approver_auth,
      ...(session.acr !== null ? { acr: session.acr } : {}),
      amr: session.amr,
      auth_time: Math.floor(session.auth_time.getTime() / 1000),
      action: request.action,
      action_hash: request.action_hash,
      connector: request.connector,
      case_version: request.case_version,
      dwell_ms: dwellMs,
      dwell_source: 'server',
      decision_request: request.id,
      memo_hash: request.memo_hash,
      policy_score_hash: request.policy_score_hash,
      ...(request.memo_ref !== null ? { memo_ref: request.memo_ref } : {}),
      ...(request.policy_score_ref !== null ? { policy_score_ref: request.policy_score_ref } : {}),
      ...(fourEyes !== undefined ? { four_eyes: fourEyes } : {}),
    });
    const claims = await verifyDecisionGrantSignature(token);

    try {
      await t`SAVEPOINT decision_grant_insert`;
      await t`
        INSERT INTO decision_grants
          (jti, developer_id, request_id, session_id, approver_sub, approver_email_hash, approver_auth, dwell_ms, dwell_source,
           case_id, case_version, action_hash, approval_position, first_jti, claims, issued_at, expires_at)
        VALUES (${jti}, ${session.developer_id}, ${request.id}, ${session.id}, ${sub}, ${session.email_hash}, ${session.approver_auth},
                ${dwellMs}, 'server', ${request.case_id}, ${request.case_version}, ${request.action_hash}, ${position}, ${first?.jti ?? null},
                ${t.json(claims as unknown as postgres.JSONValue)}, ${new Date(nowSeconds * 1000)}, ${new Date(exp * 1000)})
      `;
      await t`RELEASE SAVEPOINT decision_grant_insert`;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const constraint = (err as { constraint_name?: string }).constraint_name ?? '';
        throw constraint.includes('approver_sub')
          ? new DecisionError(DecisionSubReason.SAME_APPROVER, 409, 'The same person cannot approve this decision twice')
          : new DecisionError(DecisionSubReason.CLOSED, 409, 'This decision request was approved concurrently');
      }
      throw err;
    }
    let updated = request;
    if (position === request.approvals_required) {
      const rows = await t<DecisionRequestRow[]>`
        UPDATE decision_requests SET status = 'approved', updated_at = NOW()
        WHERE id = ${request.id} RETURNING *
      `;
      updated = rows[0] ?? request;
    }
    await appendDecisionAudit(t, {
      developerId: session.developer_id,
      action: 'decision.approved',
      principalId: sub,
      agentId: request.agent_id,
      grantId: request.grant_id,
      metadata: {
        request_id: request.id,
        jti,
        approver: { sub, idp: session.issuer, idp_id: session.idp_id, session_id: session.id, email_hash: session.email_hash },
        approver_auth: session.approver_auth,
        acr: session.acr,
        amr: session.amr,
        auth_time: claims.auth_time,
        dwell_ms: dwellMs,
        dwell_source: 'server',
        action: request.action,
        action_hash: request.action_hash,
        connector: request.connector,
        case_version: request.case_version,
        memo_hash: request.memo_hash,
        policy_score_hash: request.policy_score_hash,
        approval_position: position,
        approvals_required: request.approvals_required,
        ...(first ? { first_jti: first.jti } : {}),
        expires_at: new Date(exp * 1000).toISOString(),
      },
    });
    return { token, claims, request: updated, approvalsReceived: position };
  }) as Promise<ApproveResult>;
}

// ── Consumption ──────────────────────────────────────────────────────────

export interface ConsumeInput {
  developerId: string;
  tokens: unknown;
  /** The action the caller is about to perform. */
  action: unknown;
  caseVersion: unknown;
  agentId?: string;
  grantId?: string;
}

export interface ConsumeResult {
  requestId: string;
  jtis: string[];
  /**
   * One entry per consumed grant, each naming the grant it came from. `jtis`
   * carries the same identifiers without the approvers; a platform recording
   * who decided needs the pair, and must not have to assume that two separate
   * arrays line up.
   */
  approvers: { sub: string; approver_auth: string; dwell_ms: number; dwell_source: string; jti: string }[];
  actionHash: string;
}

function refuse(subReason: DecisionSubReason, message: string, status = 409): DecisionError {
  return new DecisionError(subReason, status, message);
}

/**
 * Verifies and atomically consumes the decision grants that authorise one
 * action: one grant, or two with different approvers when the request needs
 * four eyes. Either every grant is consumed or none is.
 */
export async function consumeDecisionGrants(sql: Sql, input: ConsumeInput): Promise<ConsumeResult> {
  if (!Array.isArray(input.tokens) || input.tokens.length < 1 || input.tokens.length > 2) {
    throw refuse(DecisionSubReason.MALFORMED, 'decisionGrants must be an array of one or two tokens', 400);
  }
  let expected: DecisionAction;
  let expectedHash: string;
  try {
    expectedHash = computeActionHash(input.action as DecisionAction);
    expected = input.action as DecisionAction;
  } catch {
    throw refuse(DecisionSubReason.MALFORMED, 'action is not a valid semantic action', 400);
  }
  if (typeof input.caseVersion !== 'string' || input.caseVersion.length === 0) {
    throw refuse(DecisionSubReason.MALFORMED, 'caseVersion is required', 400);
  }
  const caseVersion = input.caseVersion;

  const presented: DecisionGrantClaims[] = [];
  for (const token of input.tokens) {
    try {
      presented.push(await verifyDecisionGrantSignature(token as string));
    } catch (err) {
      if (err instanceof DecisionTokenError) throw refuse(DecisionSubReason.MALFORMED, err.message, 400);
      throw err;
    }
  }
  // A grant of another developer is indistinguishable from an unknown one.
  if (presented.some((c) => c.dev !== input.developerId)) {
    throw refuse(DecisionSubReason.UNKNOWN_GRANT, 'Decision grant not found');
  }
  const jtis = presented.map((c) => c.jti);
  if (new Set(jtis).size !== jtis.length) {
    throw refuse(DecisionSubReason.SAME_APPROVER, 'The same decision grant was presented twice');
  }
  const requestIds = new Set(presented.map((c) => c.decision_request));
  if (requestIds.size !== 1) {
    throw refuse(DecisionSubReason.ACTION_MISMATCH, 'The decision grants belong to different decisions');
  }
  const requestId = presented[0]!.decision_request;

  return sql.begin(async (raw) => {
    const t = tx(raw);
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const requests = await t<DecisionRequestRow[]>`
      SELECT * FROM decision_requests
      WHERE id = ${requestId} AND developer_id = ${input.developerId}
      FOR UPDATE
    `;
    const request = requests[0];
    if (!request) throw refuse(DecisionSubReason.UNKNOWN_GRANT, 'Decision grant not found');
    const rows = await t<DecisionGrantRow[]>`
      SELECT * FROM decision_grants
      WHERE jti = ANY(${jtis}) AND developer_id = ${input.developerId}
      ORDER BY approval_position
      FOR UPDATE
    `;
    if (rows.length !== jtis.length) throw refuse(DecisionSubReason.UNKNOWN_GRANT, 'Decision grant not found');
    for (const row of rows) {
      const token = presented.find((c) => c.jti === row.jti)!;
      if (canonicalize(row.claims) !== canonicalize(token)) {
        throw refuse(DecisionSubReason.MALFORMED, 'Decision grant does not match the grant that was issued', 400);
      }
    }

    // Order of checks: what the grant is for, then whether it is still usable.
    for (const row of rows) {
      if (row.case_id !== expected.case_id) throw refuse(DecisionSubReason.WRONG_CASE, 'The decision grant is for another case');
    }
    for (const row of rows) {
      if (row.action_hash !== expectedHash) throw refuse(DecisionSubReason.ACTION_MISMATCH, 'The decision grant approves a different action');
    }
    for (const row of rows) {
      if (row.consumed_at !== null) throw refuse(DecisionSubReason.CONSUMED, 'The decision grant has already been used');
    }
    for (const row of rows) {
      if (row.revoked_at !== null) {
        throw row.revoked_reason === 'case_changed'
          ? refuse(DecisionSubReason.CASE_CHANGED, 'The case changed after the decision was approved')
          : refuse(DecisionSubReason.REVOKED, 'The decision grant has been revoked');
      }
    }
    for (const row of rows) {
      if (row.expires_at.getTime() <= now.getTime()) throw refuse(DecisionSubReason.EXPIRED, 'The decision grant has expired');
    }
    const current = await t<{ case_version: string }[]>`
      SELECT case_version FROM decision_cases WHERE developer_id = ${input.developerId} AND case_id = ${request.case_id}
    `;
    for (const row of rows) {
      if (row.case_version !== caseVersion || current[0]?.case_version !== row.case_version) {
        throw refuse(DecisionSubReason.CASE_CHANGED, 'The case changed after the decision was approved');
      }
    }
    if (request.status === 'superseded') throw refuse(DecisionSubReason.CASE_CHANGED, 'The case changed after the decision was approved');
    if (request.status === 'cancelled') throw refuse(DecisionSubReason.REVOKED, 'The decision request was cancelled');

    if (rows.length < request.approvals_required) {
      throw refuse(DecisionSubReason.FOUR_EYES_INCOMPLETE, 'This decision needs two approvals from different people; present both decision grants');
    }
    if (rows.length > request.approvals_required) {
      throw refuse(DecisionSubReason.MALFORMED, 'More decision grants were presented than this decision needs', 400);
    }
    if (rows.length === 2) {
      const [a, b] = rows as unknown as [DecisionGrantRow, DecisionGrantRow];
      if (a.approver_sub === b.approver_sub
          || (a.approver_email_hash !== null && a.approver_email_hash === b.approver_email_hash)) {
        throw refuse(DecisionSubReason.SAME_APPROVER, 'Both decision grants were approved by the same person');
      }
      if (a.approval_position !== 1 || b.approval_position !== 2 || b.first_jti !== a.jti) {
        throw refuse(DecisionSubReason.MALFORMED, 'The second approval does not reference the first', 400);
      }
    }

    const consumed = await t<{ jti: string }[]>`
      UPDATE decision_grants SET consumed_at = NOW()
      WHERE jti = ANY(${jtis}) AND developer_id = ${input.developerId}
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
      RETURNING jti
    `;
    if (consumed.length !== jtis.length) {
      // Unreachable while the rows are locked; kept so a change to the locking
      // can never turn into a partial consumption.
      throw refuse(DecisionSubReason.CONSUMED, 'The decision grant has already been used');
    }
    await t`UPDATE decision_requests SET status = 'consumed', updated_at = NOW() WHERE id = ${request.id}`;
    await appendDecisionAudit(t, {
      developerId: input.developerId,
      action: 'decision.consumed',
      principalId: rows[rows.length - 1]!.approver_sub,
      agentId: input.agentId ?? request.agent_id,
      grantId: input.grantId ?? request.grant_id,
      metadata: {
        request_id: request.id,
        jtis,
        action: request.action,
        action_hash: request.action_hash,
        case_version: caseVersion,
        approvers: rows.map((r) => ({ sub: r.approver_sub, approver_auth: r.approver_auth, dwell_ms: r.dwell_ms, dwell_source: r.dwell_source, jti: r.jti })),
        consumed_at_epoch: nowSeconds,
      },
    });
    return {
      requestId: request.id,
      jtis,
      approvers: rows.map((r) => ({ sub: r.approver_sub, approver_auth: r.approver_auth, dwell_ms: r.dwell_ms, dwell_source: r.dwell_source, jti: r.jti })),
      actionHash: request.action_hash,
    };
  }) as Promise<ConsumeResult>;
}

/**
 * Records a refused consumption in its own transaction, with what was
 * attempted: the action and its hash when the action was valid, the case
 * version, and the jtis of grants whose signature verified. Throws if the
 * entry cannot be written; the caller must then fail the request.
 */
export async function auditConsumeRefusal(
  sql: Sql,
  developerId: string,
  subReason: string,
  attempt: { jtis: string[]; action: unknown; caseVersion: unknown; agentId?: string; grantId?: string },
): Promise<void> {
  let action: DecisionAction | undefined;
  let actionHash: string | undefined;
  try {
    actionHash = computeActionHash(attempt.action as DecisionAction);
    action = attempt.action as DecisionAction;
  } catch {
    // Invalid actions are recorded as such.
  }
  await sql.begin(async (raw) => {
    await appendDecisionAudit(tx(raw), {
      developerId,
      action: 'decision.consume_refused',
      principalId: 'platform',
      status: 'blocked',
      agentId: attempt.agentId ?? null,
      grantId: attempt.grantId ?? null,
      metadata: {
        sub_reason: subReason,
        jtis: attempt.jtis,
        ...(action !== undefined ? { action, action_hash: actionHash } : { action_valid: false }),
        ...(typeof attempt.caseVersion === 'string' && attempt.caseVersion.length <= 128 ? { case_version: attempt.caseVersion } : {}),
      },
    });
  });
}

// ── Page views ───────────────────────────────────────────────────────────

export async function createPageView(sql: Sql, requestId: string, sessionId: string): Promise<string> {
  const id = newPageViewId();
  await sql`INSERT INTO decision_page_views (id, request_id, session_id) VALUES (${id}, ${requestId}, ${sessionId})`;
  return id;
}

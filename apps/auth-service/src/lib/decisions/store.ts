/**
 * Postgres operations for decision grants (PRD G-3). Every operation that
 * changes authority runs in one transaction with row locks taken in a fixed
 * order (request, then its grants, then the developer's audit chain), so
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
import { computeActionHash, type DecisionAction } from './action.js';
import { canonicalize } from './canonical.js';
import {
  DecisionError,
  DecisionSubReason,
  approverAuthMethod,
  approverSubject,
  assertStepUp,
  decisionGrantExpiry,
  validateDwellMs,
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
  policy_score_ref: string | null;
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
  approver_auth: string;
  dwell_ms: number;
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
  connection_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  acr: string | null;
  amr: string[];
  approver_auth: string;
  auth_time: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function tx(value: unknown): Sql {
  return value as Sql;
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: unknown; constraint_name?: unknown };
  return e?.code === '23505' && (constraint === undefined || e.constraint_name === constraint);
}

// ── Audit ────────────────────────────────────────────────────────────────

export interface DecisionAuditEntry {
  developerId: string;
  action: 'decision.requested' | 'decision.approved' | 'decision.consumed' | 'decision.consume_refused'
    | 'decision.case_changed' | 'decision.cancelled';
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

// ── Approver sessions ────────────────────────────────────────────────────

export interface CreateApproverSessionInput {
  developerId: string;
  connectionId: string;
  issuer: string;
  claims: ApproverClaims;
  idToken: string;
  stepUp: StepUpPolicy;
  nowSeconds: number;
}

export async function createApproverSession(sql: Sql, input: CreateApproverSessionInput): Promise<ApproverSessionRow> {
  assertStepUp(input.claims, input.nowSeconds, input.stepUp);
  const id = newApproverSessionId();
  const idTokenHash = createHash('sha256').update(input.idToken).digest('hex');
  const expiresAt = new Date((input.claims.authTime + input.stepUp.maxAgeSeconds) * 1000);
  const rows = await sql<ApproverSessionRow[]>`
    INSERT INTO decision_approver_sessions
      (id, developer_id, connection_id, issuer, subject, email, name, acr, amr, approver_auth, auth_time, id_token_hash, expires_at)
    VALUES (${id}, ${input.developerId}, ${input.connectionId}, ${input.issuer}, ${input.claims.subject},
            ${input.claims.email ?? null}, ${input.claims.name ?? null}, ${input.claims.acr ?? null}, ${input.claims.amr},
            ${approverAuthMethod(input.claims)}, ${new Date(input.claims.authTime * 1000)}, ${idTokenHash}, ${expiresAt})
    ON CONFLICT (id_token_hash) DO NOTHING
    RETURNING *
  `;
  const row = rows[0];
  if (!row) {
    throw new DecisionError(DecisionSubReason.CONSUMED, 409, 'This ID token has already been exchanged for an approver session');
  }
  return row;
}

async function loadSession(sql: Sql, developerId: string, sessionId: string, now: Date): Promise<ApproverSessionRow> {
  const rows = await sql<ApproverSessionRow[]>`
    SELECT * FROM decision_approver_sessions
    WHERE id = ${sessionId} AND developer_id = ${developerId}
  `;
  const row = rows[0];
  if (!row || row.revoked_at !== null) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 401, 'Approver session is invalid or revoked');
  }
  if (row.expires_at.getTime() <= now.getTime()) {
    throw new DecisionError(DecisionSubReason.STEP_UP_REQUIRED, 403, 'Approver session has expired; step up again');
  }
  return row;
}

export async function getApproverSession(sql: Sql, developerId: string, sessionId: string): Promise<ApproverSessionRow> {
  return loadSession(sql, developerId, sessionId, new Date());
}

export async function revokeApproverSession(sql: Sql, developerId: string, sessionId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE decision_approver_sessions SET revoked_at = NOW()
    WHERE id = ${sessionId} AND developer_id = ${developerId} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

// ── Cases ────────────────────────────────────────────────────────────────

export interface CaseVersionResult {
  caseId: string;
  caseVersion: string;
  previousVersion: string | null;
  supersededRequests: number;
  revokedGrants: number;
}

/**
 * Registers the current version of a case. A different version supersedes
 * the case's open requests and revokes its unconsumed decision grants
 * (`case_changed`).
 */
export async function setCaseVersion(sql: Sql, developerId: string, caseId: string, caseVersion: string): Promise<CaseVersionResult> {
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const previous = await t<{ case_version: string }[]>`
      SELECT case_version FROM decision_cases
      WHERE developer_id = ${developerId} AND case_id = ${caseId}
      FOR UPDATE
    `;
    const previousVersion = previous[0]?.case_version ?? null;
    await t`
      INSERT INTO decision_cases (developer_id, case_id, case_version, updated_at)
      VALUES (${developerId}, ${caseId}, ${caseVersion}, NOW())
      ON CONFLICT (developer_id, case_id) DO UPDATE SET case_version = EXCLUDED.case_version, updated_at = NOW()
    `;
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

export interface CreateDecisionRequestInput {
  developerId: string;
  action: DecisionAction;
  connector: string;
  caseVersion: string;
  approvalsRequired: 1 | 2;
  expiresInSeconds: number;
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
    const current = await t<{ case_version: string }[]>`
      SELECT case_version FROM decision_cases
      WHERE developer_id = ${input.developerId} AND case_id = ${caseId}
      FOR UPDATE
    `;
    if (current[0] && current[0].case_version !== input.caseVersion) {
      throw new DecisionError(
        DecisionSubReason.CASE_CHANGED,
        409,
        'caseVersion is not the current version of this case; register the new version first',
      );
    }
    if (!current[0]) {
      await t`
        INSERT INTO decision_cases (developer_id, case_id, case_version)
        VALUES (${input.developerId}, ${caseId}, ${input.caseVersion})
      `;
    }
    const id = newDecisionRequestId();
    const inserted = await t<DecisionRequestRow[]>`
      INSERT INTO decision_requests
        (id, developer_id, case_id, case_version, connector, action, action_hash, approvals_required,
         memo_ref, policy_score_ref, agent_id, grant_id, expires_at)
      VALUES (${id}, ${input.developerId}, ${caseId}, ${input.caseVersion}, ${input.connector},
              ${t.json(input.action as unknown as postgres.JSONValue)}, ${actionHash}, ${input.approvalsRequired},
              ${input.memoRef ?? null}, ${input.policyScoreRef ?? null}, ${input.agentId ?? null}, ${input.grantId ?? null},
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
    if (row.approvals_required !== input.approvalsRequired || row.connector !== input.connector) {
      throw new DecisionError(
        DecisionSubReason.CLOSED,
        409,
        'An open decision request for this action exists with a different connector or approval requirement',
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

// ── Approval ─────────────────────────────────────────────────────────────

export type DwellSource =
  | { kind: 'reported'; dwellMs: unknown }
  | { kind: 'page_view'; viewId: string };

export interface ApproveInput {
  developerId: string;
  requestId: string;
  sessionId: string;
  /** The action hash the approval surface displayed. */
  actionHash: unknown;
  dwell: DwellSource;
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
  return sql.begin(async (raw) => {
    const t = tx(raw);
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const requests = await t<DecisionRequestRow[]>`
      SELECT * FROM decision_requests
      WHERE id = ${input.requestId} AND developer_id = ${input.developerId}
      FOR UPDATE
    `;
    const request = requests[0];
    if (!request) throw new DecisionError(DecisionSubReason.UNKNOWN_GRANT, 404, 'Decision request not found');

    const session = await loadSession(t, input.developerId, input.sessionId, now);
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
      SELECT case_version FROM decision_cases WHERE developer_id = ${input.developerId} AND case_id = ${request.case_id}
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

    let dwellMs: number;
    if (input.dwell.kind === 'reported') {
      dwellMs = validateDwellMs(input.dwell.dwellMs, request.created_at.getTime(), now.getTime(), input.dwellPolicy);
    } else {
      const views = await t<{ rendered_at: Date }[]>`
        UPDATE decision_page_views SET submitted_at = NOW()
        WHERE id = ${input.dwell.viewId} AND request_id = ${request.id} AND session_id = ${session.id}
          AND submitted_at IS NULL
        RETURNING rendered_at
      `;
      const view = views[0];
      if (!view) throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'The approval page was not rendered for this session, or was already submitted');
      dwellMs = validateDwellMs(Math.max(0, now.getTime() - view.rendered_at.getTime()), request.created_at.getTime(), now.getTime(), input.dwellPolicy);
    }

    const existing = await t<(DecisionGrantRow & { email: string | null })[]>`
      SELECT g.*, s.email FROM decision_grants g
      JOIN decision_approver_sessions s ON s.id = g.session_id
      WHERE g.request_id = ${request.id}
      ORDER BY g.approval_position
      FOR UPDATE OF g
    `;
    const sub = approverSubject(session.subject);
    const sameApprover = existing.find((g) => g.approver_sub === sub
      || (session.email !== null && g.email !== null && g.email.toLowerCase() === session.email.toLowerCase()));
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
    const claimsWithoutEnvelope = {
      sub,
      jti,
      iat: nowSeconds,
      exp,
      dev: input.developerId,
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
      decision_request: request.id,
      ...(request.memo_ref !== null ? { memo_ref: request.memo_ref } : {}),
      ...(request.policy_score_ref !== null ? { policy_score_ref: request.policy_score_ref } : {}),
      ...(fourEyes !== undefined ? { four_eyes: fourEyes } : {}),
    };
    const token = await signDecisionGrant(claimsWithoutEnvelope);
    const claims = await verifyDecisionGrantSignature(token);

    try {
      await t`SAVEPOINT decision_grant_insert`;
      await t`
        INSERT INTO decision_grants
          (jti, developer_id, request_id, session_id, approver_sub, approver_auth, dwell_ms, case_id, case_version,
           action_hash, approval_position, first_jti, claims, issued_at, expires_at)
        VALUES (${jti}, ${input.developerId}, ${request.id}, ${session.id}, ${sub}, ${session.approver_auth}, ${dwellMs},
                ${request.case_id}, ${request.case_version}, ${request.action_hash}, ${position}, ${first?.jti ?? null},
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
      developerId: input.developerId,
      action: 'decision.approved',
      principalId: sub,
      agentId: request.agent_id,
      grantId: request.grant_id,
      metadata: {
        request_id: request.id,
        jti,
        approver: {
          sub,
          idp: session.issuer,
          connection_id: session.connection_id,
          ...(session.email !== null ? { email: session.email } : {}),
          ...(session.name !== null ? { name: session.name } : {}),
        },
        approver_auth: session.approver_auth,
        acr: session.acr,
        amr: session.amr,
        auth_time: claims.auth_time,
        dwell_ms: dwellMs,
        dwell_source: input.dwell.kind,
        action: request.action,
        action_hash: request.action_hash,
        connector: request.connector,
        case_version: request.case_version,
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
  approvers: { sub: string; approver_auth: string; dwell_ms: number }[];
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
      if (a.approver_sub === b.approver_sub) throw refuse(DecisionSubReason.SAME_APPROVER, 'Both decision grants were approved by the same person');
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
        approvers: rows.map((r) => ({ sub: r.approver_sub, approver_auth: r.approver_auth, dwell_ms: r.dwell_ms, jti: r.jti })),
        consumed_at_epoch: nowSeconds,
      },
    });
    return {
      requestId: request.id,
      jtis,
      approvers: rows.map((r) => ({ sub: r.approver_sub, approver_auth: r.approver_auth, dwell_ms: r.dwell_ms })),
      actionHash: request.action_hash,
    };
  }) as Promise<ConsumeResult>;
}

/** Records a refused consumption (outside the refused transaction). */
export async function auditConsumeRefusal(
  sql: Sql,
  developerId: string,
  subReason: string,
  details: { jtis: string[]; actionHash?: string; agentId?: string; grantId?: string },
): Promise<void> {
  await sql.begin(async (raw) => {
    await appendDecisionAudit(tx(raw), {
      developerId,
      action: 'decision.consume_refused',
      principalId: 'platform',
      status: 'blocked',
      agentId: details.agentId ?? null,
      grantId: details.grantId ?? null,
      metadata: {
        sub_reason: subReason,
        jtis: details.jtis,
        ...(details.actionHash !== undefined ? { action_hash: details.actionHash } : {}),
      },
    });
  });
}

// ── Approval page tickets and views ──────────────────────────────────────

export async function createPageTicket(
  sql: Sql,
  developerId: string,
  requestId: string,
  sessionId: string,
  ttlSeconds: number,
): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(ticket).digest('hex');
  await sql`
    INSERT INTO decision_page_tickets (ticket_hash, developer_id, request_id, session_id, expires_at)
    VALUES (${hash}, ${developerId}, ${requestId}, ${sessionId}, NOW() + make_interval(secs => ${ttlSeconds}))
  `;
  return ticket;
}

export async function redeemPageTicket(
  sql: Sql,
  ticket: string,
): Promise<{ developerId: string; requestId: string; sessionId: string } | null> {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const hash = createHash('sha256').update(ticket).digest('hex');
  const rows = await sql<{ developer_id: string; request_id: string; session_id: string }[]>`
    UPDATE decision_page_tickets SET used_at = NOW()
    WHERE ticket_hash = ${hash} AND used_at IS NULL AND expires_at > NOW()
    RETURNING developer_id, request_id, session_id
  `;
  const row = rows[0];
  return row ? { developerId: row.developer_id, requestId: row.request_id, sessionId: row.session_id } : null;
}

export async function createPageView(sql: Sql, requestId: string, sessionId: string): Promise<string> {
  const id = newPageViewId();
  await sql`INSERT INTO decision_page_views (id, request_id, session_id) VALUES (${id}, ${requestId}, ${sessionId})`;
  return id;
}

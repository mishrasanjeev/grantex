/**
 * Decision-grant API (PRD G-3). Developer API key on every route; approval
 * routes additionally need a step-up approver session in the
 * `Grantex-Approver-Session` header. Disabled unless
 * `DECISION_GRANTS_ENABLED=true`. Specified in spec/decision-grant.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { config } from '../config.js';
import {
  decisionDwellSeconds,
  decisionGrantsConsumedTotal,
  decisionGrantsMintedTotal,
  decisionGrantsRejectedTotal,
} from '../lib/metrics.js';
import { ActionValidationError, parseDecisionAction, type DecisionAction } from '../lib/decisions/action.js';
import { ApproverIdentityError, verifyApproverIdToken } from '../lib/decisions/approver-identity.js';
import {
  DECISION_MAX_LIFETIME_SECONDS,
  DecisionError,
  DecisionSubReason,
  approverClaimsFromIdToken,
  approverSubject,
  isCaseVersion,
  isConnectorName,
  isReference,
} from '../lib/decisions/policy.js';
import { DecisionSettingsError, decisionGrantsEnabled, decisionSettings, type DecisionSettings } from '../lib/decisions/settings.js';
import {
  approveDecisionRequest,
  auditConsumeRefusal,
  cancelDecisionRequest,
  consumeDecisionGrants,
  createApproverSession,
  createDecisionRequest,
  createPageTicket,
  getApproverSession,
  getDecisionRequest,
  revokeApproverSession,
  setCaseVersion,
  type DecisionGrantRow,
  type DecisionRequestRow,
} from '../lib/decisions/store.js';
import {
  DecisionTokenError,
  signApproverSession,
  signDecisionGrant,
  verifyApproverSession,
  verifyDecisionGrantSignature,
} from '../lib/decisions/token.js';

export const APPROVER_SESSION_HEADER = 'grantex-approver-session';

type Stage = 'session' | 'request' | 'approve' | 'consume' | 'case';

function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'APPROVER_SESSION_INVALID';
    case 403: return 'STEP_UP_REQUIRED';
    case 404: return 'NOT_FOUND';
    case 410: return 'DECISION_EXPIRED';
    default: return 'DECISION_INVALID';
  }
}

async function sendDecisionError(reply: FastifyReply, request: FastifyRequest, stage: Stage, err: DecisionError): Promise<FastifyReply> {
  decisionGrantsRejectedTotal.labels(stage, err.subReason).inc();
  return reply.status(err.status).send({
    message: err.message,
    code: codeForStatus(err.status),
    reason: 'decision_invalid',
    subReason: err.subReason,
    requestId: request.id,
  });
}

function badRequest(reply: FastifyReply, request: FastifyRequest, message: string, extra: Record<string, unknown> = {}): FastifyReply {
  return reply.status(400).send({ message, code: 'BAD_REQUEST', ...extra, requestId: request.id });
}

/** Returns the settings, or sends the refusal and returns null. */
async function guard(request: FastifyRequest, reply: FastifyReply): Promise<DecisionSettings | null> {
  if (!decisionGrantsEnabled()) {
    await reply.status(404).send({
      message: 'Decision grants are not enabled on this service',
      code: 'DECISION_GRANTS_DISABLED',
      requestId: request.id,
    });
    return null;
  }
  try {
    return decisionSettings();
  } catch (err) {
    if (err instanceof DecisionSettingsError) {
      request.log.error({ err: err.message }, 'decision grant settings are invalid');
      await reply.status(503).send({
        message: 'Decision grants are misconfigured on this service',
        code: 'DECISION_CONFIG_INVALID',
        requestId: request.id,
      });
      return null;
    }
    throw err;
  }
}

/** Resolves the approver session header to a session of the calling developer. */
async function approverSessionId(request: FastifyRequest): Promise<string> {
  const header = request.headers[APPROVER_SESSION_HEADER];
  if (typeof header !== 'string' || header.length === 0) {
    throw new DecisionError(DecisionSubReason.STEP_UP_REQUIRED, 401, `The ${APPROVER_SESSION_HEADER} header with a step-up approver session is required`);
  }
  let verified;
  try {
    verified = await verifyApproverSession(header);
  } catch (err) {
    if (err instanceof DecisionTokenError) throw new DecisionError(DecisionSubReason.MALFORMED, 401, err.message);
    throw err;
  }
  if (verified.developerId !== request.developer.id) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 401, 'Approver session is invalid or revoked');
  }
  return verified.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DECISION_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function requestResponse(request: DecisionRequestRow, grants: DecisionGrantRow[], tokens?: string[]) {
  return {
    requestId: request.id,
    status: request.status,
    action: request.action,
    actionHash: request.action_hash,
    connector: request.connector,
    caseVersion: request.case_version,
    approvalsRequired: request.approvals_required,
    approvalsReceived: grants.length,
    memoRef: request.memo_ref,
    policyScoreRef: request.policy_score_ref,
    agentId: request.agent_id,
    grantId: request.grant_id,
    expiresAt: request.expires_at.toISOString(),
    createdAt: request.created_at.toISOString(),
    approvals: grants.map((g) => ({
      jti: g.jti,
      sub: g.approver_sub,
      approverAuth: g.approver_auth,
      dwellMs: g.dwell_ms,
      position: g.approval_position,
      issuedAt: g.issued_at.toISOString(),
      expiresAt: g.expires_at.toISOString(),
      consumedAt: g.consumed_at?.toISOString() ?? null,
      revokedAt: g.revoked_at?.toISOString() ?? null,
      revokedReason: g.revoked_reason,
    })),
    ...(tokens !== undefined ? { decisionGrants: tokens } : {}),
  };
}

export async function decisionsRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/decisions/approver-sessions — exchange a step-up ID token for an approver session.
  app.post('/v1/decisions/approver-sessions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const settings = await guard(request, reply);
    if (!settings) return reply;
    const body = request.body;
    if (!isRecord(body) || typeof body['connectionId'] !== 'string' || !ID_RE.test(body['connectionId'])
        || typeof body['idToken'] !== 'string' || body['idToken'].length === 0 || body['idToken'].length > 16_384) {
      return badRequest(reply, request, 'connectionId and idToken are required');
    }
    const sql = getSql();
    const developerId = request.developer.id;
    let verified;
    try {
      verified = await verifyApproverIdToken(sql, developerId, body['connectionId'], body['idToken']);
    } catch (err) {
      if (err instanceof ApproverIdentityError) {
        decisionGrantsRejectedTotal.labels('session', 'authentication_failed').inc();
        return reply.status(401).send({ message: err.message, code: 'APPROVER_AUTH_FAILED', requestId: request.id });
      }
      throw err;
    }
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const claims = approverClaimsFromIdToken(verified.payload, nowSeconds, settings.stepUp);
      const session = await createApproverSession(sql, {
        developerId,
        connectionId: verified.connectionId,
        issuer: verified.issuer,
        claims,
        idToken: body['idToken'],
        stepUp: settings.stepUp,
        nowSeconds,
      });
      const expiresAt = Math.floor(session.expires_at.getTime() / 1000);
      const sessionToken = await signApproverSession(session.id, developerId, expiresAt);
      return reply.status(201).send({
        sessionId: session.id,
        sessionToken,
        expiresAt: session.expires_at.toISOString(),
        approver: {
          sub: approverSubject(session.subject),
          idp: session.issuer,
          email: session.email,
          name: session.name,
        },
        approverAuth: session.approver_auth,
        acr: session.acr,
        amr: session.amr,
        authTime: session.auth_time.toISOString(),
      });
    } catch (err) {
      if (err instanceof DecisionError) return sendDecisionError(reply, request, 'session', err);
      throw err;
    }
  });

  // DELETE /v1/decisions/approver-sessions/:id — end an approver session.
  app.delete<{ Params: { id: string } }>('/v1/decisions/approver-sessions/:id', async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const revoked = await revokeApproverSession(getSql(), request.developer.id, request.params.id);
    if (!revoked) return reply.status(404).send({ message: 'Approver session not found', code: 'NOT_FOUND', requestId: request.id });
    return reply.status(204).send();
  });

  // PUT /v1/decisions/cases/:caseId — register the case's current version.
  app.put<{ Params: { caseId: string } }>('/v1/decisions/cases/:caseId', async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const caseId = request.params.caseId;
    let validCaseId = true;
    try {
      parseDecisionAction({ case_id: caseId, action: 'x', decision: 'x', subject: 'x' });
    } catch {
      validCaseId = false;
    }
    const body = request.body;
    if (!validCaseId || !isRecord(body) || !isCaseVersion(body['caseVersion'])) {
      return badRequest(reply, request, 'A valid caseId and caseVersion (1-128 printable ASCII characters) are required');
    }
    const result = await setCaseVersion(getSql(), request.developer.id, caseId, body['caseVersion']);
    return reply.send(result);
  });

  // POST /v1/decisions/requests — ask for a decision on one semantic action.
  app.post('/v1/decisions/requests', async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    let action: DecisionAction;
    try {
      action = parseDecisionAction(body['action']);
    } catch (err) {
      if (err instanceof ActionValidationError) {
        return reply.status(400).send({ message: err.message, code: 'INVALID_ACTION', field: err.field, validation: err.code, requestId: request.id });
      }
      throw err;
    }
    if (!isConnectorName(body['connector'])) return badRequest(reply, request, 'connector is required');
    if (!isCaseVersion(body['caseVersion'])) return badRequest(reply, request, 'caseVersion (1-128 printable ASCII characters) is required');

    let approvalsRequired: 1 | 2 = 1;
    const fourEyesOn = body['fourEyesOn'];
    if (fourEyesOn !== undefined) {
      if (!Array.isArray(fourEyesOn) || fourEyesOn.length > 64 || !fourEyesOn.every((d) => typeof d === 'string' && DECISION_NAME_RE.test(d))) {
        return badRequest(reply, request, 'fourEyesOn must be an array of decision names');
      }
      if ((fourEyesOn as string[]).includes(action.decision)) approvalsRequired = 2;
    }
    const explicit = body['approvalsRequired'];
    if (explicit !== undefined) {
      if (explicit !== 1 && explicit !== 2) return badRequest(reply, request, 'approvalsRequired must be 1 or 2');
      if (fourEyesOn !== undefined && explicit !== approvalsRequired) {
        return badRequest(reply, request, 'approvalsRequired contradicts fourEyesOn for this decision');
      }
      approvalsRequired = explicit;
    }

    let expiresInSeconds = DECISION_MAX_LIFETIME_SECONDS;
    if (body['expiresInSeconds'] !== undefined) {
      const value = body['expiresInSeconds'];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 60 || value > DECISION_MAX_LIFETIME_SECONDS) {
        return badRequest(reply, request, `expiresInSeconds must be an integer between 60 and ${DECISION_MAX_LIFETIME_SECONDS}`);
      }
      expiresInSeconds = value;
    }
    for (const key of ['memoRef', 'policyScoreRef'] as const) {
      if (body[key] !== undefined && !isReference(body[key])) return badRequest(reply, request, `${key} must be 1-512 printable ASCII characters`);
    }
    for (const key of ['agentId', 'grantId'] as const) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_RE.test(body[key] as string))) {
        return badRequest(reply, request, `${key} is malformed`);
      }
    }

    try {
      const { request: row, created } = await createDecisionRequest(getSql(), {
        developerId: request.developer.id,
        action,
        connector: body['connector'],
        caseVersion: body['caseVersion'],
        approvalsRequired,
        expiresInSeconds,
        ...(typeof body['memoRef'] === 'string' ? { memoRef: body['memoRef'] } : {}),
        ...(typeof body['policyScoreRef'] === 'string' ? { policyScoreRef: body['policyScoreRef'] } : {}),
        ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'] } : {}),
        ...(typeof body['grantId'] === 'string' ? { grantId: body['grantId'] } : {}),
      });
      return reply.status(created ? 201 : 200).send({
        ...requestResponse(row, []),
        created,
        approvalPage: `${config.publicBaseUrl.replace(/\/$/, '')}/decisions/${encodeURIComponent(row.id)}`,
      });
    } catch (err) {
      if (err instanceof DecisionError) return sendDecisionError(reply, request, 'request', err);
      throw err;
    }
  });

  // GET /v1/decisions/requests/:id — status, approvals and, once fully approved, the decision grants.
  app.get<{ Params: { id: string } }>('/v1/decisions/requests/:id', async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const found = await getDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!found) return reply.status(404).send({ message: 'Decision request not found', code: 'NOT_FOUND', requestId: request.id });
    const now = Date.now();
    const usable = found.request.status === 'approved'
      && found.grants.length === found.request.approvals_required
      && found.grants.every((g) => g.consumed_at === null && g.revoked_at === null && g.expires_at.getTime() > now);
    const tokens = usable ? await Promise.all(found.grants.map((g) => signDecisionGrant(g.claims))) : undefined;
    return reply.send(requestResponse(found.request, found.grants, tokens));
  });

  // POST /v1/decisions/requests/:id/approvals — the approver approves the exact action shown.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/approvals', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    const settings = await guard(request, reply);
    if (!settings) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    try {
      const sessionId = await approverSessionId(request);
      const result = await approveDecisionRequest(getSql(), {
        developerId: request.developer.id,
        requestId: request.params.id,
        sessionId,
        actionHash: body['actionHash'],
        dwell: { kind: 'reported', dwellMs: body['dwellMs'] },
        stepUp: settings.stepUp,
        dwellPolicy: settings.dwell,
      });
      decisionGrantsMintedTotal.labels(String(result.request.approvals_required), String(result.approvalsReceived)).inc();
      decisionDwellSeconds.observe(result.claims.dwell_ms / 1000);
      return reply.status(201).send({
        decisionGrant: result.token,
        jti: result.claims.jti,
        sub: result.claims.sub,
        expiresAt: new Date(result.claims.exp * 1000).toISOString(),
        approvalsRequired: result.request.approvals_required,
        approvalsReceived: result.approvalsReceived,
        status: result.request.status,
      });
    } catch (err) {
      if (err instanceof DecisionError) return sendDecisionError(reply, request, 'approve', err);
      throw err;
    }
  });

  // POST /v1/decisions/requests/:id/page-tickets — one-time link to the server-rendered approval page.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/page-tickets', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const settings = await guard(request, reply);
    if (!settings) return reply;
    try {
      const sessionId = await approverSessionId(request);
      const sql = getSql();
      await getApproverSession(sql, request.developer.id, sessionId);
      const found = await getDecisionRequest(sql, request.developer.id, request.params.id);
      if (!found) return reply.status(404).send({ message: 'Decision request not found', code: 'NOT_FOUND', requestId: request.id });
      const ticket = await createPageTicket(sql, request.developer.id, found.request.id, sessionId, settings.pageTicketSeconds);
      return reply.status(201).send({
        url: `${config.publicBaseUrl.replace(/\/$/, '')}/decisions/${encodeURIComponent(found.request.id)}?ticket=${encodeURIComponent(ticket)}`,
        expiresAt: new Date(Date.now() + settings.pageTicketSeconds * 1000).toISOString(),
      });
    } catch (err) {
      if (err instanceof DecisionError) return sendDecisionError(reply, request, 'approve', err);
      throw err;
    }
  });

  // POST /v1/decisions/requests/:id/cancel — withdraw a request and revoke its unconsumed grants.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/cancel', async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const row = await cancelDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!row) return reply.status(404).send({ message: 'No open decision request with this id', code: 'NOT_FOUND', requestId: request.id });
    return reply.send({ requestId: row.id, status: row.status });
  });

  // POST /v1/decisions/consume — verify and atomically consume the decision grants for one action.
  app.post('/v1/decisions/consume', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    for (const key of ['agentId', 'grantId'] as const) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_RE.test(body[key] as string))) {
        return badRequest(reply, request, `${key} is malformed`);
      }
    }
    const sql = getSql();
    const developerId = request.developer.id;
    try {
      const result = await consumeDecisionGrants(sql, {
        developerId,
        tokens: body['decisionGrants'],
        action: body['action'],
        caseVersion: body['caseVersion'],
        ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'] } : {}),
        ...(typeof body['grantId'] === 'string' ? { grantId: body['grantId'] } : {}),
      });
      decisionGrantsConsumedTotal.inc(result.jtis.length);
      return reply.send({ consumed: true, ...result });
    } catch (err) {
      if (!(err instanceof DecisionError)) throw err;
      // Record refusals of grants this developer holds (signature verified,
      // developer matched), so replay attempts are visible in the audit chain.
      if (err.subReason !== DecisionSubReason.MALFORMED && err.subReason !== DecisionSubReason.UNKNOWN_GRANT) {
        const jtis: string[] = [];
        for (const token of Array.isArray(body['decisionGrants']) ? body['decisionGrants'] : []) {
          try {
            const claims = await verifyDecisionGrantSignature(token as string);
            if (claims.dev === developerId) jtis.push(claims.jti);
          } catch {
            // Unverifiable tokens are not recorded.
          }
        }
        if (jtis.length > 0) {
          try {
            await auditConsumeRefusal(sql, developerId, err.subReason, {
              jtis,
              ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'] } : {}),
              ...(typeof body['grantId'] === 'string' ? { grantId: body['grantId'] } : {}),
            });
          } catch (auditErr) {
            request.log.error({ err: auditErr }, 'failed to audit a refused decision-grant consumption');
          }
        }
      }
      return sendDecisionError(reply, request, 'consume', err);
    }
  });
}

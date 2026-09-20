/**
 * Decision-grant API for platforms (PRD G-3), authenticated with the developer
 * API key. A platform can register case versions, create and cancel decision
 * requests, read their results and consume decision grants. It cannot sign
 * approvers in, approve, or configure the identity providers approvers use:
 * approval happens only in the approver's browser on the service's approval
 * page (routes/decision-page.ts), and identity providers are configured by the
 * service administrator (routes/decision-admin.ts). Disabled unless
 * `DECISION_GRANTS_ENABLED=true`. Specified in spec/decision-grant.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { config } from '../config.js';
import { decisionGrantsConsumedTotal, decisionGrantsRejectedTotal } from '../lib/metrics.js';
import { ActionValidationError, parseDecisionAction, type DecisionAction } from '../lib/decisions/action.js';
import { DuplicateKeyError, parseJsonRejectingDuplicates } from '../lib/decisions/canonical.js';
import {
  DECISION_MAX_LIFETIME_SECONDS,
  DecisionError,
  isCaseVersion,
  isConnectorName,
  isReference,
} from '../lib/decisions/policy.js';
import { DecisionSettingsError, decisionGrantsEnabled, decisionSettings, type DecisionSettings } from '../lib/decisions/settings.js';
import {
  auditConsumeRefusal,
  cancelDecisionRequest,
  consumeDecisionGrants,
  createDecisionRequest,
  getDecisionRequest,
  reviewContent,
  setCaseVersion,
  type DecisionGrantRow,
  type DecisionRequestRow,
} from '../lib/decisions/store.js';
import { signDecisionGrant, verifyDecisionGrantSignature } from '../lib/decisions/token.js';

type Stage = 'request' | 'consume' | 'case';

function codeForStatus(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
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
export async function decisionGuard(request: FastifyRequest, reply: FastifyReply): Promise<DecisionSettings | null> {
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
    memoHash: request.memo_hash,
    policyScoreRef: request.policy_score_ref,
    policyScoreHash: request.policy_score_hash,
    agentId: request.agent_id,
    grantId: request.grant_id,
    expiresAt: request.expires_at.toISOString(),
    createdAt: request.created_at.toISOString(),
    approvals: grants.map((g) => ({
      jti: g.jti,
      sub: g.approver_sub,
      approverAuth: g.approver_auth,
      dwellMs: g.dwell_ms,
      dwellSource: g.dwell_source,
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
  // Decision request bodies are parsed with duplicate member names refused,
  // so the action hashed is the action the platform sent.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      done(null, text.length === 0 ? undefined : parseJsonRejectingDuplicates(text));
    } catch (err) {
      const error = new Error(err instanceof DuplicateKeyError ? `Request body repeats the member name ${JSON.stringify(err.key)}` : 'Request body is not valid JSON') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // PUT /v1/decisions/cases/:caseId — register the case's current version.
  app.put<{ Params: { caseId: string } }>('/v1/decisions/cases/:caseId', async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
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
    if (!(await decisionGuard(request, reply))) return reply;
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
    const memo = body['memo'];
    const policyScore = body['policyScore'];
    if (!isRecord(memo) || !isRecord(policyScore)) {
      return badRequest(reply, request, 'memo {content, ref?, hash?} and policyScore {content, ref?, hash?} are required: the approver reviews them');
    }
    for (const [name, value] of [['memo.ref', memo['ref']], ['policyScore.ref', policyScore['ref']]] as const) {
      if (value !== undefined && !isReference(value)) return badRequest(reply, request, `${name} must be 1-512 printable ASCII characters`);
    }
    for (const key of ['agentId', 'grantId'] as const) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_RE.test(body[key] as string))) {
        return badRequest(reply, request, `${key} is malformed`);
      }
    }

    try {
      const review = reviewContent(memo['content'], memo['hash'], policyScore['content'], policyScore['hash']);
      const { request: row, created } = await createDecisionRequest(getSql(), {
        developerId: request.developer.id,
        action,
        connector: body['connector'],
        caseVersion: body['caseVersion'],
        approvalsRequired,
        expiresInSeconds,
        review,
        ...(typeof memo['ref'] === 'string' ? { memoRef: memo['ref'] } : {}),
        ...(typeof policyScore['ref'] === 'string' ? { policyScoreRef: policyScore['ref'] } : {}),
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
    if (!(await decisionGuard(request, reply))) return reply;
    const found = await getDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!found) return reply.status(404).send({ message: 'Decision request not found', code: 'NOT_FOUND', requestId: request.id });
    const now = Date.now();
    const usable = found.request.status === 'approved'
      && found.grants.length === found.request.approvals_required
      && found.grants.every((g) => g.consumed_at === null && g.revoked_at === null && g.expires_at.getTime() > now);
    const tokens = usable ? await Promise.all(found.grants.map((g) => signDecisionGrant(g.claims))) : undefined;
    return reply.send(requestResponse(found.request, found.grants, tokens));
  });

  // POST /v1/decisions/requests/:id/cancel — withdraw a request and revoke its unconsumed grants.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/cancel', async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
    const row = await cancelDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!row) return reply.status(404).send({ message: 'No open decision request with this id', code: 'NOT_FOUND', requestId: request.id });
    return reply.send({ requestId: row.id, status: row.status });
  });

  // POST /v1/decisions/consume — verify and atomically consume the decision grants for one action.
  app.post('/v1/decisions/consume', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    for (const key of ['agentId', 'grantId'] as const) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_RE.test(body[key] as string))) {
        return badRequest(reply, request, `${key} is malformed`);
      }
    }
    const sql = getSql();
    const developerId = request.developer.id;
    const context = {
      ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'] } : {}),
      ...(typeof body['grantId'] === 'string' ? { grantId: body['grantId'] } : {}),
    };
    try {
      const result = await consumeDecisionGrants(sql, {
        developerId,
        tokens: body['decisionGrants'],
        action: body['action'],
        caseVersion: body['caseVersion'],
        ...context,
      });
      decisionGrantsConsumedTotal.inc(result.jtis.length);
      return reply.send({ consumed: true, ...result });
    } catch (err) {
      if (!(err instanceof DecisionError)) throw err;
      // Every refusal is recorded with what was attempted. If the record
      // cannot be written the request fails; it is refused either way.
      const jtis: string[] = [];
      for (const token of Array.isArray(body['decisionGrants']) ? body['decisionGrants'].slice(0, 2) : []) {
        try {
          const claims = await verifyDecisionGrantSignature(token as string);
          if (claims.dev === developerId) jtis.push(claims.jti);
        } catch {
          // Unverifiable tokens contribute no jti.
        }
      }
      try {
        await auditConsumeRefusal(sql, developerId, err.subReason, { jtis, action: body['action'], caseVersion: body['caseVersion'], ...context });
      } catch (auditErr) {
        request.log.error({ err: auditErr }, 'failed to audit a refused decision-grant consumption');
        decisionGrantsRejectedTotal.labels('consume', 'audit_unavailable').inc();
        return reply.status(503).send({
          message: 'The refusal could not be recorded; the decision grant was not consumed',
          code: 'DECISION_AUDIT_UNAVAILABLE',
          reason: 'decision_invalid',
          subReason: err.subReason,
          requestId: request.id,
        });
      }
      return sendDecisionError(reply, request, 'consume', err);
    }
  });
}

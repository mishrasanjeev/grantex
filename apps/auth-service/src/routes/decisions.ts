/**
 * Decision-grant API for platforms (PRD G-3), authenticated with the developer
 * API key. A platform can register case versions, create and cancel decision
 * requests, read their results and consume decision grants. It cannot sign
 * approvers in, approve, or configure the identity providers approvers use:
 * approval happens only in the approver's browser on the service's approval
 * page (routes/decision-page.ts), and identity providers are configured by the
 * service administrator (routes/decision-admin.ts). Disabled unless
 * `DECISION_GRANTS_ENABLED=true`. Specified in spec/decision-grant.md.
 *
 * With `DECISION_GRANT_AGENT_BINDING=true` the developer API key never
 * receives a decision grant token: a request that names an agent (`agentId`,
 * `grantId`) releases its grants only to a live grant token of that agent and
 * grant, and they are consumed only when that agent's live grant token
 * accompanies them (`grantToken`). The agent is always established from its
 * grant token, never from a body field. Off (the default), request
 * creation, `GET /v1/decisions/requests/:id` and `POST /v1/decisions/consume`
 * answer as they did before the binding existed. In both states a request that
 * names no agent can be consumed by its id, so its grants need not leave the
 * service, and the grants of a request that names an agent can be fetched with
 * that agent's grant token: both are new endpoints, so a platform can move to
 * them before the binding is turned on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { config } from '../config.js';
import { decisionGrantsConsumedTotal, decisionGrantsRejectedTotal } from '../lib/metrics.js';
import { ActionValidationError, parseDecisionAction, type DecisionAction } from '../lib/decisions/action.js';
import { DuplicateKeyError, parseJsonRejectingDuplicates } from '../lib/decisions/canonical.js';
import {
  NO_GRANT_TOKEN,
  callingAgentOf,
  isGrantTokenMember,
  notLiveGrantToken,
  type CallingAgent,
} from '../lib/decisions/calling-agent.js';
import {
  DECISION_MAX_LIFETIME_SECONDS,
  DecisionError,
  DecisionSubReason,
  isAgentDid,
  isCaseVersion,
  isConnectorName,
  isReference,
} from '../lib/decisions/policy.js';
import { DecisionSettingsError, decisionGrantsEnabled, decisionSettings, type DecisionSettings } from '../lib/decisions/settings.js';
import {
  assertRequester,
  auditConsumeRefusal,
  auditGrantRelease,
  cancelDecisionRequest,
  consumePlatformDecisionRequest,
  consumePresentedDecisionGrants,
  createDecisionRequest,
  getDecisionRequest,
  reviewContent,
  setCaseVersion,
  type ConsumeAttempt,
  type ConsumePlatformRequestInput,
  type ConsumePresentedInput,
  type ConsumeResult,
  type DecisionGrantRow,
  type DecisionRequester,
  type DecisionRequestRow,
  type GrantRelease,
  type Sql,
} from '../lib/decisions/store.js';
import { signDecisionGrant, verifyDecisionGrantSignature } from '../lib/decisions/token.js';

type Stage = 'request' | 'release' | 'consume' | 'case';

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

/**
 * The `agentId` and `grantId` members of a body (Grantex agent id and grant
 * id), or the name of the malformed one. With `withDid`, also `agentDid`, the
 * agent's DID as an enforcer reads it from the calling agent's grant token.
 * Without it `agentDid` is ignored, as it was before the binding existed, so
 * an SDK that sends it works against a service that does not bind.
 */
function requesterFields(body: Record<string, unknown>, withDid: boolean): DecisionRequester | string {
  for (const key of ['agentId', 'grantId'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !ID_RE.test(body[key] as string))) return key;
  }
  const agentDid = withDid ? body['agentDid'] : undefined;
  if (agentDid !== undefined && !isAgentDid(agentDid)) return 'agentDid';
  return {
    ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'] } : {}),
    ...(typeof agentDid === 'string' ? { agentDid } : {}),
    ...(typeof body['grantId'] === 'string' ? { grantId: body['grantId'] } : {}),
  };
}

/** Fully approved, and every grant still unconsumed, unrevoked and unexpired. */
function grantsReady(request: DecisionRequestRow, grants: DecisionGrantRow[]): boolean {
  const now = Date.now();
  return request.status === 'approved'
    && grants.length === request.approvals_required
    && grants.every((g) => g.consumed_at === null && g.revoked_at === null && g.expires_at.getTime() > now);
}

/**
 * A request as the API answers it. `decisionGrantsReady` is added where the
 * binding applies (and on the release endpoint), `decisionGrants` only where
 * the tokens are handed out.
 */
function requestResponse(
  request: DecisionRequestRow,
  grants: DecisionGrantRow[],
  extra: { decisionGrantsReady?: boolean; decisionGrants?: string[] } = {},
) {
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
    ...(extra.decisionGrantsReady !== undefined ? { decisionGrantsReady: extra.decisionGrantsReady } : {}),
    ...(extra.decisionGrants !== undefined ? { decisionGrants: extra.decisionGrants } : {}),
  };
}

/**
 * What a refused consumption records about the agent with the binding on: the
 * agent and grant its grant token established or, when none was, why
 * (`token_check`), and apart from them what the body claimed.
 */
function attemptedAgent(agent: CallingAgent, claimed: DecisionRequester): Pick<ConsumeAttempt, 'agentDid' | 'grantId' | 'tokenCheck' | 'claimed'> {
  return {
    ...(agent.verified ? { agentDid: agent.agentDid, grantId: agent.grantId } : { tokenCheck: agent.tokenCheck }),
    ...(Object.keys(claimed).length > 0 ? { claimed } : {}),
  };
}

/**
 * The jtis of the presented decision grants whose signature verifies and that
 * belong to this developer, for the record of a refused consumption.
 */
async function verifiedJtis(tokens: unknown, developerId: string): Promise<string[]> {
  const jtis: string[] = [];
  for (const token of Array.isArray(tokens) ? tokens.slice(0, 2) : []) {
    try {
      const claims = await verifyDecisionGrantSignature(token as string);
      if (claims.dev === developerId) jtis.push(claims.jti);
    } catch {
      // Unverifiable tokens contribute no jti.
    }
  }
  return jtis;
}

/**
 * Consumes and answers. Each consume endpoint passes the one consumption it
 * performs (`consume`) and what a refusal of it records (`attempted`, built
 * only on refusal). Every refusal is recorded; if the record cannot be written
 * the request fails with 503 and nothing is consumed (it is refused either
 * way).
 */
async function consumeAndReply(
  request: FastifyRequest,
  reply: FastifyReply,
  developerId: string,
  consume: (sql: Sql) => Promise<ConsumeResult>,
  attempted: () => Promise<ConsumeAttempt>,
): Promise<FastifyReply> {
  const sql = getSql();
  try {
    const result = await consume(sql);
    decisionGrantsConsumedTotal.inc(result.jtis.length);
    return reply.send({ consumed: true, ...result });
  } catch (err) {
    if (!(err instanceof DecisionError)) throw err;
    const attempt = await attempted();
    try {
      await auditConsumeRefusal(sql, developerId, err.subReason, attempt);
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
    const settings = await decisionGuard(request, reply);
    if (!settings) return reply;
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
    // A request names its agent by Grantex agent id; `agentDid` has no meaning here.
    const requester = requesterFields(body, false);
    if (typeof requester === 'string') return badRequest(reply, request, `${requester} is malformed`);

    try {
      const review = reviewContent(memo['content'], memo['hash'], policyScore['content'], policyScore['hash']);
      const sql = getSql();
      const { request: row, created } = await createDecisionRequest(sql, {
        developerId: request.developer.id,
        action,
        connector: body['connector'],
        caseVersion: body['caseVersion'],
        approvalsRequired,
        expiresInSeconds,
        review,
        ...(typeof memo['ref'] === 'string' ? { memoRef: memo['ref'] } : {}),
        ...(typeof policyScore['ref'] === 'string' ? { policyScoreRef: policyScore['ref'] } : {}),
        ...(requester.agentId !== undefined ? { agentId: requester.agentId } : {}),
        ...(requester.grantId !== undefined ? { grantId: requester.grantId } : {}),
        bindAgent: settings.agentBinding,
      });
      const approvalPage = `${config.publicBaseUrl.replace(/\/$/, '')}/decisions/${encodeURIComponent(row.id)}`;
      if (!settings.agentBinding) {
        return reply.status(created ? 201 : 200).send({ ...requestResponse(row, []), created, approvalPage });
      }
      // A repeated request answers the open request as it stands, approvals
      // included, so `decisionGrantsReady` is true once they are.
      const current = created ? null : await getDecisionRequest(sql, request.developer.id, row.id);
      const answered = current ?? { request: row, grants: [] };
      return reply.status(created ? 201 : 200).send({
        ...requestResponse(answered.request, answered.grants, { decisionGrantsReady: grantsReady(answered.request, answered.grants) }),
        created,
        approvalPage,
      });
    } catch (err) {
      if (err instanceof DecisionError) return sendDecisionError(reply, request, 'request', err);
      throw err;
    }
  });

  // GET /v1/decisions/requests/:id — status and approvals (by jti). With the
  // binding, whether the decision grants are ready but never the grants
  // themselves: they are bearer credentials, and the developer API key alone
  // is not the requesting agent. Without it, the grants once fully approved
  // and still usable, as before the binding existed.
  app.get<{ Params: { id: string } }>('/v1/decisions/requests/:id', async (request, reply) => {
    const settings = await decisionGuard(request, reply);
    if (!settings) return reply;
    const found = await getDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!found) return reply.status(404).send({ message: 'Decision request not found', code: 'NOT_FOUND', requestId: request.id });
    const ready = grantsReady(found.request, found.grants);
    if (settings.agentBinding) {
      return reply.send(requestResponse(found.request, found.grants, { decisionGrantsReady: ready }));
    }
    const tokens = ready ? await Promise.all(found.grants.map((g) => signDecisionGrant(g.claims))) : undefined;
    return reply.send(requestResponse(found.request, found.grants, tokens !== undefined ? { decisionGrants: tokens } : {}));
  });

  // POST /v1/decisions/requests/:id/grants — the decision grants, released to
  // the agent the request names on presentation of that agent's grant token.
  // Every hand-out and every refusal is recorded in the audit chain.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/grants', async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
    const body = request.body;
    const grantToken = isRecord(body) ? body['grantToken'] : undefined;
    if (!isGrantTokenMember(grantToken)) {
      return badRequest(reply, request, "grantToken, the requesting agent's grant token, is required");
    }
    const sql = getSql();
    const developerId = request.developer.id;
    const found = await getDecisionRequest(sql, developerId, request.params.id);
    if (!found) return reply.status(404).send({ message: 'Decision request not found', code: 'NOT_FOUND', requestId: request.id });

    // The agent is established from a live grant token of this developer,
    // never from a body field: its signature, expiry, revocation and grant
    // status are checked. A token that fails any of them releases nothing.
    // Consumption with the binding establishes the agent the same way.
    const agent = await callingAgentOf(grantToken, developerId);
    const requester = agent.verified ? { agentDid: agent.agentDid, grantId: agent.grantId } : {};
    let refusal: DecisionError | null = null;
    let tokenCheck: string | undefined;
    if (!agent.verified) {
      tokenCheck = agent.tokenCheck;
      refusal = notLiveGrantToken(agent.tokenCheck);
    } else if (found.request.agent_id === null && found.request.grant_id === null) {
      // A request that names no agent has no requesting agent to release to;
      // the platform that asked consumes it by request id instead.
      refusal = new DecisionError(
        DecisionSubReason.WRONG_AGENT,
        403,
        'This decision request names no agent, so its decision grants are not released; consume it by request id',
      );
    } else {
      try {
        await assertRequester(sql, found.request, requester);
      } catch (err) {
        if (!(err instanceof DecisionError)) throw err;
        refusal = err;
      }
    }

    const ready = grantsReady(found.request, found.grants);
    let tokens: string[] | undefined;
    let outcome: GrantRelease | null = null;
    if (refusal !== null) {
      outcome = { released: false, subReason: refusal.subReason, ...(tokenCheck !== undefined ? { tokenCheck } : {}) };
    } else if (ready) {
      tokens = await Promise.all(found.grants.map((g) => signDecisionGrant(g.claims)));
      outcome = { released: true, jtis: found.grants.map((g) => g.jti), actionHash: found.request.action_hash };
    }
    if (outcome !== null) {
      try {
        await auditGrantRelease(sql, developerId, found.request, requester, outcome);
      } catch (auditErr) {
        request.log.error({ err: auditErr }, 'failed to audit a decision-grant release');
        decisionGrantsRejectedTotal.labels('release', 'audit_unavailable').inc();
        return reply.status(503).send({
          message: 'The release could not be recorded; no decision grant was released',
          code: 'DECISION_AUDIT_UNAVAILABLE',
          reason: 'decision_invalid',
          ...(refusal !== null ? { subReason: refusal.subReason } : {}),
          requestId: request.id,
        });
      }
    }
    if (refusal !== null) return sendDecisionError(reply, request, 'release', refusal);
    return reply.send(requestResponse(found.request, found.grants, {
      decisionGrantsReady: ready,
      ...(tokens !== undefined ? { decisionGrants: tokens } : {}),
    }));
  });

  // POST /v1/decisions/requests/:id/cancel — withdraw a request and revoke its unconsumed grants.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/cancel', async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
    const row = await cancelDecisionRequest(getSql(), request.developer.id, request.params.id);
    if (!row) return reply.status(404).send({ message: 'No open decision request with this id', code: 'NOT_FOUND', requestId: request.id });
    return reply.send({ requestId: row.id, status: row.status });
  });

  // POST /v1/decisions/requests/:id/consume — consume the grants of a request
  // that names no agent, for one action, without the platform ever holding
  // them. A request that names an agent or a grant is refused (`wrong_agent`):
  // only the grants its agent presents spend it. Only this endpoint consumes
  // by request id.
  app.post<{ Params: { id: string } }>('/v1/decisions/requests/:id/consume', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!(await decisionGuard(request, reply))) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    const input: ConsumePlatformRequestInput = {
      developerId: request.developer.id,
      requestId: request.params.id,
      action: body['action'],
      caseVersion: body['caseVersion'],
    };
    return consumeAndReply(
      request,
      reply,
      input.developerId,
      (sql) => consumePlatformDecisionRequest(sql, input),
      async () => ({ jtis: [], action: input.action, caseVersion: input.caseVersion, requestId: input.requestId }),
    );
  });

  // POST /v1/decisions/consume — verify and atomically consume the decision
  // grants presented for one action. With the binding, the grants of a request
  // that names an agent or a grant are consumed only when the grant token of
  // that agent and grant accompanies them (`grantToken`). This endpoint only
  // ever consumes presented grants: the body has no request id member, and one
  // without `decisionGrants` is refused (malformed, 400).
  app.post('/v1/decisions/consume', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const settings = await decisionGuard(request, reply);
    if (!settings) return reply;
    const body = request.body;
    if (!isRecord(body)) return badRequest(reply, request, 'Request body must be a JSON object');
    const claimed = requesterFields(body, settings.agentBinding);
    if (typeof claimed === 'string') return badRequest(reply, request, `${claimed} is malformed`);
    const developerId = request.developer.id;

    // With the binding (a service setting, never a value the caller sends),
    // the agent the grants are consumed for is established by this service
    // from the agent's grant token, exactly as the release of the grants
    // establishes it: `agentId`, `agentDid` and `grantId` in the body are then
    // only claims, compared with that agent and never taking its place. A
    // missing token establishes no agent. That never admits more than a live
    // token would: only a request that names no agent can then be consumed,
    // as the binding already allowed (see `bindingRequester`), and the
    // decision grants' own signatures are verified in every case.
    //
    // Off, `grantToken` is not read at all, not even for its shape, so this
    // endpoint answers exactly as it did before the binding existed, and an
    // SDK that sends the token works against it.
    let callingAgent: CallingAgent | undefined;
    if (settings.agentBinding) {
      const grantToken = body['grantToken'];
      if (grantToken !== undefined && !isGrantTokenMember(grantToken)) return badRequest(reply, request, 'grantToken is malformed');
      callingAgent = grantToken === undefined ? NO_GRANT_TOKEN : await callingAgentOf(grantToken, developerId);
    }
    const input: ConsumePresentedInput = {
      developerId,
      tokens: body['decisionGrants'],
      action: body['action'],
      caseVersion: body['caseVersion'],
      ...claimed,
      bindAgent: settings.agentBinding,
      ...(callingAgent !== undefined ? { callingAgent } : {}),
    };
    return consumeAndReply(
      request,
      reply,
      developerId,
      (sql) => consumePresentedDecisionGrants(sql, input),
      async () => ({
        jtis: await verifiedJtis(input.tokens, developerId),
        action: input.action,
        caseVersion: input.caseVersion,
        ...(callingAgent !== undefined ? attemptedAgent(callingAgent, claimed) : claimed),
      }),
    );
  });
}

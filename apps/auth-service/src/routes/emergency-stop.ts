/**
 * The emergency stop (PRD G-6): the documented way to halt every agent under
 * a grant, an agent, a principal or a whole developer.
 *
 *   POST /v1/emergency-stop                   the developer's own tenant (developer API key)
 *   POST /v1/emergency-stop/unfreeze          lift a lockout the developer placed
 *   GET  /v1/emergency-stops                  what has been stopped, and the lockouts in force
 *   POST /v1/admin/emergency-stop             any tenant (ADMIN_API_KEY), for the operator
 *   POST /v1/admin/emergency-stop/unfreeze    lift any lockout, for the operator
 *
 * Off unless EMERGENCY_STOP_ENABLED=true. Every call must repeat a
 * confirmation phrase naming exactly what it will stop or unfreeze, and
 * `dryRun` reports the blast radius without revoking anything. `lockout: true`
 * also freezes issuance under the scope until the freeze is lifted; a lockout
 * the operator placed can only be lifted by the operator.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { isPlainObject } from '../lib/event-bridge/normalize.js';
import { emergencyStopsTotal } from '../lib/revocation/metrics.js';
import {
  STOP_SCOPES,
  confirmationPhrase,
  emergencyStop,
  listEmergencyStops,
  toEmergencyStopResponse,
  type EmergencyStopResult,
  type StopScope,
  type StopScopeType,
} from '../lib/revocation/emergency-stop.js';
import {
  FreezeHeldByOperatorError,
  FreezeNotFoundError,
  MAX_FREEZE_PAGE_SIZE,
  DEFAULT_FREEZE_PAGE_SIZE,
  liftIssuanceFreeze,
  listActiveFreezes,
  toFreezeResponse,
  unfreezeConfirmationPhrase,
  type FreezeAuthority,
} from '../lib/revocation/issuance-freeze.js';

const MAX_REASON = 500;

/** A whole number >= 1, the fallback when absent, or null for anything else. */
function parsePageNumber(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function emergencyStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['EMERGENCY_STOP_ENABLED'] === 'true';
}

interface StopBody {
  scope?: unknown;
  reason?: unknown;
  confirm?: unknown;
  dryRun?: unknown;
  lockout?: unknown;
  developerId?: unknown;
}

class StopRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'StopRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ParsedStop {
  scope: StopScope;
  reason: string;
  dryRun: boolean;
  lockout: boolean;
}

function parseScopeAndReason(body: StopBody): { scope: StopScope; reason: string } {
  const { scope, reason } = body;
  if (!isPlainObject(scope) || typeof scope['type'] !== 'string'
      || !(STOP_SCOPES as readonly string[]).includes(scope['type'])
      || typeof scope['id'] !== 'string' || scope['id'].length === 0 || scope['id'].length > 256) {
    throw new StopRequestError(400, 'BAD_REQUEST',
      `scope must be {type: ${STOP_SCOPES.join('|')}, id} with an id of 1 to 256 characters`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON) {
    throw new StopRequestError(400, 'BAD_REQUEST', `reason is required (at most ${MAX_REASON} characters)`);
  }
  return { scope: { type: scope['type'] as StopScopeType, id: scope['id'] }, reason };
}

/** Validate the request, including the confirmation phrase. Nothing is revoked before this passes. */
export function parseStopRequest(body: unknown): ParsedStop {
  if (!isPlainObject(body)) throw new StopRequestError(400, 'BAD_REQUEST', 'body must be a JSON object');
  const { confirm, dryRun, lockout } = body as StopBody;
  const { scope: parsed, reason } = parseScopeAndReason(body as StopBody);
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new StopRequestError(400, 'BAD_REQUEST', 'dryRun must be a boolean');
  }
  // Strictly a boolean: a caller who believes they asked for a lockout and
  // did not get one is worse off than one who was refused.
  if (lockout !== undefined && typeof lockout !== 'boolean') {
    throw new StopRequestError(400, 'BAD_REQUEST', 'lockout must be a boolean');
  }
  const phrase = confirmationPhrase(parsed);
  if (typeof confirm !== 'string' || confirm !== phrase) {
    // The expected phrase is deliberately not echoed. Handing it back turns
    // the endpoint into a phrase generator: a caller who has the scope wrong,
    // or who was told what to paste by someone else, can copy the answer and
    // repeat the call, which is the one thing the confirmation exists to
    // prevent. The format is documented, and the caller already knows what it
    // meant to stop.
    throw new StopRequestError(412, 'CONFIRMATION_REQUIRED',
      'confirm must be exactly "stop <scope type>:<scope id>" for the scope in this request');
  }
  return { scope: parsed, reason, dryRun: dryRun === true, lockout: lockout === true };
}

interface ParsedUnfreeze {
  scope: StopScope;
  reason: string;
}

/**
 * Validate an unfreeze, including its own confirmation phrase,
 * `unfreeze <type>:<id>`. It differs from the stop's on purpose: pasting the
 * phrase of the stop that placed a lockout must not lift it.
 */
export function parseUnfreezeRequest(body: unknown): ParsedUnfreeze {
  if (!isPlainObject(body)) throw new StopRequestError(400, 'BAD_REQUEST', 'body must be a JSON object');
  const { scope, reason } = parseScopeAndReason(body as StopBody);
  const { confirm } = body as StopBody;
  if (typeof confirm !== 'string' || confirm !== unfreezeConfirmationPhrase(scope)) {
    // Not echoed, for the same reason as the stop's phrase.
    throw new StopRequestError(412, 'CONFIRMATION_REQUIRED',
      'confirm must be exactly "unfreeze <scope type>:<scope id>" for the scope in this request');
  }
  return { scope, reason };
}

function sendError(request: FastifyRequest, reply: FastifyReply, err: StopRequestError): FastifyReply {
  return reply.status(err.status).send({
    message: err.message,
    code: err.code,
    ...err.details,
    requestId: request.id,
  });
}

function logStop(request: FastifyRequest, result: EmergencyStopResult): void {
  request.log.warn({
    alert: 'emergency_stop',
    stopId: result.stopId,
    developerId: result.developerId,
    scopeType: result.scope.type,
    dryRun: result.dryRun,
    status: result.status,
    sweeps: result.sweeps,
    grantsMatched: result.grantsMatched,
    grantsRevoked: result.grantsRevoked,
    agentsStopped: result.agentsStoppedTotal,
    agentsStoppedTruncated: result.agentsStoppedTruncated,
    lockout: result.lockout,
    ...(result.freezeId !== undefined ? { freezeId: result.freezeId } : {}),
  }, result.dryRun ? 'emergency stop rehearsed' : 'emergency stop applied');
}

/** Check the platform admin key. Sends the refusal and returns false when it is wrong. */
function adminAuthorized(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminKey = config.adminApiKey;
  if (!adminKey) {
    void reply.status(503).send({
      message: 'Admin API not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id,
    });
    return false;
  }
  const expected = Buffer.from(`Bearer ${adminKey}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    void reply.status(401).send({ message: 'Unauthorized', code: 'UNAUTHORIZED', requestId: request.id });
    return false;
  }
  return true;
}

/**
 * The tenant an operator call is about: the scope names it for a `developer`
 * scope, and `developerId` does for anything narrower.
 */
function operatorDeveloperId(scope: StopScope, requested: unknown, action: 'stopped' | 'unfrozen'): string {
  if (scope.type === 'developer') {
    if (requested !== undefined && requested !== scope.id) {
      throw new StopRequestError(400, 'BAD_REQUEST', `developerId must match the developer being ${action}`);
    }
    return scope.id;
  }
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 256) {
    throw new StopRequestError(400, 'BAD_REQUEST', 'developerId is required for a grant, agent or principal scope');
  }
  return requested;
}

/** Lift a freeze, turning the refusals `liftIssuanceFreeze` can raise into responses. */
async function unfreeze(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { developerId: string; parsed: ParsedUnfreeze; requestedBy: string; liftedBy: FreezeAuthority },
): Promise<FastifyReply> {
  try {
    const row = await liftIssuanceFreeze(getSql(), {
      developerId: input.developerId,
      scope: input.parsed.scope,
      reason: input.parsed.reason,
      requestedBy: input.requestedBy,
      liftedBy: input.liftedBy,
      log: request.log,
    });
    return reply.send(toFreezeResponse(row));
  } catch (err) {
    if (err instanceof FreezeNotFoundError || err instanceof FreezeHeldByOperatorError) {
      return reply.status(err.statusCode).send({ message: err.message, code: err.code, requestId: request.id });
    }
    throw err;
  }
}

export async function emergencyStopRoutes(app: FastifyInstance): Promise<void> {
  // The developer stop is containment: besides its per-address limit it is
  // counted apart from the plan, and a limiter outage does not refuse it
  // (plugins/dynamicRateLimit.ts). The operator route below skips standard
  // auth, so no per-developer bucket applies to it.
  const containment = {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' }, rateLimitClass: 'containment' as const },
  };
  // Lifting a lockout restores issuance, so it is not containment: it keeps
  // the per-address limit and draws on the plan like any other call.
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/v1/emergency-stop', containment, async (request, reply) => {
    if (!emergencyStopEnabled()) {
      return reply.status(403).send({
        message: 'The emergency stop is not enabled', code: 'FEATURE_DISABLED', requestId: request.id,
      });
    }
    let parsed: ParsedStop;
    try {
      parsed = parseStopRequest(request.body);
      if ((request.body as StopBody).developerId !== undefined
          && (request.body as StopBody).developerId !== request.developer.id) {
        throw new StopRequestError(403, 'FORBIDDEN', 'this key can only stop its own grants');
      }
      if (parsed.scope.type === 'developer' && parsed.scope.id !== request.developer.id) {
        throw new StopRequestError(403, 'FORBIDDEN', 'this key can only stop its own grants');
      }
    } catch (err) {
      if (err instanceof StopRequestError) {
        emergencyStopsTotal.inc({ scope: 'unknown', outcome: 'refused' });
        return sendError(request, reply, err);
      }
      throw err;
    }

    const result = await emergencyStop(getSql(), {
      developerId: request.developer.id,
      scope: parsed.scope,
      reason: parsed.reason,
      // The tenant and the address it came from, so a stop can be traced to a
      // caller rather than just to the tenant that owns the key. The key
      // itself is never recorded, hashed or otherwise.
      requestedBy: `developer:${request.developer.id}@${request.ip}`,
      dryRun: parsed.dryRun,
      lockout: parsed.lockout,
      authority: 'developer',
      log: request.log,
    });
    logStop(request, result);
    return reply.send(result);
  });

  // Lift a lockout this developer placed. One the operator placed is refused:
  // the developer's key may be the very credential the lockout is containing.
  app.post('/v1/emergency-stop/unfreeze', limited, async (request, reply) => {
    if (!emergencyStopEnabled()) {
      return reply.status(403).send({
        message: 'The emergency stop is not enabled', code: 'FEATURE_DISABLED', requestId: request.id,
      });
    }
    let parsed: ParsedUnfreeze;
    try {
      parsed = parseUnfreezeRequest(request.body);
      if ((request.body as StopBody).developerId !== undefined
          && (request.body as StopBody).developerId !== request.developer.id) {
        throw new StopRequestError(403, 'FORBIDDEN', 'this key can only lift its own lockouts');
      }
      if (parsed.scope.type === 'developer' && parsed.scope.id !== request.developer.id) {
        throw new StopRequestError(403, 'FORBIDDEN', 'this key can only lift its own lockouts');
      }
    } catch (err) {
      if (err instanceof StopRequestError) return sendError(request, reply, err);
      throw err;
    }
    return unfreeze(request, reply, {
      developerId: request.developer.id,
      parsed,
      requestedBy: `developer:${request.developer.id}@${request.ip}`,
      liftedBy: 'developer',
    });
  });

  app.get('/v1/emergency-stops', async (request, reply) => {
    if (!emergencyStopEnabled()) {
      return reply.status(403).send({
        message: 'The emergency stop is not enabled', code: 'FEATURE_DISABLED', requestId: request.id,
      });
    }
    // `page` and `pageSize` page the freezes in force, as the other paged
    // `/v1` lists do; `freezesTotal` says how many there are in all, so a
    // full page is never mistaken for the whole list. The stops are the most
    // recent ones, as before.
    const query = request.query as Record<string, string | undefined>;
    const page = parsePageNumber(query['page'], 1);
    const pageSize = parsePageNumber(query['pageSize'], DEFAULT_FREEZE_PAGE_SIZE);
    if (page === null || pageSize === null || pageSize > MAX_FREEZE_PAGE_SIZE) {
      return reply.status(400).send({
        message: `page must be an integer >= 1 and pageSize an integer between 1 and ${MAX_FREEZE_PAGE_SIZE}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const rows = await listEmergencyStops(getSql(), request.developer.id);
    const listed = await listActiveFreezes(getSql(), request.developer.id, { page, pageSize });
    return reply.send({
      stops: rows.map(toEmergencyStopResponse),
      freezes: listed.freezes.map(toFreezeResponse),
      freezesTotal: listed.total,
      page: listed.page,
      pageSize: listed.pageSize,
    });
  });

  // Operator-scoped: the platform admin key, which can stop any tenant.
  app.post(
    '/v1/admin/emergency-stop',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!emergencyStopEnabled()) {
        return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
      }
      if (!adminAuthorized(request, reply)) return reply;

      let parsed: ParsedStop;
      let developerId: string;
      try {
        parsed = parseStopRequest(request.body);
        developerId = operatorDeveloperId(parsed.scope, (request.body as StopBody).developerId, 'stopped');
      } catch (err) {
        if (err instanceof StopRequestError) {
          emergencyStopsTotal.inc({ scope: 'unknown', outcome: 'refused' });
          return sendError(request, reply, err);
        }
        throw err;
      }

      const result = await emergencyStop(getSql(), {
        developerId,
        scope: parsed.scope,
        reason: parsed.reason,
        // Which operator address made the call, so the record is not just
        // "admin". The key itself is never recorded, hashed or otherwise.
        requestedBy: `admin:${request.ip}`,
        dryRun: parsed.dryRun,
        lockout: parsed.lockout,
        authority: 'operator',
        log: request.log,
      });
      logStop(request, result);
      return reply.send(result);
    },
  );

  // Operator-scoped: lift any tenant's lockout, whoever placed it.
  app.post(
    '/v1/admin/emergency-stop/unfreeze',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!emergencyStopEnabled()) {
        return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
      }
      if (!adminAuthorized(request, reply)) return reply;

      let parsed: ParsedUnfreeze;
      let developerId: string;
      try {
        parsed = parseUnfreezeRequest(request.body);
        developerId = operatorDeveloperId(parsed.scope, (request.body as StopBody).developerId, 'unfrozen');
      } catch (err) {
        if (err instanceof StopRequestError) return sendError(request, reply, err);
        throw err;
      }
      return unfreeze(request, reply, {
        developerId,
        parsed,
        // As for the stop: the operator's address, never the key.
        requestedBy: `admin:${request.ip}`,
        liftedBy: 'operator',
      });
    },
  );
}

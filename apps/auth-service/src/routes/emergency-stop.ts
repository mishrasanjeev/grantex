/**
 * The emergency stop (PRD G-6): the documented way to halt every agent under
 * a grant, an agent, a principal or a whole developer.
 *
 *   POST /v1/emergency-stop          the developer's own tenant (developer API key)
 *   GET  /v1/emergency-stops         what has been stopped, and when
 *   POST /v1/admin/emergency-stop    any tenant (ADMIN_API_KEY), for the operator
 *
 * Off unless EMERGENCY_STOP_ENABLED=true. Every call must repeat a
 * confirmation phrase naming exactly what it will stop, and `dryRun` reports
 * the blast radius without revoking anything.
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

const MAX_REASON = 500;

export function emergencyStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['EMERGENCY_STOP_ENABLED'] === 'true';
}

interface StopBody {
  scope?: unknown;
  reason?: unknown;
  confirm?: unknown;
  dryRun?: unknown;
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
}

/** Validate the request, including the confirmation phrase. Nothing is revoked before this passes. */
export function parseStopRequest(body: unknown): ParsedStop {
  if (!isPlainObject(body)) throw new StopRequestError(400, 'BAD_REQUEST', 'body must be a JSON object');
  const { scope, reason, confirm, dryRun } = body as StopBody;
  if (!isPlainObject(scope) || typeof scope['type'] !== 'string'
      || !(STOP_SCOPES as readonly string[]).includes(scope['type'])
      || typeof scope['id'] !== 'string' || scope['id'].length === 0 || scope['id'].length > 256) {
    throw new StopRequestError(400, 'BAD_REQUEST',
      `scope must be {type: ${STOP_SCOPES.join('|')}, id} with an id of 1 to 256 characters`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON) {
    throw new StopRequestError(400, 'BAD_REQUEST', `reason is required (at most ${MAX_REASON} characters)`);
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new StopRequestError(400, 'BAD_REQUEST', 'dryRun must be a boolean');
  }
  const parsed: StopScope = { type: scope['type'] as StopScopeType, id: scope['id'] };
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
  return { scope: parsed, reason, dryRun: dryRun === true };
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
  }, result.dryRun ? 'emergency stop rehearsed' : 'emergency stop applied');
}

export async function emergencyStopRoutes(app: FastifyInstance): Promise<void> {
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/v1/emergency-stop', limited, async (request, reply) => {
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
      log: request.log,
    });
    logStop(request, result);
    return reply.send(result);
  });

  app.get('/v1/emergency-stops', async (request, reply) => {
    if (!emergencyStopEnabled()) {
      return reply.status(403).send({
        message: 'The emergency stop is not enabled', code: 'FEATURE_DISABLED', requestId: request.id,
      });
    }
    const rows = await listEmergencyStops(getSql(), request.developer.id);
    return reply.send({ stops: rows.map(toEmergencyStopResponse) });
  });

  // Operator-scoped: the platform admin key, which can stop any tenant.
  app.post(
    '/v1/admin/emergency-stop',
    { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!emergencyStopEnabled()) {
        return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
      }
      const adminKey = config.adminApiKey;
      if (!adminKey) {
        return reply.status(503).send({
          message: 'Admin API not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id,
        });
      }
      const expected = Buffer.from(`Bearer ${adminKey}`);
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        return reply.status(401).send({ message: 'Unauthorized', code: 'UNAUTHORIZED', requestId: request.id });
      }

      let parsed: ParsedStop;
      let developerId: string;
      try {
        parsed = parseStopRequest(request.body);
        const requested = (request.body as StopBody).developerId;
        if (parsed.scope.type === 'developer') {
          developerId = parsed.scope.id;
          if (requested !== undefined && requested !== developerId) {
            throw new StopRequestError(400, 'BAD_REQUEST', 'developerId must match the developer being stopped');
          }
        } else {
          if (typeof requested !== 'string' || requested.length === 0 || requested.length > 256) {
            throw new StopRequestError(400, 'BAD_REQUEST', 'developerId is required for a grant, agent or principal scope');
          }
          developerId = requested;
        }
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
        log: request.log,
      });
      logStop(request, result);
      return reply.send(result);
    },
  );
}

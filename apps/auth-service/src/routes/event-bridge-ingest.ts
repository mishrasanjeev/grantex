/**
 * Event bridge ingestion (PRD G-6). No API key: each delivery authenticates
 * itself, and anything that does not verify is refused with 401, counted and
 * never acted on.
 *
 *   POST /v1/event-bridge/ssf/:sourceId        Security Event Token push (RFC 8935),
 *                                              Content-Type: application/secevent+jwt
 *   POST /v1/event-bridge/webhooks/:sourceId   generic signed webhook, application/json,
 *                                              X-Grantex-Timestamp + X-Grantex-Signature
 *
 * Responses: 202 `{status}` once the event is processed (`unmapped`,
 * `applied`, `observed`) or recognised as a `duplicate`; 401 `{err,
 * description}` when unverifiable; 404 when the bridge is off.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { EventVerificationError, type EventVerificationReason } from '../lib/event-bridge/errors.js';
import { keyResolverFor } from '../lib/event-bridge/keys.js';
import {
  eventBridgeEventsReceivedTotal,
  eventBridgeEventsVerifiedTotal,
  reportVerificationFailure,
} from '../lib/event-bridge/metrics.js';
import type { EventSourceKind, NormalizedEvent } from '../lib/event-bridge/normalize.js';
import { handleVerifiedDelivery, unmappedProcessor } from '../lib/event-bridge/pipeline.js';
import type { EventProcessor } from '../lib/event-bridge/receipts.js';
import { eventBridgeEnabledFor, eventBridgeSettings } from '../lib/event-bridge/settings.js';
import { verifySecurityEventToken } from '../lib/event-bridge/set-verify.js';
import {
  acceptedWebhookSecrets,
  loadEventSourceForIngest,
  type EventSourceRow,
} from '../lib/event-bridge/sources.js';
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../lib/event-bridge/webhook-verify.js';

const MAX_BODY_BYTES = 256 * 1024;

interface SourceParams {
  sourceId: string;
}

export interface EventBridgeIngestOptions {
  /** Builds the processor for verified events. Defaults to the unmapped processor. */
  processorFor?: (request: FastifyRequest, source: EventSourceRow) => EventProcessor;
}

function mediaType(request: FastifyRequest): string {
  const header = request.headers['content-type'];
  return (typeof header === 'string' ? header : '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Every rejection looks the same to the sender.
 *
 * Distinguishing "no such source" from "bad signature" from "stale timestamp"
 * told anyone who could reach the endpoint which source ids exist and how far
 * they had got — an oracle for guessing them. The precise reason stays in the
 * structured log (`alert: event_bridge_verification_failure`) and in the
 * `reason` label of the failure counter, where the operator can see it and the
 * sender cannot.
 */
function unverifiable(
  request: FastifyRequest,
  reply: FastifyReply,
  sourceType: EventSourceKind,
  sourceId: string,
  reason: EventVerificationReason,
  description: string,
  developerId?: string,
): FastifyReply {
  reportVerificationFailure({ sourceType, reason, sourceId, ...(developerId !== undefined ? { developerId } : {}) }, request.log);
  const status = reason === 'unsupported_media_type' ? 415 : 401;
  return reply.status(status).send({
    err: status === 415 ? 'unsupported_media_type' : 'unverifiable',
    description: status === 415 ? description : 'the delivery could not be verified',
    code: 'EVENT_UNVERIFIABLE',
    requestId: request.id,
  });
}

export async function eventBridgeIngestRoutes(app: FastifyInstance, options: EventBridgeIngestOptions = {}): Promise<void> {
  // Signatures are over the exact bytes received, so this scope keeps bodies raw.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_BODY_BYTES }, (_request, body, done) => {
    done(null, body);
  });

  // Keyed on the client address alone. Including the source id let an
  // attacker mint a fresh bucket per made-up id — the same bypass the default
  // limiter documents for bearer tokens. `max` is a function, so
  // EVENT_BRIDGE_RATE_LIMIT_PER_MINUTE is read per request, as its
  // documentation says.
  const routeOptions = () => ({
    bodyLimit: MAX_BODY_BYTES,
    config: {
      skipAuth: true,
      rateLimit: {
        max: () => eventBridgeSettings().rateLimitPerMinute,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => `event-bridge:${request.ip}`,
      },
    },
  });

  async function ingest(
    request: FastifyRequest<{ Params: SourceParams }>,
    reply: FastifyReply,
    kind: EventSourceKind,
  ): Promise<FastifyReply> {
    const settings = eventBridgeSettings();
    if (!settings.enabled) {
      return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const { sourceId } = request.params;
    eventBridgeEventsReceivedTotal.inc({ source_type: kind });

    const expectedMedia = kind === 'ssf' ? 'application/secevent+jwt' : 'application/json';
    if (mediaType(request) !== expectedMedia) {
      return unverifiable(request, reply, kind, sourceId, 'unsupported_media_type', `Content-Type must be ${expectedMedia}`);
    }
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

    const sql = getSql();
    const source = await loadEventSourceForIngest(sql, sourceId);
    if (!source || source.kind !== kind) {
      return unverifiable(request, reply, kind, sourceId, 'source_unknown', 'unknown event source');
    }
    if (!eventBridgeEnabledFor(settings, source.developer_id)) {
      return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
    }
    if (source.status !== 'active') {
      return unverifiable(request, reply, kind, sourceId, 'source_disabled', 'event source is disabled', source.developer_id);
    }

    let events: NormalizedEvent[];
    let eventId: string;
    try {
      if (kind === 'ssf') {
        const verified = await verifySecurityEventToken(
          body.toString('utf8'),
          {
            id: source.id,
            developerId: source.developer_id,
            issuer: source.issuer ?? '',
            audience: source.audience ?? '',
            algorithms: source.algorithms,
            maxAgeSeconds: source.max_age_seconds,
          },
          keyResolverFor({ id: source.id, jwksUri: source.jwks_uri, jwks: source.jwks }),
        );
        events = verified.events;
        eventId = verified.jti;
      } else {
        let secrets: string[];
        try {
          secrets = acceptedWebhookSecrets(source);
        } catch {
          throw new EventVerificationError('secret_unavailable', 'source secret cannot be read');
        }
        verifyWebhookSignature({
          rawBody: body,
          timestamp: headerValue(request, WEBHOOK_TIMESTAMP_HEADER),
          signature: headerValue(request, WEBHOOK_SIGNATURE_HEADER),
          secrets,
          toleranceSeconds: source.tolerance_seconds,
        });
        const event = parseWebhookEvent(body, { id: source.id, developerId: source.developer_id });
        events = [event];
        eventId = event.eventId;
      }
    } catch (err) {
      if (err instanceof EventVerificationError) {
        return unverifiable(request, reply, kind, sourceId, err.reason, err.message, source.developer_id);
      }
      throw err;
    }
    eventBridgeEventsVerifiedTotal.inc({ source_type: kind });

    const processor = options.processorFor?.(request, source) ?? unmappedProcessor(request.log);
    try {
      const outcome = await handleVerifiedDelivery(sql, {
        sourceKind: kind,
        sourceId: source.id,
        developerId: source.developer_id,
        eventId,
        body,
        events,
      }, processor);
      return reply.status(202).send({ status: outcome.status, requestId: request.id });
    } catch (err) {
      if (err instanceof EventVerificationError) {
        return unverifiable(request, reply, kind, sourceId, err.reason, err.message, source.developer_id);
      }
      throw err;
    }
  }

  app.post<{ Params: SourceParams }>('/v1/event-bridge/ssf/:sourceId', routeOptions(), (request, reply) =>
    ingest(request, reply, 'ssf'));
  app.post<{ Params: SourceParams }>('/v1/event-bridge/webhooks/:sourceId', routeOptions(), (request, reply) =>
    ingest(request, reply, 'webhook'));
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

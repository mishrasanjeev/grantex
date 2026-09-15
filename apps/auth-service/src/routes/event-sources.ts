/**
 * Event source registration (PRD G-6). Tenant-scoped by the developer API key
 * and off unless EVENT_BRIDGE_ENABLED=true.
 *
 *   POST  /v1/event-sources                     register an SSF transmitter or webhook sender
 *   GET   /v1/event-sources                     list
 *   GET   /v1/event-sources/:id                 read
 *   PATCH /v1/event-sources/:id                 update (name, status, keys, windows)
 *   POST  /v1/event-sources/:id/rotate-secret   rotate a webhook secret
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { eventBridgeEnabledFor, eventBridgeSettings } from '../lib/event-bridge/settings.js';
import {
  SourceSecretStorageUnavailableError,
  SourceValidationError,
  createEventSource,
  getEventSource,
  listEventSources,
  rotateWebhookSecret,
  toSourceResponse,
  updateEventSource,
} from '../lib/event-bridge/sources.js';

interface IdParams {
  id: string;
}

function refuseWhenDisabled(request: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (!eventBridgeEnabledFor(eventBridgeSettings(), request.developer.id)) {
    return reply.status(403).send({ message: 'The event bridge is not enabled', code: 'FEATURE_DISABLED', requestId: request.id });
  }
  return null;
}

function validationError(request: FastifyRequest, reply: FastifyReply, err: SourceValidationError): FastifyReply {
  return reply.status(422).send({ message: err.message, code: 'VALIDATION_ERROR', fields: err.fields, requestId: request.id });
}

function secretStorageUnavailable(request: FastifyRequest, reply: FastifyReply, err: Error): FastifyReply {
  return reply.status(503).send({ message: err.message, code: 'SERVICE_UNAVAILABLE', requestId: request.id });
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ message: 'Event source not found', code: 'NOT_FOUND', requestId: request.id });
}

export async function eventSourcesRoutes(app: FastifyInstance): Promise<void> {
  const limited = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.post('/v1/event-sources', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    try {
      const created = await createEventSource(getSql(), request.developer.id, request.body);
      return reply.status(201).send({
        ...toSourceResponse(created.row),
        ...(created.secret !== undefined ? { secret: created.secret } : {}),
      });
    } catch (err) {
      if (err instanceof SourceValidationError) return validationError(request, reply, err);
      if (err instanceof SourceSecretStorageUnavailableError) return secretStorageUnavailable(request, reply, err);
      throw err;
    }
  });

  app.get('/v1/event-sources', async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    const rows = await listEventSources(getSql(), request.developer.id);
    return reply.send({ sources: rows.map(toSourceResponse) });
  });

  app.get<{ Params: IdParams }>('/v1/event-sources/:id', async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    const row = await getEventSource(getSql(), request.developer.id, request.params.id);
    return row ? reply.send(toSourceResponse(row)) : notFound(request, reply);
  });

  app.patch<{ Params: IdParams }>('/v1/event-sources/:id', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    try {
      const row = await updateEventSource(getSql(), request.developer.id, request.params.id, request.body);
      return row ? reply.send(toSourceResponse(row)) : notFound(request, reply);
    } catch (err) {
      if (err instanceof SourceValidationError) return validationError(request, reply, err);
      throw err;
    }
  });

  app.post<{ Params: IdParams }>('/v1/event-sources/:id/rotate-secret', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    try {
      const rotated = await rotateWebhookSecret(getSql(), request.developer.id, request.params.id, request.body);
      if (!rotated) return notFound(request, reply);
      return reply.send({ ...toSourceResponse(rotated.row), secret: rotated.secret });
    } catch (err) {
      if (err instanceof SourceValidationError) return validationError(request, reply, err);
      if (err instanceof SourceSecretStorageUnavailableError) return secretStorageUnavailable(request, reply, err);
      throw err;
    }
  });
}

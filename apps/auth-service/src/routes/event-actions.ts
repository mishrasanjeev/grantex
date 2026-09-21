/**
 * Mapping rules, the grant bindings they resolve, and resuming a suspended
 * subtree (PRD G-6). Tenant-scoped by the developer API key.
 *
 *   POST/GET  /v1/event-mapping-rules            declare what an event does
 *   GET/PATCH /v1/event-mapping-rules/:id
 *   PUT/GET   /v1/grants/:id/subject-refs        bind identifiers to a grant
 *   POST      /v1/grants/:id/resume              undo a suspension
 *
 * The rule routes and the bindings need EVENT_BRIDGE_ENABLED=true. Resume
 * does not: a deployment that turns the bridge off must still be able to
 * restore grants an event suspended while it was on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { isPlainObject } from '../lib/event-bridge/normalize.js';
import { RuleValidationError } from '../lib/event-bridge/mapping.js';
import {
  createMappingRule,
  getMappingRule,
  listMappingRules,
  toRuleResponse,
  updateMappingRule,
} from '../lib/event-bridge/rules-store.js';
import { eventBridgeEnabledFor, eventBridgeSettings } from '../lib/event-bridge/settings.js';
import { resumeSuspendedGrants } from '../lib/revocation/cascade.js';

const MAX_REFS_PER_GRANT = 50;
const REF_KIND = /^[a-z][a-z0-9_.:-]{0,63}$/;

interface IdParams {
  id: string;
}

function refuseWhenDisabled(request: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  if (!eventBridgeEnabledFor(eventBridgeSettings(), request.developer.id)) {
    return reply.status(403).send({ message: 'The event bridge is not enabled', code: 'FEATURE_DISABLED', requestId: request.id });
  }
  return null;
}

function validationError(request: FastifyRequest, reply: FastifyReply, err: RuleValidationError): FastifyReply {
  return reply.status(422).send({ message: err.message, code: 'VALIDATION_ERROR', fields: err.fields, requestId: request.id });
}

function notFound(request: FastifyRequest, reply: FastifyReply, what: string): FastifyReply {
  return reply.status(404).send({ message: `${what} not found`, code: 'NOT_FOUND', requestId: request.id });
}

interface SubjectRef {
  kind: string;
  value: string;
}

function parseRefs(body: unknown): SubjectRef[] {
  if (!isPlainObject(body) || !Array.isArray(body['refs'])) {
    throw new RuleValidationError({ refs: 'must be an array of {kind, value}' });
  }
  const refs = body['refs'] as unknown[];
  if (refs.length > MAX_REFS_PER_GRANT) {
    throw new RuleValidationError({ refs: `at most ${MAX_REFS_PER_GRANT} bindings per grant` });
  }
  const parsed: SubjectRef[] = [];
  for (const entry of refs) {
    if (!isPlainObject(entry) || typeof entry['kind'] !== 'string' || !REF_KIND.test(entry['kind'])
        || typeof entry['value'] !== 'string' || entry['value'].length === 0 || entry['value'].length > 256) {
      throw new RuleValidationError({
        refs: 'each binding needs a lower-case kind of at most 64 characters and a value of 1 to 256 characters',
      });
    }
    parsed.push({ kind: entry['kind'], value: entry['value'] });
  }
  return parsed;
}

export async function eventActionsRoutes(app: FastifyInstance): Promise<void> {
  const limited = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.post('/v1/event-mapping-rules', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    try {
      const row = await createMappingRule(getSql(), request.developer.id, request.body);
      return reply.status(201).send(toRuleResponse(row));
    } catch (err) {
      if (err instanceof RuleValidationError) return validationError(request, reply, err);
      throw err;
    }
  });

  app.get('/v1/event-mapping-rules', async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    const rows = await listMappingRules(getSql(), request.developer.id);
    return reply.send({ rules: rows.map(toRuleResponse) });
  });

  app.get<{ Params: IdParams }>('/v1/event-mapping-rules/:id', async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    const row = await getMappingRule(getSql(), request.developer.id, request.params.id);
    return row ? reply.send(toRuleResponse(row)) : notFound(request, reply, 'Mapping rule');
  });

  app.patch<{ Params: IdParams }>('/v1/event-mapping-rules/:id', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    try {
      const row = await updateMappingRule(getSql(), request.developer.id, request.params.id, request.body);
      return row ? reply.send(toRuleResponse(row)) : notFound(request, reply, 'Mapping rule');
    } catch (err) {
      if (err instanceof RuleValidationError) return validationError(request, reply, err);
      throw err;
    }
  });

  app.put<{ Params: IdParams }>('/v1/grants/:id/subject-refs', limited, async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    let refs: SubjectRef[];
    try {
      refs = parseRefs(request.body);
    } catch (err) {
      if (err instanceof RuleValidationError) return validationError(request, reply, err);
      throw err;
    }
    const sql = getSql();
    const developerId = request.developer.id;
    // The grant is checked inside the transaction that writes the bindings,
    // holding the row: a grant deleted or revoked concurrently cannot end up
    // with bindings that outlive the check.
    let found = false;
    await sql.begin(async (raw) => {
      const tx = raw as unknown as ReturnType<typeof getSql>;
      const grants = await tx<{ id: string }[]>`
        SELECT id FROM grants
         WHERE id = ${request.params.id} AND developer_id = ${developerId}
         FOR UPDATE`;
      if (!grants[0]) return;
      found = true;
      await tx`DELETE FROM grant_subject_refs WHERE grant_id = ${request.params.id} AND developer_id = ${developerId}`;
      for (const ref of refs) {
        await tx`
          INSERT INTO grant_subject_refs (developer_id, grant_id, kind, value)
          VALUES (${developerId}, ${request.params.id}, ${ref.kind}, ${ref.value})
          ON CONFLICT DO NOTHING`;
      }
    });
    if (!found) return notFound(request, reply, 'Grant');
    return reply.send({ grantId: request.params.id, refs });
  });

  app.get<{ Params: IdParams }>('/v1/grants/:id/subject-refs', async (request, reply) => {
    const refused = refuseWhenDisabled(request, reply);
    if (refused) return refused;
    const rows = await getSql()<{ kind: string; value: string }[]>`
      SELECT kind, value FROM grant_subject_refs
       WHERE grant_id = ${request.params.id} AND developer_id = ${request.developer.id}
       ORDER BY kind, value`;
    return reply.send({ grantId: request.params.id, refs: rows.map((row) => ({ kind: row.kind, value: row.value })) });
  });

  app.post<{ Params: IdParams }>('/v1/grants/:id/resume', limited, async (request, reply) => {
    const outcome = await resumeSuspendedGrants(getSql(), request.developer.id, request.params.id, {
      cause: 'api',
      trigger: 'api',
    });
    if (outcome.status === 'not_suspended') {
      return reply.status(404).send({
        message: 'Grant not found, or not the root of a suspension',
        code: 'NOT_FOUND',
        requestId: request.id,
      });
    }
    if (outcome.status === 'ancestor_inactive') {
      return reply.status(409).send({
        message: 'A grant above this one is revoked or suspended; resume that one first',
        code: 'ANCESTOR_INACTIVE',
        requestId: request.id,
      });
    }
    return reply.send({ grantId: request.params.id, resumedGrantIds: outcome.grantIds });
  });
}

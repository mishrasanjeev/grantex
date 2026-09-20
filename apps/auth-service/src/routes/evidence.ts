/**
 * Evidence endpoints (PRD G-5). Tenant-scoped by the developer API key,
 * rate limited, and off unless EVIDENCE_EXPORT_ENABLED=true.
 *
 *   POST /v1/evidence/cases/:caseId/records  append evidence records (idempotent per record id)
 *   POST /v1/evidence/cases/:caseId/void     void a recorded record (never deletes)
 *   POST /v1/evidence/cases/:caseId/export   assemble, anchor and return the package
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { getKeyPair } from '../lib/crypto.js';
import {
  EvidenceServiceError,
  appendEvidenceRecords,
  exportCasePackage,
  isValidCaseId,
  voidEvidenceRecord,
} from '../lib/evidence-service/service.js';
import { evidenceEnabledFor, evidenceSettings } from '../lib/evidence-service/settings.js';

interface CaseParams {
  caseId: string;
}

function sendError(request: FastifyRequest, reply: FastifyReply, err: EvidenceServiceError): FastifyReply {
  return reply.status(err.status).send({
    message: err.message,
    code: err.code,
    ...(err.fieldPath !== null ? { field_path: err.fieldPath } : {}),
    requestId: request.id,
  });
}

function guard(request: FastifyRequest<{ Params: CaseParams }>, reply: FastifyReply): FastifyReply | null {
  if (!evidenceEnabledFor(evidenceSettings(), request.developer.id)) {
    return reply.status(403).send({ message: 'Evidence export is not enabled', code: 'FEATURE_DISABLED', requestId: request.id });
  }
  if (!isValidCaseId(request.params.caseId)) {
    return reply.status(400).send({ message: 'caseId must be 1-256 printable ASCII characters', code: 'BAD_REQUEST', requestId: request.id });
  }
  return null;
}

export async function evidenceRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: CaseParams; Body: { records?: unknown } }>(
    '/v1/evidence/cases/:caseId/records',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const refused = guard(request, reply);
      if (refused) return refused;
      const body = request.body as { records?: unknown } | undefined;
      try {
        const records = await appendEvidenceRecords(getSql(), request.developer.id, request.params.caseId, body?.records);
        const created = records.some((r) => !r.duplicate);
        return reply.status(created ? 201 : 200).send({ case_id: request.params.caseId, records });
      } catch (err) {
        if (err instanceof EvidenceServiceError) return sendError(request, reply, err);
        throw err;
      }
    },
  );

  app.post<{ Params: CaseParams; Body: unknown }>(
    '/v1/evidence/cases/:caseId/void',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const refused = guard(request, reply);
      if (refused) return refused;
      try {
        const record = await voidEvidenceRecord(getSql(), request.developer.id, request.params.caseId, request.body ?? {});
        return reply.status(record.duplicate ? 200 : 201).send({ case_id: request.params.caseId, record });
      } catch (err) {
        if (err instanceof EvidenceServiceError) return sendError(request, reply, err);
        throw err;
      }
    },
  );

  app.post<{ Params: CaseParams; Body: unknown }>(
    '/v1/evidence/cases/:caseId/export',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const refused = guard(request, reply);
      if (refused) return refused;
      try {
        const result = await exportCasePackage(getSql(), {
          developerId: request.developer.id,
          caseId: request.params.caseId,
          issuer: config.jwtIssuer,
          settings: evidenceSettings(),
          options: request.body ?? {},
          signer: () => {
            const { privateKey, kid, alg } = getKeyPair();
            return { privateKey, kid, alg };
          },
        });
        return reply
          .status(200)
          .header('content-type', 'application/json')
          .header('cache-control', 'no-store')
          .header('grantex-evidence-root', result.root)
          .header('grantex-evidence-anchor', result.anchorHash)
          .header('grantex-evidence-decisions', result.decisionsAvailable ? 'included' : 'unavailable')
          .send(Buffer.from(result.data));
      } catch (err) {
        if (err instanceof EvidenceServiceError) return sendError(request, reply, err);
        throw err;
      }
    },
  );
}

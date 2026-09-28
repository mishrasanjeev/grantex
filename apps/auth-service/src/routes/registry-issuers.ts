// SPDX-License-Identifier: Apache-2.0
/**
 * Accredited issuers in the registry (Agent Trust Registry, Phase 1).
 *
 * With REGISTRY_STATUS_RECONCILIATION_ENABLED=true, a PATCH then brings the
 * issuer's attestations and the grants bound to them in line at once
 * (lib/registry/status-reconciliation.ts applyRegistryDecisions): a
 * suspension suspends them, a reinstatement resumes what the registry
 * suspended, a revoked kid withdraws what it signed and revokes the grants.
 *
 *   POST  /v1/registry/issuers        accredit an issuer (registry operator key)
 *   PATCH /v1/registry/issuers/:id    suspend, reinstate or withdraw it, change its
 *                                     trust marks, replace its JWK Set, revoke a kid
 *                                     (registry operator key)
 *   GET   /v1/registry/issuers        the public, minimised list relying parties read,
 *                                     paged with page and pageSize (only with
 *                                     REGISTRY_PUBLIC_ENDPOINTS_ENABLED=true)
 *
 * The write routes take a key from REGISTRY_OPERATOR_API_KEYS, compared in
 * constant time (lib/registry/operator-auth.ts). With no usable key
 * configured they answer 503, as the admin routes do without ADMIN_API_KEY:
 * nothing can be accredited until an operator credential exists. Every write
 * goes on the registry's audit chain in the same transaction as the change.
 *
 * The public list needs no key, so it is registered only when
 * REGISTRY_PUBLIC_ENDPOINTS_ENABLED is exactly 'true' (config.ts): new
 * endpoints ship enabled only behind authentication. Off, the route does not
 * exist and a request answers as any unknown route does. On, it is limited
 * per client address like the other public reads, pages with page and
 * pageSize and reports the total, and carries an ETag so a relying party
 * polling it can ask for changes only.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import {
  DEFAULT_PUBLIC_ISSUER_PAGE_SIZE,
  IssuerRecordError,
  MAX_PUBLIC_ISSUER_PAGE_SIZE,
  createAccreditedIssuer,
  listPublicIssuers,
  parseAccreditationRequest,
  parseIssuerPatch,
  toOperatorIssuer,
  updateAccreditedIssuer,
} from '../lib/registry/issuers.js';
import { operatorKeyMatches, registryOperatorKeys } from '../lib/registry/operator-auth.js';
import { registryReconcileFailuresTotal } from '../lib/registry/reconciliation-metrics.js';
import { applyRegistryDecisions } from '../lib/registry/status-reconciliation.js';

/** Public reads per client address per minute. */
export const PUBLIC_ISSUER_LIST_RATE_LIMIT = 60;

/** Check the registry operator key. Sends the refusal and returns false when it is missing or wrong. */
function operatorAuthorized(request: FastifyRequest, reply: FastifyReply): boolean {
  const keys = registryOperatorKeys();
  if (keys.length === 0) {
    void reply.status(503).send({
      message: 'Registry operator API not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id,
    });
    return false;
  }
  if (!operatorKeyMatches(request.headers.authorization, keys)) {
    void reply.status(401).send({ message: 'Unauthorized', code: 'UNAUTHORIZED', requestId: request.id });
    return false;
  }
  return true;
}

function sendRecordError(request: FastifyRequest, reply: FastifyReply, err: IssuerRecordError): FastifyReply {
  return reply.status(err.statusCode).send({
    message: err.message,
    code: err.code,
    ...(err.field !== undefined ? { field: err.field } : {}),
    requestId: request.id,
  });
}

/** Which operator address made the call. The key itself is never recorded, hashed or otherwise. */
function requestedBy(request: FastifyRequest): string {
  return `registry-operator:${request.ip}`;
}

/** A whole number >= 1, the fallback when absent, or null for anything else (a repeated parameter included). */
function parsePageNumber(value: unknown, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(',').map((tag) => tag.trim().replace(/^W\//, '')).some((tag) => tag === etag || tag === '*');
}

export async function registryIssuerRoutes(app: FastifyInstance): Promise<void> {
  const operator = { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post('/v1/registry/issuers', operator, async (request, reply) => {
    if (!operatorAuthorized(request, reply)) return reply;
    try {
      const input = parseAccreditationRequest(request.body);
      const record = await createAccreditedIssuer(getSql(), input, requestedBy(request));
      request.log.warn({
        alert: 'registry_issuer_accredited', issuerId: record.id, trustMarks: record.trustMarks,
      }, 'accredited issuer added to the registry');
      return reply.status(201).send(toOperatorIssuer(record));
    } catch (err) {
      if (err instanceof IssuerRecordError) return sendRecordError(request, reply, err);
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/v1/registry/issuers/:id', operator, async (request, reply) => {
    if (!operatorAuthorized(request, reply)) return reply;
    const { id } = request.params;
    try {
      if (id.length === 0 || id.length > 64) throw new IssuerRecordError('unknown issuer', 'id', 404, 'NOT_FOUND');
      const patch = parseIssuerPatch(request.body);
      const record = await updateAccreditedIssuer(getSql(), id, patch, requestedBy(request));
      if (!record) {
        return reply.status(404).send({ message: 'Accredited issuer not found', code: 'NOT_FOUND', requestId: request.id });
      }
      request.log.warn({
        alert: 'registry_issuer_updated',
        issuerId: record.id,
        status: record.status,
        revokedKids: patch.revokeKids?.length ?? 0,
      }, 'accredited issuer changed');
      if (config.registryStatusReconciliationEnabled) {
        try {
          const cascade = await applyRegistryDecisions(getSql(), { issuerId: record.id });
          request.log.warn({ alert: 'registry_issuer_cascade', issuerId: record.id, ...cascade },
            'accredited issuer change cascaded to its attestations and bound grants');
        } catch (err) {
          // The change itself is committed, and every issuance and refresh of
          // a bound grant already refuses on it (issuer_suspended,
          // passport_revoked). What failed is pushing it to the acceptance
          // lists and the revocation feed: logged and counted here, and done
          // by the reconciliation loop at its next tick.
          registryReconcileFailuresTotal.inc({ step: 'cascade' });
          request.log.error({ err, alert: 'registry_issuer_cascade_failed', issuerId: record.id },
            'accredited issuer change could not be cascaded now; the reconciliation loop retries it');
        }
      }
      return reply.send(toOperatorIssuer(record));
    } catch (err) {
      if (err instanceof IssuerRecordError) return sendRecordError(request, reply, err);
      throw err;
    }
  });

  // Unauthenticated, so off unless the operator turns it on (see the header).
  if (!config.registryPublicEndpointsEnabled) return;

  app.get(
    '/v1/registry/issuers',
    { config: { skipAuth: true, rateLimit: { max: PUBLIC_ISSUER_LIST_RATE_LIMIT, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // `page` and `pageSize` page the list, as the other paged /v1 lists do;
      // `total` says how many issuers there are in all.
      const query = request.query as Record<string, unknown>;
      const page = parsePageNumber(query['page'], 1);
      const pageSize = parsePageNumber(query['pageSize'], DEFAULT_PUBLIC_ISSUER_PAGE_SIZE);
      // The offset must stay a safe integer, or it would reach the query as a
      // number Postgres cannot take and answer 500 instead of 400.
      if (page === null || pageSize === null || pageSize > MAX_PUBLIC_ISSUER_PAGE_SIZE
        || !Number.isSafeInteger((page - 1) * pageSize)) {
        return reply.status(400).send({
          message: `page must be an integer >= 1 and pageSize an integer between 1 and ${MAX_PUBLIC_ISSUER_PAGE_SIZE}`,
          code: 'BAD_REQUEST',
          requestId: request.id,
        });
      }
      const body = await listPublicIssuers(getSql(), { page, pageSize });
      // Over the body itself, so it changes whenever what a relying party
      // would read changes, including a scheduled suspension taking effect.
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
      reply.header('ETag', etag);
      // no-cache, not a max-age: a cache must revalidate every read (a cheap
      // 304 while the ETag holds), so a revoked kid or a suspension that has
      // taken effect is never served stale (RFC 9111 section 5.2.2.4).
      reply.header('Cache-Control', 'no-cache');
      if (etagMatches(request.headers['if-none-match'], etag)) return reply.status(304).send();
      return reply.send(body);
    },
  );
}

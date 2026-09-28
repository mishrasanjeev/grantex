// SPDX-License-Identifier: Apache-2.0
/**
 * Public reads of the registry's attestation-acceptance status lists
 * (lib/registry/acceptance-status.ts).
 *
 * - GET /status/attestations/:list — Token Status List token,
 *   `application/statuslist+jwt` (draft-ietf-oauth-status-list-21 §8.2).
 * - GET /status/attestations/:list/bitstring — BitstringStatusListCredential,
 *   statusPurpose `revocation`, as `application/vc+jwt` (W3C VC-JOSE-COSE
 *   §6.1.1; Bitstring Status List v1.0 §4 leaves the media type to the
 *   securing mechanism).
 * - GET /status/attestations/:list/bitstring/suspension — the same for
 *   statusPurpose `suspension`.
 *
 * No authentication: relying parties and holders fetch these without an
 * account, and they reveal nothing beyond each entry's status. Each route is
 * rate-limited per client address. Responses carry a weak ETag and
 * `Cache-Control: public, max-age=<ttl>`, the ttl the list itself states
 * (Bitstring Status List §2.2 asks for the two to be aligned; the Token
 * Status List's own claims take precedence over HTTP caching, §8.2).
 *
 * A store that cannot be read is a 5xx. There is no fallback to a cached
 * copy: serving an older list could show a withdrawn attestation as
 * accepted.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCEPTANCE_LIST_PATH,
  ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE,
  loadAcceptanceSnapshot,
  signBitstringStatusListCredential,
  signTokenStatusList,
  type AcceptanceSnapshot,
  type SignedStatusList,
} from '../lib/registry/acceptance-status.js';

/** draft-ietf-oauth-status-list-21 §8.1, §8.2. */
export const TOKEN_STATUS_LIST_MEDIA_TYPE = 'application/statuslist+jwt';
/** W3C VC-JOSE-COSE §6.1.1. */
export const VC_JWT_MEDIA_TYPE = 'application/vc+jwt';

/** RFC 9110 §13.1.2: If-None-Match uses the weak comparison function. */
function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return value.split(',').some((candidate) => candidate.trim() === '*' || opaque(candidate) === wanted);
}

async function send(
  request: FastifyRequest,
  reply: FastifyReply,
  mediaType: string,
  build: (snapshot: AcceptanceSnapshot) => Promise<SignedStatusList>,
): Promise<FastifyReply> {
  const { list } = request.params as { list: string };
  const snapshot = await loadAcceptanceSnapshot(list);
  if (!snapshot) {
    return reply.status(404).send({ message: 'Status list not found', code: 'NOT_FOUND', requestId: request.id });
  }
  const signed = await build(snapshot);
  // draft-ietf-oauth-status-list-21 §8.1: the endpoint SHOULD support CORS.
  // The list is public and read without credentials, so any origin may read it.
  reply.header('access-control-allow-origin', '*');
  reply.removeHeader('access-control-allow-credentials');
  reply.header('etag', signed.etag);
  reply.header('cache-control', `public, max-age=${signed.ttlSeconds}`);
  if (matchesIfNoneMatch(request.headers['if-none-match'], signed.etag)) {
    return reply.status(304).send();
  }
  return reply.type(mediaType).send(signed.token);
}

export async function registryStatusRoutes(app: FastifyInstance): Promise<void> {
  const options = {
    config: {
      skipAuth: true,
      rateLimit: { max: ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
    },
  };

  app.get(`${ACCEPTANCE_LIST_PATH}/:list`, options, async (request, reply) =>
    send(request, reply, TOKEN_STATUS_LIST_MEDIA_TYPE, (snapshot) => signTokenStatusList(snapshot)));

  app.get(`${ACCEPTANCE_LIST_PATH}/:list/bitstring`, options, async (request, reply) =>
    send(request, reply, VC_JWT_MEDIA_TYPE, (snapshot) => signBitstringStatusListCredential(snapshot, 'revocation')));

  // Only `suspension` has a path of its own; the bare path is `revocation`.
  // Any other purpose is a 404 rather than the generic unknown-route answer.
  app.get(`${ACCEPTANCE_LIST_PATH}/:list/bitstring/:purpose`, options, async (request, reply) => {
    const { purpose } = request.params as { purpose: string };
    if (purpose !== 'suspension') {
      return reply.status(404).send({ message: 'Status list not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return send(request, reply, VC_JWT_MEDIA_TYPE, (snapshot) => signBitstringStatusListCredential(snapshot, 'suspension'));
  });
}

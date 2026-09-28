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
 * account, and they reveal nothing beyond each entry's status. Because they
 * are unauthenticated, they are registered only when
 * REGISTRY_PUBLIC_ENDPOINTS_ENABLED is exactly 'true' at boot; otherwise they
 * are not routes at all and answer 404 like any unknown path. Each route is
 * rate-limited per client address. Responses carry a weak ETag and
 * `Cache-Control: public, max-age=<ttl>`, the ttl the list itself states
 * (Bitstring Status List §2.2 asks for the two to be aligned; the Token
 * Status List's own claims take precedence over HTTP caching, §8.2).
 *
 * CORS (draft-ietf-oauth-status-list-21 §8.1: the endpoint SHOULD support
 * CORS) follows the Fetch standard's CORS protocol. A relying party in a
 * browser that revalidates with If-None-Match sends a preflight first, since
 * If-None-Match is not a CORS-safelisted request-header; each route answers it
 * with Access-Control-Allow-Origin `*`, Allow-Methods `GET` and Allow-Headers
 * `If-None-Match`, and never Allow-Credentials (a `*` origin is refused for
 * credentialed requests anyway). ETag is not a CORS-safelisted response
 * header, so GET responses, 304 included, list it in
 * Access-Control-Expose-Headers. This overrides the service-wide CORS policy
 * (an origin allow-list with credentials) for these routes only.
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
import { config } from '../config.js';

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
  // The route's CORS policy (PUBLIC_LIST_CORS) sets the same headers in the
  // preValidation hook; they are set here too so a reply never depends on the
  // hook having run.
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-expose-headers', 'ETag');
  reply.removeHeader('access-control-allow-credentials');
  reply.header('etag', signed.etag);
  reply.header('cache-control', `public, max-age=${signed.ttlSeconds}`);
  if (matchesIfNoneMatch(request.headers['if-none-match'], signed.etag)) {
    return reply.status(304).send();
  }
  return reply.type(mediaType).send(signed.token);
}

/**
 * Route-level override of the service-wide @fastify/cors options (merged over
 * them for these routes only). A fixed `*` origin, no credentials, and only
 * what a conditional GET needs.
 */
export const PUBLIC_LIST_CORS = {
  origin: '*',
  credentials: false,
  methods: ['GET'],
  allowedHeaders: ['If-None-Match'],
  exposedHeaders: ['ETag'],
  maxAge: 600,
} as const;

export async function registryStatusRoutes(app: FastifyInstance): Promise<void> {
  // Unauthenticated reads ship only behind a flag that defaults off. With it
  // off nothing is registered, so the paths are unknown routes (404) and no
  // preflight is answered for them either.
  if (!config.registryPublicEndpointsEnabled) return;

  const options = {
    config: {
      skipAuth: true,
      cors: PUBLIC_LIST_CORS,
      rateLimit: { max: ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
    },
  };

  // Preflight routes. The CORS hook answers a preflight (Origin and
  // Access-Control-Request-Method present) with 204 before the handler runs;
  // an OPTIONS request that is not a preflight is refused by that hook with
  // 400. The handler is reached only if the hook did not answer.
  for (const path of [
    `${ACCEPTANCE_LIST_PATH}/:list`,
    `${ACCEPTANCE_LIST_PATH}/:list/bitstring`,
    `${ACCEPTANCE_LIST_PATH}/:list/bitstring/:purpose`,
  ]) {
    app.options(path, options, async (_request, reply) => reply.status(204).send());
  }

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

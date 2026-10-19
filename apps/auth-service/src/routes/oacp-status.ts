// SPDX-License-Identifier: Apache-2.0
/**
 * Public reads of the OACP Token Status Lists (lib/commerce/oacp-status.ts).
 *
 * - GET /status/oacp/:list — Token Status List token,
 *   `application/statuslist+jwt` (draft-ietf-oauth-status-list-21 §8.2).
 *
 * No authentication: relying parties check an artifact's status without an
 * account, and a list reveals nothing beyond each entry's two status bits.
 * Because it is unauthenticated, the route is registered only when
 * OACP_STATUS_LIST_PUBLIC_ENABLED is exactly 'true' at boot (a flag of its
 * own, separate from REGISTRY_PUBLIC_ENDPOINTS_ENABLED, so OACP status can be
 * published without the registry's public reads); otherwise the path is an
 * unknown route (answered like any unknown path). Rate-limited per client address; weak ETag and
 * `Cache-Control: public, max-age=<ttl>`; CORS as for the registry lists.
 *
 * A store that cannot be read is a 5xx, never an older copy: a revoked
 * artifact must not read as valid.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  OACP_STATUS_LIST_MEDIA_TYPE,
  OACP_STATUS_LIST_PATH,
  OACP_STATUS_RATE_LIMIT_PER_MINUTE,
  loadOacpStatusSnapshot,
  signOacpStatusList,
} from '../lib/commerce/oacp-status.js';
import { PUBLIC_LIST_CORS, matchesIfNoneMatch } from './registry-status.js';

export async function oacpStatusRoutes(app: FastifyInstance): Promise<void> {
  if (!config.oacpStatusListPublicEnabled) return;

  const options = {
    config: {
      skipAuth: true,
      cors: PUBLIC_LIST_CORS,
      rateLimit: { max: OACP_STATUS_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' },
    },
  };

  app.options(`${OACP_STATUS_LIST_PATH}/:list`, options, async (_request, reply) => reply.status(204).send());

  app.get(`${OACP_STATUS_LIST_PATH}/:list`, options, async (request, reply) => {
    const { list } = request.params as { list: string };
    const snapshot = await loadOacpStatusSnapshot(list);
    if (!snapshot) {
      return reply.status(404).send({ message: 'Status list not found', code: 'NOT_FOUND', requestId: request.id });
    }
    const signed = await signOacpStatusList(snapshot);
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-expose-headers', 'ETag');
    reply.removeHeader('access-control-allow-credentials');
    reply.header('etag', signed.etag);
    reply.header('cache-control', `public, max-age=${signed.ttlSeconds}`);
    if (matchesIfNoneMatch(request.headers['if-none-match'], signed.etag)) {
      return reply.status(304).send();
    }
    return reply.type(OACP_STATUS_LIST_MEDIA_TYPE).send(signed.token);
  });
}

// SPDX-License-Identifier: Apache-2.0
/**
 * The registry lookup and the signed registry manifest (PRD §7 Lookup,
 * Federation and discovery; spec/registry-federation.md).
 *
 *   GET /v1/registry/agents/:did                                         one agent by DID
 *   GET /v1/registry/agents?key_thumbprint=                              by a key in its history
 *   GET /v1/registry/agents?issuer=&external_credential_id=&hash=        by an attested credential
 *   GET /.well-known/agent-registry.json                                 the signed manifest
 *
 * An authenticated relying party is a request carrying a valid developer API
 * key, checked by the standard auth plugin's own function; it reads the
 * whole lookup, legal identifiers, provider name and status list entries
 * included (lib/registry/lookup.ts). A dedicated relying-party credential is
 * a later refinement.
 *
 * REGISTRY_PUBLIC_ENDPOINTS_ENABLED (default off, read when the app is
 * built) decides what is registered:
 *
 *   off  the lookup routes require an API key like any /v1 route, and the
 *        manifest route does not exist;
 *   on   the lookup routes also answer without a key, minimised, and the
 *        manifest is served.
 *
 * With the flag on, a request that carries an Authorization header is
 * authenticated before the handler runs and refused with 401 if the key is
 * not valid: a bad key is never answered as if no key had been sent. Every
 * route is limited per client address; an authenticated request also draws
 * on its developer's plan bucket (plugins/dynamicRateLimit.ts), which is the
 * per-API-key limit.
 *
 * Unknown agents, and credentials that do not match on all three values,
 * are the same 404 with no ETag. A store that cannot be read is a 5xx.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { authenticateRequest } from '../plugins/auth.js';
import {
  LOOKUP_PUBLIC_MAX_AGE_SECONDS,
  LOOKUP_RATE_LIMIT_PER_MINUTE,
  LookupRequestError,
  lookupAgent,
  parseLookupDid,
  parseLookupQuery,
  type LookupRef,
} from '../lib/registry/lookup.js';
import {
  REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS,
  REGISTRY_MANIFEST_MEDIA_TYPE,
  REGISTRY_MANIFEST_PATH,
  REGISTRY_MANIFEST_RATE_LIMIT_PER_MINUTE,
  buildRegistryManifest,
} from '../lib/registry/manifest.js';

/** RFC 9110 §13.1.2: If-None-Match uses the weak comparison function. */
function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return value.split(',').some((candidate) => candidate.trim() === '*' || opaque(candidate) === wanted);
}

/** Add a field name to Vary, keeping those already there (RFC 9110 §12.5.5). */
function appendVary(reply: FastifyReply, name: string): void {
  const current = reply.getHeader('vary');
  const names = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',').map((field) => field.trim()).filter((field) => field.length > 0);
  if (names.includes('*') || names.some((field) => field.toLowerCase() === name.toLowerCase())) return;
  reply.header('Vary', [...names, name].join(', '));
}

async function answer(request: FastifyRequest, reply: FastifyReply, parse: () => LookupRef): Promise<FastifyReply> {
  let ref: LookupRef;
  try {
    ref = parse();
  } catch (err) {
    if (err instanceof LookupRequestError) {
      return reply.status(400).send({ message: err.message, code: 'BAD_REQUEST', requestId: request.id });
    }
    throw err;
  }
  // request.developer is set only by a successful API-key check.
  const authenticated = Boolean(request.developer);
  const found = await lookupAgent(getSql(), ref, { authenticated });
  // The answer differs with and without a key (RFC 9110 §12.5.5). Appended,
  // not set: reply.header replaces, and the CORS plugin has already added
  // Vary: Origin, which a shared cache needs for the reflected origin.
  appendVary(reply, 'Authorization');
  if (!found) {
    return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
  }
  const etag = `"${createHash('sha256').update(JSON.stringify(found)).digest('base64url')}"`;
  reply.header('ETag', etag);
  // A public answer may be cached as long as the registry's shortest status
  // list ttl; an authenticated one is for its caller only and revalidated
  // on every read (RFC 9111 §5.2.2.4, §5.2.2.7).
  reply.header('Cache-Control', authenticated ? 'private, no-cache' : `public, max-age=${LOOKUP_PUBLIC_MAX_AGE_SECONDS}`);
  if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) return reply.status(304).send();
  return reply.send(found);
}

export async function registryLookupRoutes(app: FastifyInstance): Promise<void> {
  const publicEndpoints = config.registryPublicEndpointsEnabled;
  const rateLimit = { max: LOOKUP_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };
  const options = publicEndpoints
    ? {
        config: { skipAuth: true, rateLimit },
        // Optional authentication: before the global preHandlers, so the
        // per-developer plan limiter sees request.developer.
        preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
          if (request.headers.authorization === undefined) return;
          await authenticateRequest(request, reply);
          // A refused key has been answered (401): stop here.
          if (reply.sent) return reply;
        },
      }
    : { config: { rateLimit } };

  app.get('/v1/registry/agents/:did', options, async (request, reply) =>
    answer(request, reply, () => parseLookupDid((request.params as { did: string }).did)));

  app.get('/v1/registry/agents', options, async (request, reply) =>
    answer(request, reply, () => parseLookupQuery(request.query)));

  if (!publicEndpoints) return;

  app.get(
    REGISTRY_MANIFEST_PATH,
    { config: { skipAuth: true, rateLimit: { max: REGISTRY_MANIFEST_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const manifest = await buildRegistryManifest();
      // Public and read without credentials, like the status lists.
      reply.header('access-control-allow-origin', '*');
      reply.removeHeader('access-control-allow-credentials');
      reply.header('ETag', manifest.etag);
      // Cacheable until the next issue interval could begin, never past exp.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const maxAge = Math.max(0, Math.min(REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS, manifest.claims.exp - nowSeconds));
      reply.header('Cache-Control', `public, max-age=${maxAge}`);
      if (matchesIfNoneMatch(request.headers['if-none-match'], manifest.etag)) return reply.status(304).send();
      return reply.type(REGISTRY_MANIFEST_MEDIA_TYPE).send(manifest.token);
    },
  );
}

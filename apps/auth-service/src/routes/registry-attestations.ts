// SPDX-License-Identifier: Apache-2.0
/**
 * Attestations posted by accredited issuers (Agent Trust Registry, Phase 1).
 *
 *   POST   /v1/registry/attestations              post an attestation (the body is the compact JWS)
 *   DELETE /v1/registry/attestations/:id          withdraw it
 *   POST   /v1/registry/attestations/:id/refresh  renew it with a new JWS (the body)
 *
 * POST needs no API key: the issuer's signature, verified against the
 * registry's record of the issuer, is the authentication. It is limited per
 * client address like the other unauthenticated routes.
 *
 * DELETE and refresh take either of two credentials in Authorization:
 *
 *   GrantexIssuer <compact JWS>   the issuer's signed request, typ
 *                                 grantex-attestation-request+jwt, naming the
 *                                 attestation, the action and this registry,
 *                                 fresh and used once (spec/attestation-1.0.md §7)
 *   Bearer <operator key>         a key from REGISTRY_OPERATOR_API_KEYS, for the
 *                                 registry operator acting on its own authority
 *
 * The issuer's own request is the normal path: the party that made the
 * attestation takes it back. The operator key covers what an issuer cannot
 * do for itself, such as an issuer that has been withdrawn and has no keys.
 *
 * The bodies are `application/jwt` (RFC 7519 §10.3.1) or the profile's own
 * `application/grantex-attestation+jwt`; anything else is 415. Refusals carry
 * a PRD Appendix C code and a reason.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { AttestationError, type AttestationDenial } from '../lib/registry/attestation-jws.js';
import {
  ingestAttestation,
  refreshAttestation,
  toPublicAttestation,
  withdrawAttestation,
  type RegistryActor,
} from '../lib/registry/attestations.js';
import { operatorKeyMatches, registryOperatorKeys } from '../lib/registry/operator-auth.js';

/** Posts per client address per minute. */
export const ATTESTATION_POST_RATE_LIMIT = 30;
/** Withdrawals and refreshes per client address per minute. */
export const ATTESTATION_CHANGE_RATE_LIMIT = 30;
/** A compact JWS of the profile is far smaller; this bounds what is parsed at all. */
export const MAX_ATTESTATION_BODY_BYTES = 16_384;

export const ATTESTATION_MEDIA_TYPES = ['application/jwt', 'application/grantex-attestation+jwt'] as const;

export const ATTESTATION_REFUSAL_STATUS: Record<AttestationDenial, number> = {
  attestation_malformed: 400,
  attestation_hash_mismatch: 400,
  passport_invalid_signature: 401,
  request_signature_invalid: 401,
  request_signature_stale: 401,
  audience_mismatch: 401,
  issuer_not_accredited: 403,
  issuer_suspended: 403,
  trust_mark_missing: 403,
  attestation_not_registered: 404,
  attestation_conflict: 409,
  attestation_not_accepted: 409,
  attestation_mismatch: 422,
  key_not_active: 422,
  key_unproven: 422,
  passport_expired: 422,
  passport_revoked: 422,
  // The issuer's list could not be read or trusted now; a later post may succeed.
  status_stale: 503,
};

function sendRefusal(request: FastifyRequest, reply: FastifyReply, err: AttestationError): FastifyReply {
  return reply.status(ATTESTATION_REFUSAL_STATUS[err.code]).send({
    message: err.message, code: err.code, reason: err.reason, requestId: request.id,
  });
}

/**
 * The credential for a withdrawal or refresh, or a refusal. A bearer token
 * that is not an operator key is refused as such, never tried as anything
 * else.
 */
function actorFor(request: FastifyRequest): RegistryActor {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const issuer = /^GrantexIssuer ([A-Za-z0-9_.-]{1,16384})$/.exec(authorization);
    if (issuer) return { kind: 'issuer', request: issuer[1]! };
    if (authorization.startsWith('Bearer ')) {
      const keys = registryOperatorKeys();
      if (keys.length > 0 && operatorKeyMatches(authorization, keys)) {
        return { kind: 'operator', requestedBy: `registry-operator:${request.ip}` };
      }
      throw new AttestationError('request_signature_invalid', 'operator_key_invalid', 'the operator key is not valid');
    }
  }
  throw new AttestationError('request_signature_invalid', 'missing',
    'send the issuer\'s signed request (Authorization: GrantexIssuer <JWS>) or the operator key');
}

function bodyText(request: FastifyRequest): string {
  return typeof request.body === 'string' ? request.body.trim() : '';
}

/** The body must be a JWS media type; JSON or a form is 415, not parsed as an attestation. */
function mediaTypeRefused(request: FastifyRequest, reply: FastifyReply): boolean {
  const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if ((ATTESTATION_MEDIA_TYPES as readonly string[]).includes(type)) return false;
  void reply.status(415).send({
    message: `send the compact JWS as ${ATTESTATION_MEDIA_TYPES.join(' or ')}`,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    requestId: request.id,
  });
  return true;
}

export async function registryAttestationRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: these parsers exist only for the routes below.
  app.addContentTypeParser(
    [...ATTESTATION_MEDIA_TYPES],
    { parseAs: 'string', bodyLimit: MAX_ATTESTATION_BODY_BYTES },
    (_request, body, done) => done(null, body),
  );

  const post = { config: { skipAuth: true, rateLimit: { max: ATTESTATION_POST_RATE_LIMIT, timeWindow: '1 minute' } } };
  const change = { config: { skipAuth: true, rateLimit: { max: ATTESTATION_CHANGE_RATE_LIMIT, timeWindow: '1 minute' } } };

  app.post('/v1/registry/attestations', post, async (request, reply) => {
    if (mediaTypeRefused(request, reply)) return reply;
    try {
      const { record, created } = await ingestAttestation(getSql(), bodyText(request));
      if (created) {
        request.log.info({
          alert: 'registry_attestation_accepted', attestationId: record.id, type: record.type,
        }, 'attestation accepted by the registry');
      }
      return reply.status(created ? 201 : 200).send(toPublicAttestation(record));
    } catch (err) {
      if (err instanceof AttestationError) return sendRefusal(request, reply, err);
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/v1/registry/attestations/:id', change, async (request, reply) => {
    try {
      const record = await withdrawAttestation(getSql(), request.params.id, actorFor(request));
      request.log.warn({ alert: 'registry_attestation_withdrawn', attestationId: record.id }, 'attestation withdrawn');
      return reply.send(toPublicAttestation(record));
    } catch (err) {
      if (err instanceof AttestationError) return sendRefusal(request, reply, err);
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/v1/registry/attestations/:id/refresh', change, async (request, reply) => {
    try {
      const actor = actorFor(request);
      if (mediaTypeRefused(request, reply)) return reply;
      const { record, superseded } = await refreshAttestation(getSql(), request.params.id, bodyText(request), actor);
      request.log.info({
        alert: 'registry_attestation_refreshed', attestationId: record.id, supersedes: superseded.id,
      }, 'attestation refreshed');
      return reply.status(201).send(toPublicAttestation(record));
    } catch (err) {
      if (err instanceof AttestationError) return sendRefusal(request, reply, err);
      throw err;
    }
  });
}

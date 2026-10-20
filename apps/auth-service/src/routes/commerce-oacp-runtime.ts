// SPDX-License-Identifier: Apache-2.0
/**
 * OACP artifact authority routes, under /v1/commerce.
 *
 * Authentication: the commerce caller resolver. The artifact routes accept
 *   - the AgenticOrg authority service token (COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN
 *     or its SHA-256), for a tenant listed in COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS;
 *   - an operator whose commerce tenant is the artifact's tenant;
 *   - the platform admin, for any tenant.
 * The issuer-key routes accept the platform admin only.
 *
 *   POST /oacp/c6z/authority-requests          issue (or refuse) the C6Z artifact set
 *   GET  /oacp/artifacts/:artifactId           one artifact: {envelope, payload, status, ...}
 *   GET  /oacp/artifacts?tenant_id&...         replay: {artifacts, next_cursor}
 *   POST /oacp/artifacts/:artifactId/revoke    revoke and issue a revocation artifact
 *   GET  /oacp/ucp-profile?tenant_id&...       UCP business-profile `ucp` member rendered
 *                                              from the scope's issued artifacts (G18)
 *   GET  /oacp/issuer-keys                     list issuer keys (no private material)
 *   POST /oacp/issuer-keys/rotate              new active key; the previous one retires
 *   POST /oacp/issuer-keys/:kid/revoke         withdraw a key from the JWKS
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  C6Z_AUTHORITY_SERVICE_SCOPE,
  OACP_ARTIFACTS_READ_SCOPE,
  OACP_ARTIFACTS_REVOKE_SCOPE,
  OACP_UCP_PROFILE_READ_SCOPE,
  type CommerceCaller,
} from '../lib/commerce/caller.js';
import {
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZSellerAuthorityRequest,
} from '../lib/commerce/oacp-runtime-vertical.js';
import {
  OacpArtifactStoreError,
  getOacpArtifact,
  issueAndPersistC6ZArtifacts,
  listLiveOacpArtifactsForScope,
  listOacpArtifacts,
  recordOacpRefusal,
  revokeOacpArtifact,
  type OacpArtifactRecord,
} from '../lib/commerce/oacp-artifact-store.js';
import {
  OacpIssuerKeyUnavailableError,
  listOacpIssuerKeys,
  revokeOacpIssuerKey,
  rotateOacpIssuerKey,
} from '../lib/commerce/oacp-issuer-keys.js';
import {
  UcpProfileInputError,
  isUcpProfileVersion,
  isUcpRenderableCapability,
  renderUcpBusinessProfile,
  type UcpRenderableCapability,
} from '../lib/commerce/ucp-profile.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getSql, queries } from '../db/client.js';

interface C6ZAuthorityBody {
  request?: C6ZSellerAuthorityRequest;
  connector_evidence?: C6ZConnectorEvidence;
  /** G43: redacted provider mandate-capability evidence; absent means `unverified`. */
  mandate_capability_evidence?: unknown;
  /** Ignored: artifacts are stamped with the issuer's own clock. */
  now_iso?: string;
}

function allowedServiceTenants(): Set<string> {
  return new Set(
    (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * May this caller act for `tenantId`? The service token only with the scope
 * and for an allow-listed tenant; an operator only for its own commerce
 * tenant; the platform admin for any.
 */
export function callerMayActForTenant(request: FastifyRequest, tenantId: string | null | undefined, scope: string): boolean {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (!caller) return false;
  if (caller.kind === 'operator') {
    if (caller.isPlatformAdmin) return true;
    return typeof tenantId === 'string' && tenantId.length > 0 && request.commerceTenantId === tenantId;
  }
  if (caller.kind === 'service') {
    return caller.scopes.includes(scope)
      && typeof tenantId === 'string' && tenantId.length > 0
      && allowedServiceTenants().has(tenantId);
  }
  return false;
}

export function requireKind(request: FastifyRequest): void {
  const kind = (request.commerceCaller as CommerceCaller | undefined)?.kind;
  if (kind !== 'operator' && kind !== 'service') {
    throw new CommerceHttpError(403, 'forbidden', 'Operator or authority service caller required');
  }
}

function requirePlatformAdmin(request: FastifyRequest): void {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (caller?.kind !== 'operator' || !caller.isPlatformAdmin) {
    throw new CommerceHttpError(403, 'platform_admin_required', 'Only the platform admin manages OACP issuer keys');
  }
}

function requireAuthorityCaller(request: FastifyRequest, body: C6ZAuthorityBody): void {
  requireKind(request);
  if (callerMayActForTenant(request, body.request?.tenant_id, C6Z_AUTHORITY_SERVICE_SCOPE)) return;
  if ((request.commerceCaller as CommerceCaller).kind === 'service') {
    throw new CommerceHttpError(
      403,
      'service_tenant_not_allowed',
      'AgenticOrg C6Z authority service token is not allowed for this tenant',
      { retryable: false },
    );
  }
  throw new CommerceHttpError(403, 'tenant_not_allowed',
    'Operators issue OACP artifacts for their own commerce tenant only', { retryable: false });
}

/** The stored view of an artifact: `{envelope, payload, status}` and its bookkeeping. */
function view(record: OacpArtifactRecord): Record<string, unknown> {
  return {
    artifact_id: record.artifact_id,
    family: record.family,
    artifact_type: record.artifact_type,
    tenant_id: record.tenant_id,
    merchant_id: record.merchant_id,
    seller_agent_id: record.seller_agent_id,
    envelope: record.envelope,
    payload: record.payload,
    status: record.status,
    status_list: record.status_list,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    refusal_code: record.refusal_code,
    revoked_at: record.revoked_at,
    revocation_reason: record.revocation_reason,
    revocation_artifact_id: record.revocation_artifact_id,
    created_at: record.created_at,
  };
}

function encodeCursor(next: { since: string; after_artifact_id: string } | null): string | null {
  return next ? Buffer.from(`${next.since}|${next.after_artifact_id}`, 'utf8').toString('base64url') : null;
}

function decodeCursor(cursor: string): { since: string; after_artifact_id: string } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = text.indexOf('|');
  if (split <= 0) return null;
  const since = text.slice(0, split);
  const after = text.slice(split + 1);
  if (Number.isNaN(Date.parse(since)) || !/^oacp_(art|ref)_[0-9A-Z]{26}$/.test(after)) return null;
  return { since, after_artifact_id: after };
}

function invalid(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
    details: { fields: { [field]: message } },
    retryable: false,
  });
}

function commaList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function rethrowKeyUnavailable(err: unknown): never {
  if (err instanceof OacpIssuerKeyUnavailableError) {
    throw new CommerceHttpError(503, 'oacp_issuer_key_unavailable', err.message, { retryable: false });
  }
  throw err;
}

export async function commerceOacpRuntimeRoutes(app: FastifyInstance) {
  app.post<{ Body: C6ZAuthorityBody }>('/oacp/c6z/authority-requests', async (request, reply) => {
    const body = request.body ?? {};
    requireAuthorityCaller(request, body);
    const sql = getSql();
    const now = new Date().toISOString();
    const authorityRequest = body.request;
    const requestStatus = validateC6ZSellerAuthorityRequest(authorityRequest, now);
    if (!body.connector_evidence || requestStatus.status !== 'artifact_issuance_ready') {
      const intakeOnly = !body.connector_evidence && requestStatus.status === 'artifact_issuance_ready';
      // A refusal is recorded; a valid intake still waiting for evidence is not one.
      const refusalRecordId = intakeOnly
        ? undefined
        : await recordOacpRefusal(queries(sql), { request: authorityRequest, result: requestStatus });
      return reply.status(requestStatus.status === 'rejected' ? 422 : 202).send({
        ...requestStatus,
        status: intakeOnly ? 'received' : requestStatus.status,
        message: intakeOnly
          ? 'Authority request received. Connector evidence is required before internal C6Z artifact issuance.'
          : requestStatus.message,
        route_kind: 'grantex_internal_c6z_authority_request',
        artifact_issuance_attempted: false,
        ...(refusalRecordId ? { refusal_record_id: refusalRecordId } : {}),
      });
    }
    const issuance = await issueAndPersistC6ZArtifacts(sql, {
      request: authorityRequest as C6ZSellerAuthorityRequest,
      evidence: body.connector_evidence,
      mandate_capability_evidence: body.mandate_capability_evidence,
      now_iso: now,
    }).catch(rethrowKeyUnavailable);
    return reply.status(issuance.status === 'artifact_issuance_ready' ? 201 : 422).send({
      ...issuance,
      route_kind: 'grantex_internal_c6z_authority_request',
      artifact_issuance_attempted: true,
      artifact_count: issuance.artifacts.length,
    });
  });

  app.get<{ Params: { artifactId: string } }>('/oacp/artifacts/:artifactId', async (request, reply) => {
    requireKind(request);
    const record = await getOacpArtifact(getSql(), request.params.artifactId);
    // Another tenant's artifact answers exactly like a missing one.
    if (!record || !callerMayActForTenant(request, record.tenant_id, OACP_ARTIFACTS_READ_SCOPE)) {
      throw new CommerceHttpError(404, 'artifact_not_found', 'OACP artifact not found', { retryable: false });
    }
    return reply.status(200).send(view(record));
  });

  app.get<{
    Querystring: {
      tenant_id?: string;
      merchant_id?: string;
      seller_agent_id?: string;
      since?: string;
      cursor?: string;
      limit?: string;
    };
  }>('/oacp/artifacts', async (request, reply) => {
    requireKind(request);
    const q = request.query;
    if (typeof q.tenant_id !== 'string' || q.tenant_id.length === 0) throw invalid('tenant_id', 'required');
    if (!callerMayActForTenant(request, q.tenant_id, OACP_ARTIFACTS_READ_SCOPE)) {
      throw new CommerceHttpError(403, 'tenant_not_allowed', 'Caller may not read OACP artifacts for this tenant', { retryable: false });
    }
    let since: string | null = null;
    let after: string | null = null;
    if (typeof q.cursor === 'string' && q.cursor.length > 0) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) throw invalid('cursor', 'must be a next_cursor returned by a previous page');
      since = decoded.since;
      after = decoded.after_artifact_id;
    } else if (typeof q.since === 'string' && q.since.length > 0) {
      if (Number.isNaN(Date.parse(q.since))) throw invalid('since', 'must be an RFC 3339 timestamp');
      since = new Date(q.since).toISOString();
    }
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid('limit', 'must be an integer from 1 to 500');
    const page = await listOacpArtifacts(getSql(), {
      tenant_id: q.tenant_id,
      merchant_id: q.merchant_id || null,
      seller_agent_id: q.seller_agent_id || null,
      since,
      after_artifact_id: after,
      limit,
    });
    return reply.status(200).send({ artifacts: page.artifacts.map(view), next_cursor: encodeCursor(page.next) });
  });

  app.post<{ Params: { artifactId: string }; Body: { reason_code?: string } | undefined }>(
    '/oacp/artifacts/:artifactId/revoke',
    async (request, reply) => {
      requireKind(request);
      const sql = getSql();
      const record = await getOacpArtifact(sql, request.params.artifactId);
      if (!record || !callerMayActForTenant(request, record.tenant_id, OACP_ARTIFACTS_REVOKE_SCOPE)) {
        throw new CommerceHttpError(404, 'artifact_not_found', 'OACP artifact not found', { retryable: false });
      }
      const reasonCode = request.body?.reason_code;
      if (reasonCode !== undefined && (typeof reasonCode !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(reasonCode))) {
        throw invalid('reason_code', 'must be a lower-case snake_case code of at most 64 characters');
      }
      let outcome: Awaited<ReturnType<typeof revokeOacpArtifact>>;
      try {
        outcome = await revokeOacpArtifact(sql, record.artifact_id, { reason_code: reasonCode });
      } catch (err) {
        if (err instanceof OacpArtifactStoreError) {
          throw new CommerceHttpError(err.code === 'artifact_not_found' ? 404 : 409, err.code, err.message, { retryable: false });
        }
        rethrowKeyUnavailable(err);
      }
      return reply.status(outcome.already_revoked ? 200 : 201).send({
        artifact_id: outcome.artifact.artifact_id,
        status: 'revoked',
        revoked_at: outcome.artifact.revoked_at,
        revocation_reason: outcome.artifact.revocation_reason,
        already_revoked: outcome.already_revoked,
        revocation_artifact: {
          artifact_id: outcome.revocation.artifact_id,
          envelope: outcome.revocation.envelope,
          payload: outcome.revocation.payload,
        },
      });
    },
  );

  app.get<{
    Querystring: {
      tenant_id?: string;
      merchant_id?: string;
      seller_agent_id?: string;
      version?: string;
      served?: string;
      rest_endpoint?: string;
      identity_linking_scopes?: string;
    };
  }>('/oacp/ucp-profile', async (request, reply) => {
    requireKind(request);
    const q = request.query;
    for (const field of ['tenant_id', 'merchant_id', 'seller_agent_id'] as const) {
      if (typeof q[field] !== 'string' || q[field]!.length === 0) throw invalid(field, 'required');
    }
    if (!callerMayActForTenant(request, q.tenant_id, OACP_UCP_PROFILE_READ_SCOPE)) {
      throw new CommerceHttpError(403, 'tenant_not_allowed', 'Caller may not render a UCP profile for this tenant', { retryable: false });
    }
    const version = q.version ?? '2026-04-08';
    if (!isUcpProfileVersion(version)) throw invalid('version', 'must be 2026-04-08 or 2026-08-25');
    const served = commaList(q.served);
    if (served.length === 0) throw invalid('served', 'list the dev.ucp.* capabilities the business host serves');
    const unknown = served.find((name) => !isUcpRenderableCapability(name));
    if (unknown !== undefined) throw invalid('served', `unknown capability ${unknown}`);
    const scopes = commaList(q.identity_linking_scopes);
    const now = new Date().toISOString();
    const artifacts = await listLiveOacpArtifactsForScope(getSql(), {
      tenant_id: q.tenant_id!,
      merchant_id: q.merchant_id!,
      seller_agent_id: q.seller_agent_id!,
    }, now);
    try {
      const rendered = renderUcpBusinessProfile({
        version,
        artifacts,
        served: served as UcpRenderableCapability[],
        rest_endpoint: q.rest_endpoint || undefined,
        identity_linking: scopes.length > 0 ? { scopes } : undefined,
        now_iso: now,
      });
      reply.header('cache-control', 'no-store');
      return reply.status(200).send(rendered);
    } catch (err) {
      if (err instanceof UcpProfileInputError) throw invalid(err.field, err.message);
      throw err;
    }
  });

  app.get('/oacp/issuer-keys', async (request, reply) => {
    requirePlatformAdmin(request);
    const keys = await listOacpIssuerKeys(getSql());
    return reply.status(200).send({
      keys: keys.map((key) => ({
        kid: key.kid,
        status: key.status,
        public_jwk: key.publicJwk,
        created_at: key.createdAt,
        retired_at: key.retiredAt,
        revoked_at: key.revokedAt,
      })),
    });
  });

  app.post('/oacp/issuer-keys/rotate', async (request, reply) => {
    requirePlatformAdmin(request);
    const rotated = await rotateOacpIssuerKey(getSql());
    return reply.status(201).send({
      kid: rotated.signer.kid,
      public_jwk: rotated.signer.publicJwk,
      retired_kid: rotated.retiredKid,
    });
  });

  app.post<{ Params: { kid: string } }>('/oacp/issuer-keys/:kid/revoke', async (request, reply) => {
    requirePlatformAdmin(request);
    const key = await revokeOacpIssuerKey(getSql(), request.params.kid);
    if (!key) throw new CommerceHttpError(404, 'issuer_key_not_found', 'OACP issuer key not found', { retryable: false });
    return reply.status(200).send({ kid: key.kid, status: key.status, revoked_at: key.revokedAt });
  });
}

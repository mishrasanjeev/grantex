/**
 * Approver identity providers for decision grants (PRD G-3), administered
 * with the service administrator credential (`ADMIN_API_KEY`), never with a
 * developer API key: a platform must not be able to add an identity provider
 * it controls and mint approvals for itself. Every change names the human
 * operator (`actor`) and is recorded in the developer's audit chain.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getSql } from '../db/client.js';
import { DecisionError } from '../lib/decisions/policy.js';
import { createApproverIdp, disableApproverIdp, listApproverIdps, type ApproverIdpRow } from '../lib/decisions/store.js';
import { validateOutboundUrl } from '../lib/url-security.js';
import { decisionGuard } from './decisions.js';

const DEVELOPER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACTOR_RE = /^[\x21-\x7e][\x20-\x7e]{0,254}$/;
const ACR_RE = /^[\x21-\x7e]{1,255}$/;

function checkAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminKey = config.adminApiKey;
  if (!adminKey) {
    void reply.status(503).send({ message: 'Admin API not configured', code: 'SERVICE_UNAVAILABLE', requestId: request.id });
    return false;
  }
  const expected = Buffer.from(`Bearer ${adminKey}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    void reply.status(401).send({ message: 'Unauthorized', code: 'UNAUTHORIZED', requestId: request.id });
    return false;
  }
  return true;
}

function view(row: ApproverIdpRow) {
  return {
    id: row.id,
    developerId: row.developer_id,
    issuer: row.issuer,
    clientId: row.client_id,
    confidentialClient: row.client_secret_encrypted !== null,
    acrValues: row.acr_values,
    requireVerifiedEmail: row.require_verified_email,
    displayName: row.display_name,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

export async function decisionAdminRoutes(app: FastifyInstance): Promise<void> {
  const base = '/v1/admin/developers/:developerId/decision-approver-idps';

  app.post<{ Params: { developerId: string } }>(base, { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!checkAdmin(request, reply)) return reply;
    if (!(await decisionGuard(request, reply))) return reply;
    const { developerId } = request.params;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const bad = (message: string) => reply.status(400).send({ message, code: 'BAD_REQUEST', requestId: request.id });
    if (!DEVELOPER_ID_RE.test(developerId)) return bad('developerId is malformed');
    const { issuer, clientId, clientSecret, acrValues, requireVerifiedEmail, displayName, actor } = body;
    if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) return bad('actor (the operator making this change) is required');
    if (typeof issuer !== 'string') return bad('issuer is required');
    try {
      const url = validateOutboundUrl(issuer, {
        allowedProtocols: ['https:', 'http:'],
        allowInsecureHttp: config.allowInsecureSsoUrls,
        allowPrivateHosts: config.allowPrivateSsoHosts,
      });
      if (url.search || url.hash) throw new Error('query');
    } catch {
      return bad('issuer must be an https URL without query or fragment');
    }
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 255) return bad('clientId is required');
    if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length === 0 || clientSecret.length > 1024)) {
      return bad('clientSecret must be a non-empty string');
    }
    if (acrValues !== undefined && (!Array.isArray(acrValues) || acrValues.length > 16 || !acrValues.every((v) => typeof v === 'string' && ACR_RE.test(v)))) {
      return bad('acrValues must be an array of acr values');
    }
    if (requireVerifiedEmail !== undefined && typeof requireVerifiedEmail !== 'boolean') return bad('requireVerifiedEmail must be a boolean');
    if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 128) return bad('displayName is required');
    try {
      const row = await createApproverIdp(getSql(), {
        developerId,
        issuer,
        clientId,
        ...(typeof clientSecret === 'string' ? { clientSecret } : {}),
        acrValues: (acrValues as string[] | undefined) ?? [],
        requireVerifiedEmail: requireVerifiedEmail === true,
        displayName,
        actor,
      });
      return reply.status(201).send({
        ...view(row),
        redirectUri: `${config.publicBaseUrl.replace(/\/$/, '')}/decisions/callback`,
      });
    } catch (err) {
      if (err instanceof DecisionError) return reply.status(err.status).send({ message: err.message, code: err.status === 404 ? 'NOT_FOUND' : 'CONFLICT', requestId: request.id });
      throw err;
    }
  });

  app.get<{ Params: { developerId: string } }>(base, { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!checkAdmin(request, reply)) return reply;
    if (!(await decisionGuard(request, reply))) return reply;
    const rows = await listApproverIdps(getSql(), request.params.developerId);
    return reply.send({ approverIdps: rows.map(view) });
  });

  app.post<{ Params: { developerId: string; idpId: string } }>(`${base}/:idpId/disable`, { config: { skipAuth: true, rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!checkAdmin(request, reply)) return reply;
    if (!(await decisionGuard(request, reply))) return reply;
    const actor = (request.body as Record<string, unknown> | undefined)?.['actor'];
    if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) {
      return reply.status(400).send({ message: 'actor (the operator making this change) is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const row = await disableApproverIdp(getSql(), request.params.developerId, request.params.idpId, actor);
    if (!row) return reply.status(404).send({ message: 'No active approver identity provider with this id', code: 'NOT_FOUND', requestId: request.id });
    return reply.send(view(row));
  });
}

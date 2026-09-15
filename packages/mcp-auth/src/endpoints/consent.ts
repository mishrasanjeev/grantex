import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import type { ConsentRecord } from '../types.js';
import { generateCode } from '../lib/codes.js';
import { ClientMetadataError, isClientIdMetadataUrl } from '../lib/client-metadata.js';
import { isLoopbackHost } from '../lib/resource.js';
import { consentPageHeaders, humanDuration, renderConsentPage, renderMessagePage, toolsForScopes } from '../consent/page.js';
import type { ConsentViewModel } from '../consent/page.js';
import { clientRedirect, startUpstreamAuthorization } from './authorize.js';
import type { ValidatedAuthorization } from './authorize.js';

/**
 * The consent step. `GET /authorize` renders the page for a validated
 * request and stores a single-use consent record; the page's form posts to
 * `POST /consent`. The submission must carry:
 *
 * - the consent id and an anti-CSRF token from the form (the record holds
 *   only the token's hash), and
 * - the browser-binding cookie set with the page (again stored as a hash),
 *
 * and, when the browser sends them, `Sec-Fetch-Site: same-origin` and an
 * `Origin` equal to the issuer's. The record is taken atomically before any
 * check, so a page can be submitted once whatever the outcome. Only after an
 * approval does anything reach Grantex.
 */

export const CONSENT_PATH = '/consent';
const DEFAULT_EXPIRY_SECONDS = 600;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function hashesMatch(expectedHash: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 256) return false;
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(sha256(presented));
  return a.length === b.length && timingSafeEqual(a, b);
}

function secureCookies(ctx: ServerContext): boolean {
  return new URL(ctx.issuer).protocol === 'https:';
}

/** One cookie per consent, so two tabs do not overwrite each other's binding. */
function cookieName(ctx: ServerContext, consentId: string): string {
  const base = `mcp_auth_consent_${sha256(consentId).slice(0, 16)}`;
  // `__Host-` pins the cookie to this exact host, https and path `/`.
  return secureCookies(ctx) ? `__Host-${base}` : base;
}

function cookieHeader(ctx: ServerContext, name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
    ...(secureCookies(ctx) ? ['Secure'] : []),
  ].join('; ');
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function sendMessage(ctx: ServerContext, reply: FastifyReply, status: number, title: string, message: string): FastifyReply {
  const page = renderMessagePage(ctx.consentPage, title, message);
  return reply.status(status).headers(page.headers).send(page.body);
}

export async function renderConsent(ctx: ServerContext, reply: FastifyReply, request: ValidatedAuthorization): Promise<FastifyReply> {
  const { config } = ctx;
  const consentId = generateCode();
  const csrfToken = generateCode();
  const browserBinding = generateCode();
  const expiresInSeconds = config.consentPage?.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  const now = Date.now();

  const record: ConsentRecord = {
    clientId: request.client.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: request.scopes,
    resource: request.resource,
    ...(request.clientState !== undefined ? { clientState: request.clientState } : {}),
    csrfTokenHash: sha256(csrfToken),
    browserBindingHash: sha256(browserBinding),
    createdAt: now,
    expiresAt: now + expiresInSeconds * 1000,
  };
  await ctx.storage.putConsent(consentId, record);

  const redirect = new URL(request.redirectUri);
  const grant = config.grant ?? {};
  const duration = humanDuration(grant.duration);
  const model: ConsentViewModel = {
    appName: config.consentUi?.appName ?? 'MCP authorization',
    ...(config.consentUi?.appLogo !== undefined ? { logoUrl: config.consentUi.appLogo } : {}),
    ...(config.consentUi?.privacyUrl !== undefined ? { privacyUrl: config.consentUi.privacyUrl } : {}),
    ...(config.consentUi?.termsUrl !== undefined ? { termsUrl: config.consentUi.termsUrl } : {}),
    client: {
      id: request.client.clientId,
      name: request.client.clientName ?? request.client.clientId,
      metadataDocument: isClientIdMetadataUrl(request.client.clientId),
    },
    redirect: {
      uri: request.redirectUri,
      host: redirect.host,
      loopbackOnly: request.client.redirectUris.every((uri) => {
        try {
          return isLoopbackHost(new URL(uri).hostname);
        } catch {
          return false;
        }
      }),
    },
    resource: { uri: request.resource, ...(config.resourceName !== undefined ? { name: config.resourceName } : {}) },
    scopes: request.scopes,
    ...(grant.purpose !== undefined
      ? { purpose: { code: grant.purpose, ...(grant.purposeDescription !== undefined ? { description: grant.purposeDescription } : {}) } }
      : {}),
    ...(grant.dataRegion !== undefined ? { dataRegion: grant.dataRegion } : {}),
    ...(duration !== undefined ? { duration } : {}),
    tools: toolsForScopes(ctx.toolPolicy, request.scopes),
    consentId,
    csrfToken,
    formAction: `${ctx.issuer}${CONSENT_PATH}`,
  };

  const body = renderConsentPage(ctx.consentPage, model);
  return reply
    .status(200)
    .headers(consentPageHeaders(ctx.consentPage, model, new URL(ctx.issuer).origin))
    .header('set-cookie', cookieHeader(ctx, cookieName(ctx, consentId), browserBinding, expiresInSeconds))
    .send(body);
}

function parseForm(body: string): Record<string, string> | 'duplicate' {
  const params = new URLSearchParams(body);
  const form: Record<string, string> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) return 'duplicate';
    form[key] = values[0]!;
  }
  return form;
}

export function registerConsentEndpoint(app: FastifyInstance, ctx: ServerContext): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_request, body, done) => {
    done(null, parseForm(body as string));
  });

  const issuerOrigin = new URL(ctx.issuer).origin;

  app.post<{ Body: Record<string, string> | 'duplicate' | undefined }>(
    CONSENT_PATH,
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // Cross-site submissions are refused before the record is touched, so a
      // forged post cannot even spend a victim's consent.
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin') {
        return sendMessage(ctx, reply, 403, 'Request refused', 'The consent form must be submitted from this site.');
      }
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== 'null' && origin !== issuerOrigin) {
        return sendMessage(ctx, reply, 403, 'Request refused', 'The consent form must be submitted from this site.');
      }

      const form = request.body;
      if (form === undefined || form === 'duplicate' || typeof form !== 'object') {
        return sendMessage(ctx, reply, 400, 'Request refused', 'The consent form was incomplete.');
      }
      const { consent_id: consentId, csrf_token: csrfToken, decision } = form;
      if (typeof consentId !== 'string' || consentId.length === 0 || consentId.length > 256 || (decision !== 'approve' && decision !== 'deny')) {
        return sendMessage(ctx, reply, 400, 'Request refused', 'The consent form was incomplete.');
      }

      const record = await ctx.storage.takeConsent(consentId);
      // Clear this consent's cookie whatever happens next.
      const name = cookieName(ctx, consentId);
      reply.header('set-cookie', cookieHeader(ctx, name, '', 0));
      if (!record) {
        return sendMessage(ctx, reply, 400, 'This request has expired', 'Return to the application and start again.');
      }
      if (!hashesMatch(record.csrfTokenHash, csrfToken) || !hashesMatch(record.browserBindingHash, readCookie(request, name))) {
        return sendMessage(ctx, reply, 403, 'Request refused', 'This consent form could not be verified. Return to the application and start again.');
      }

      if (decision === 'deny') {
        return reply.redirect(clientRedirect(ctx, record.redirectUri, { error: 'access_denied', state: record.clientState }), 303);
      }

      let client;
      try {
        client = await ctx.getClient(record.clientId);
      } catch (err) {
        if (!(err instanceof ClientMetadataError)) throw err;
        client = undefined;
      }
      // The client may have been deleted, or its metadata document changed,
      // since the page was rendered: re-check before going upstream.
      if (!client || !client.redirectUris.includes(record.redirectUri) || record.resource === undefined) {
        return sendMessage(ctx, reply, 400, 'Request refused', 'The application is no longer registered for this request.');
      }

      return startUpstreamAuthorization(ctx, reply, {
        client,
        redirectUri: record.redirectUri,
        codeChallenge: record.codeChallenge,
        scopes: record.scopes,
        resource: record.resource,
        ...(record.clientState !== undefined ? { clientState: record.clientState } : {}),
      }, 303);
    },
  );
}

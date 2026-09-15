import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ClientRegistration, McpAuthConfig, PendingAuthorization } from '../types.js';
import type { ServerContext } from '../context.js';
import { generateCode } from '../lib/codes.js';
import { ClientMetadataError } from '../lib/client-metadata.js';
import { resolveRequestedResource } from '../lib/resource.js';

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export const DEFAULT_CALLBACK_PATH = '/callback';

const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function resolveCallbackUrl(config: McpAuthConfig): string {
  if (config.callbackUrl) return config.callbackUrl;
  const issuer = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;
  return `${issuer}${config.callbackPath ?? DEFAULT_CALLBACK_PATH}`;
}

/** An authorization request that passed every check and may be shown to the Principal. */
export interface ValidatedAuthorization {
  client: ClientRegistration;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  clientState?: string;
}

export type AuthorizationValidation =
  | { ok: true; request: ValidatedAuthorization }
  | { ok: false; status: number; body: { error: string; error_description: string } };

function single(value: unknown): string | undefined | 'repeated' {
  if (Array.isArray(value)) return 'repeated';
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validates an authorization request. Errors are returned to the user-agent
 * as 400 responses and never redirected: until the client and redirect URI
 * are verified, redirecting would be an open redirect.
 */
export async function validateAuthorizationRequest(
  ctx: ServerContext,
  query: Record<string, unknown>,
): Promise<AuthorizationValidation> {
  const fail = (status: number, error: string, error_description: string): AuthorizationValidation => ({
    ok: false,
    status,
    body: { error, error_description },
  });

  const params: Record<string, string | undefined> = {};
  for (const name of ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state']) {
    const value = single(query[name]);
    if (value === 'repeated') return fail(400, 'invalid_request', `${name} must not be repeated`);
    params[name] = value;
  }

  if (params['response_type'] !== 'code') {
    return fail(400, 'unsupported_response_type', 'Only response_type=code is supported');
  }

  // PKCE is mandatory and S256 is the only method (OAuth 2.1 §4.1.1; `plain`
  // is refused, as is an omitted method, which would default to `plain`).
  const challenge = params['code_challenge'];
  const method = params['code_challenge_method'];
  if (!challenge || method !== 'S256') {
    return fail(
      400,
      'invalid_request',
      method !== undefined && method !== 'S256'
        ? `PKCE is required. Provide code_challenge with method S256; code_challenge_method "${method}" is not supported.`
        : 'PKCE is required. Provide code_challenge with method S256.',
    );
  }
  if (!PKCE_S256_CHALLENGE.test(challenge)) {
    return fail(400, 'invalid_request', 'code_challenge must be a base64url-encoded SHA-256 digest (43 characters)');
  }

  const clientId = params['client_id'];
  if (!clientId) return fail(400, 'invalid_client', 'Unknown client_id');
  let client: ClientRegistration | undefined;
  try {
    client = await ctx.getClient(clientId);
  } catch (err) {
    if (err instanceof ClientMetadataError) {
      return fail(400, 'invalid_client', `Client metadata document rejected (${err.reason}): ${err.message}`);
    }
    throw err;
  }
  if (!client) return fail(400, 'invalid_client', 'Unknown client_id');

  // Exact match against registered (or metadata-document) redirect URIs.
  const redirectUri = params['redirect_uri'];
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return fail(400, 'invalid_request', 'redirect_uri not registered for this client');
  }

  const resolution = resolveRequestedResource(query['resource'], ctx.resources);
  if (!resolution.ok) return fail(400, 'invalid_target', resolution.description);

  const scopeParam = params['scope'];
  let scopes: string[];
  if (scopeParam === undefined || scopeParam.trim() === '') {
    scopes = [...ctx.scopesSupported];
  } else {
    scopes = [...new Set(scopeParam.split(' ').filter((s) => s.length > 0))];
    const malformed = scopes.find((s) => !SCOPE_TOKEN.test(s));
    if (malformed !== undefined) return fail(400, 'invalid_scope', 'scope contains an invalid character');
    const unsupported = scopes.filter((s) => !ctx.scopesSupported.includes(s));
    if (unsupported.length > 0) {
      return fail(400, 'invalid_scope', `Unsupported scope: ${unsupported.join(' ')}`);
    }
  }

  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge: challenge,
      scopes,
      resource: resolution.resource,
      ...(params['state'] !== undefined ? { clientState: params['state'] } : {}),
    },
  };
}

/** Appends RFC 9207 `iss` (and the client's state) to a client redirect. */
function clientRedirect(ctx: ServerContext, redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, value);
  }
  url.searchParams.set('iss', ctx.issuer);
  return url.toString();
}

interface IssueCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  clientState?: string;
  grantexAuthRequestId: string;
  grantexCode: string;
}

/**
 * Issues the client-facing authorization code and redirects the user-agent
 * back to the client. Only called once the Grantex authorization request has
 * been approved (consent callback, or gated sandbox auto-approval).
 */
async function issueCodeAndRedirect(ctx: ServerContext, reply: FastifyReply, input: IssueCodeInput): Promise<FastifyReply> {
  const code = generateCode();
  const codeExpiration = ctx.config.codeExpirationSeconds ?? 600;
  await ctx.storage.putAuthorizationCode(code, {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: input.scopes,
    resource: input.resource,
    grantexAuthRequestId: input.grantexAuthRequestId,
    grantexCode: input.grantexCode,
    expiresAt: Date.now() + codeExpiration * 1000,
  });
  return reply.redirect(clientRedirect(ctx, input.redirectUri, { code, state: input.clientState }));
}

/**
 * Starts the upstream Grantex authorization for a validated request: the
 * Principal approves it in Grantex, which redirects back to the callback.
 * The requested resource becomes the grant token's audience.
 */
export async function startUpstreamAuthorization(
  ctx: ServerContext,
  reply: FastifyReply,
  request: ValidatedAuthorization,
): Promise<FastifyReply> {
  const { config } = ctx;
  const pendingId = generateCode();
  const codeExpiration = config.codeExpirationSeconds ?? 600;
  let grantexAuth;
  try {
    grantexAuth = await config.grantex.authorize({
      agentId: config.agentId,
      userId: request.client.clientId, // Use client_id as principal for MCP flow
      scopes: request.scopes,
      audience: request.resource,
      redirectUri: resolveCallbackUrl(config),
      state: pendingId,
    });
  } catch (err) {
    return reply.status(502).send({
      error: 'server_error',
      error_description: `Grantex authorization failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const inlineCode = typeof grantexAuth.code === 'string' && grantexAuth.code.length > 0
    ? grantexAuth.code
    : undefined;

  if (inlineCode !== undefined) {
    // Grantex auto-approved the request (sandbox developer key). Only take
    // the consent-free short path when the operator opted in explicitly.
    if (config.sandboxAutoApprove !== true) {
      return reply.status(502).send({
        error: 'server_error',
        error_description:
          'Grantex auto-approved the authorization request without Principal consent. '
          + 'Set sandboxAutoApprove: true to allow this in sandbox mode.',
      });
    }
    return issueCodeAndRedirect(ctx, reply, {
      clientId: request.client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scopes: request.scopes,
      resource: request.resource,
      ...(request.clientState !== undefined ? { clientState: request.clientState } : {}),
      grantexAuthRequestId: grantexAuth.authRequestId,
      grantexCode: inlineCode,
    });
  }

  const pending: PendingAuthorization = {
    clientId: request.client.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: request.scopes,
    resource: request.resource,
    ...(request.clientState !== undefined ? { clientState: request.clientState } : {}),
    grantexAuthRequestId: grantexAuth.authRequestId,
    expiresAt: Date.now() + codeExpiration * 1000,
  };
  await ctx.storage.putPendingAuthorization(pendingId, pending);

  return reply.redirect(grantexAuth.consentUrl);
}

export function registerAuthorizeEndpoint(app: FastifyInstance, ctx: ServerContext): void {
  const { config } = ctx;

  app.get<{ Querystring: Record<string, unknown> }>('/authorize', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const validation = await validateAuthorizationRequest(ctx, request.query);
    if (!validation.ok) return reply.status(validation.status).send(validation.body);
    return startUpstreamAuthorization(ctx, reply, validation.request);
  });

  // Consent callback: Grantex redirects here with `code` + `state` once the
  // Principal approves (or `error=access_denied` on denial).
  app.get<{ Querystring: CallbackQuery }>(config.callbackPath ?? DEFAULT_CALLBACK_PATH, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { code, state, error } = request.query;

    if (typeof state !== 'string' || state.length === 0) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'state is required',
      });
    }

    // Atomic take: a replayed (or concurrent) callback must not mint a second code.
    const pending = await ctx.storage.takePendingAuthorization(state);
    if (!pending) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'Unknown or expired authorization request',
      });
    }

    if (error || typeof code !== 'string' || code.length === 0) {
      // Only a fixed error code is forwarded; upstream text is not reflected.
      return reply.redirect(clientRedirect(ctx, pending.redirectUri, {
        error: error === 'access_denied' || !error ? 'access_denied' : 'server_error',
        state: pending.clientState,
      }));
    }

    if (pending.resource === undefined) {
      // Records written before resources were mandatory cannot be bound to
      // an audience; refuse rather than issue an unbound token.
      return reply.redirect(clientRedirect(ctx, pending.redirectUri, { error: 'invalid_target', state: pending.clientState }));
    }

    return issueCodeAndRedirect(ctx, reply, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      grantexAuthRequestId: pending.grantexAuthRequestId,
      grantexCode: code,
    });
  });
}

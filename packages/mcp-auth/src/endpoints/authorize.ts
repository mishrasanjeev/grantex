import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  McpAuthConfig,
  ClientStore,
  CodeStore,
  PendingAuthorizationStore,
  PendingAuthorization,
} from '../types.js';
import { generateCode } from '../lib/codes.js';

interface AuthorizeQuery {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
  resource?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export const DEFAULT_CALLBACK_PATH = '/callback';

export function resolveCallbackUrl(config: McpAuthConfig): string {
  if (config.callbackUrl) return config.callbackUrl;
  const issuer = config.issuer.endsWith('/') ? config.issuer.slice(0, -1) : config.issuer;
  return `${issuer}${config.callbackPath ?? DEFAULT_CALLBACK_PATH}`;
}

interface IssueCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  clientState?: string;
  grantexAuthRequestId: string;
  grantexCode: string;
}

/**
 * Issues the client-facing authorization code and redirects the user-agent
 * back to the client. Only called once the Grantex authorization request has
 * been approved (consent callback, or gated sandbox auto-approval).
 */
async function issueCodeAndRedirect(
  reply: FastifyReply,
  config: McpAuthConfig,
  codeStore: CodeStore,
  input: IssueCodeInput,
): Promise<FastifyReply> {
  const code = generateCode();
  const codeExpiration = config.codeExpirationSeconds ?? 600;
  await codeStore.set(code, {
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: input.scopes,
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    grantexAuthRequestId: input.grantexAuthRequestId,
    grantexCode: input.grantexCode,
    expiresAt: Date.now() + codeExpiration * 1000,
  });

  const redirectUrl = new URL(input.redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (input.clientState) redirectUrl.searchParams.set('state', input.clientState);
  return reply.redirect(redirectUrl.toString());
}

export function registerAuthorizeEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  clientStore: ClientStore,
  codeStore: CodeStore,
  pendingStore: PendingAuthorizationStore,
): void {
  app.get<{ Querystring: AuthorizeQuery }>('/authorize', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
      resource,
    } = request.query;

    // Validate response_type
    if (response_type !== 'code') {
      return reply.status(400).send({
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported',
      });
    }

    // Validate PKCE (mandatory)
    if (!code_challenge || code_challenge_method !== 'S256') {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'PKCE is required. Provide code_challenge with method S256.',
      });
    }

    // Validate client
    const client = await clientStore.get(client_id);
    if (!client) {
      return reply.status(400).send({
        error: 'invalid_client',
        error_description: 'Unknown client_id',
      });
    }

    // Validate redirect_uri
    if (!client.redirectUris.includes(redirect_uri)) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri not registered for this client',
      });
    }

    // Validate resource indicator
    if (resource && config.allowedResources && config.allowedResources.length > 0) {
      if (!config.allowedResources.includes(resource)) {
        return reply.status(400).send({
          error: 'invalid_target',
          error_description: 'Resource not in allow-list',
        });
      }
    }

    // Create Grantex auth request. The Principal must approve it in the
    // Grantex consent flow before any code is issued to the client; Grantex
    // redirects back to our callback with the one-time exchange code.
    const scopes = scope ? scope.split(' ') : config.scopes;
    const pendingId = generateCode();
    const codeExpiration = config.codeExpirationSeconds ?? 600;
    let grantexAuth;
    try {
      grantexAuth = await config.grantex.authorize({
        agentId: config.agentId,
        userId: client_id, // Use client_id as principal for MCP flow
        scopes,
        ...(resource !== undefined ? { audience: resource } : {}),
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
      return issueCodeAndRedirect(reply, config, codeStore, {
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        scopes,
        ...(resource !== undefined ? { resource } : {}),
        ...(state !== undefined ? { clientState: state } : {}),
        grantexAuthRequestId: grantexAuth.authRequestId,
        grantexCode: inlineCode,
      });
    }

    const pending: PendingAuthorization = {
      id: pendingId,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: 'S256',
      scopes,
      ...(resource !== undefined ? { resource } : {}),
      ...(state !== undefined ? { clientState: state } : {}),
      grantexAuthRequestId: grantexAuth.authRequestId,
      expiresAt: Date.now() + codeExpiration * 1000,
    };
    await pendingStore.set(pendingId, pending);

    return reply.redirect(grantexAuth.consentUrl);
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

    const pending = await pendingStore.get(state);
    if (!pending) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'Unknown or expired authorization request',
      });
    }
    // Single use — a replayed callback must not mint a second code.
    await pendingStore.delete(state);

    if (error || typeof code !== 'string' || code.length === 0) {
      const redirectUrl = new URL(pending.redirectUri);
      redirectUrl.searchParams.set('error', error && error !== '' ? error : 'access_denied');
      if (pending.clientState) redirectUrl.searchParams.set('state', pending.clientState);
      return reply.redirect(redirectUrl.toString());
    }

    return issueCodeAndRedirect(reply, config, codeStore, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      ...(pending.resource !== undefined ? { resource: pending.resource } : {}),
      ...(pending.clientState !== undefined ? { clientState: pending.clientState } : {}),
      grantexAuthRequestId: pending.grantexAuthRequestId,
      grantexCode: code,
    });
  });
}

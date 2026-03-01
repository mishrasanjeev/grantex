import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig, ClientStore, CodeStore } from '../types.js';
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

export function registerAuthorizeEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  clientStore: ClientStore,
  codeStore: CodeStore,
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

    // Create Grantex auth request
    const scopes = scope ? scope.split(' ') : config.scopes;
    let grantexAuth;
    try {
      grantexAuth = await config.grantex.authorize({
        agentId: config.agentId,
        userId: client_id, // Use client_id as principal for MCP flow
        scopes,
      });
    } catch (err) {
      return reply.status(502).send({
        error: 'server_error',
        error_description: `Grantex authorization failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Generate authorization code and store
    const code = generateCode();
    const codeExpiration = config.codeExpirationSeconds ?? 600;
    await codeStore.set(code, {
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: 'S256',
      scopes,
      ...(resource !== undefined ? { resource } : {}),
      grantexAuthRequestId: grantexAuth.authRequestId,
      expiresAt: Date.now() + codeExpiration * 1000,
    });

    // Redirect to client with authorization code
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    return reply.redirect(redirectUrl.toString());
  });
}

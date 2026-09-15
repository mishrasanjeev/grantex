import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig } from '../types.js';
import type { McpAuthStorage } from '../storage/types.js';
import { verifyCodeChallenge } from '../lib/pkce.js';
import { isConfidentialClient, parseBasicAuth, secretMatches } from '../lib/verify.js';
import type { ClientRegistration } from '../types.js';

/**
 * OAuth 2.1 §2.1: a confidential client MUST authenticate at the token
 * endpoint. Public clients (no registered secret) rely on PKCE alone.
 * Returns true when the request is authenticated for `client`.
 */
function clientAuthenticated(
  client: ClientRegistration,
  authorizationHeader: string | undefined,
  body: TokenBody,
): boolean {
  if (!isConfidentialClient(client)) return true;
  const basic = parseBasicAuth(authorizationHeader);
  if (basic) {
    const [basicId, basicSecret] = basic;
    return basicId === client.clientId && secretMatches(client.clientSecretHash, basicSecret);
  }
  return secretMatches(client.clientSecretHash, body.client_secret);
}

/**
 * How long a refresh-token→client binding is remembered. Grantex does not
 * report a refresh token's own lifetime, so this only bounds store growth;
 * an expired binding makes the token unusable here, never more permissive.
 */
const REFRESH_TOKEN_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenBody {
  grant_type: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
}

export function registerTokenEndpoint(
  app: FastifyInstance,
  config: McpAuthConfig,
  storage: McpAuthStorage,
): void {
  // A refresh token is bound to the client it was issued to (RFC 6749 §6,
  // OAuth 2.1 §4.3.1). Recording the binding on every issue path, and
  // re-recording it after rotation, is what lets the refresh_token grant
  // refuse a token presented by a different client_id.
  async function bindRefreshToken(
    refreshToken: string | undefined,
    clientId: string,
    resource: string | undefined,
  ): Promise<void> {
    if (refreshToken === undefined) return;
    await storage.putRefreshTokenBinding(refreshToken, {
      clientId,
      ...(resource !== undefined ? { resource } : {}),
      expiresAt: Date.now() + REFRESH_TOKEN_BINDING_TTL_MS,
    });
  }

  app.post<{ Body: TokenBody }>('/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = request.body ?? ({} as TokenBody);
    const { grant_type, code, redirect_uri, code_verifier, refresh_token } = body;
    // client_id may arrive in the body or (for confidential clients) via Basic auth.
    const basicCreds = parseBasicAuth(request.headers.authorization);
    const client_id = body.client_id ?? basicCreds?.[0];

    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'code, redirect_uri, client_id, and code_verifier are required',
        });
      }

      // Validate client
      const client = await storage.getClient(client_id);
      if (!client) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id',
        });
      }
      if (!clientAuthenticated(client, request.headers.authorization, body)) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        });
      }

      // Consume the code atomically before any other check: it is single
      // use, so of any number of concurrent requests at most one gets it,
      // and a failed attempt (wrong client, redirect_uri or verifier) still
      // spends it.
      const authCode = await storage.consumeAuthorizationCode(code);
      if (!authCode) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
        });
      }

      // Verify code belongs to client
      if (authCode.clientId !== client_id) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Code was not issued to this client',
        });
      }

      // Verify redirect_uri
      if (authCode.redirectUri !== redirect_uri) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'redirect_uri mismatch',
        });
      }

      // Verify PKCE
      if (!verifyCodeChallenge(code_verifier, authCode.codeChallenge)) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'PKCE verification failed',
        });
      }

      // Exchange with Grantex (use the stored auth code from Grantex)
      let tokenResponse;
      try {
        tokenResponse = await config.grantex.tokens.exchange({
          code: authCode.grantexCode ?? authCode.grantexAuthRequestId,
          agentId: config.agentId,
        });
      } catch (err) {
        return reply.status(502).send({
          error: 'server_error',
          error_description: `Grantex token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      await bindRefreshToken(tokenResponse.refreshToken, client_id, authCode.resource);

      return reply.send({
        access_token: tokenResponse.grantToken,
        token_type: 'bearer',
        expires_in: Math.floor(
          (new Date(tokenResponse.expiresAt).getTime() - Date.now()) / 1000,
        ),
        scope: tokenResponse.scopes.join(' '),
        ...(tokenResponse.refreshToken !== undefined
          ? { refresh_token: tokenResponse.refreshToken }
          : {}),
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token || !client_id) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'refresh_token and client_id are required',
        });
      }

      const client = await storage.getClient(client_id);
      if (!client) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id',
        });
      }

      if (!clientAuthenticated(client, request.headers.authorization, body)) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        });
      }

      if (!client.grantTypes.includes('refresh_token')) {
        return reply.status(400).send({
          error: 'unauthorized_client',
          error_description: 'Client is not authorized for refresh_token grant type',
        });
      }

      // Taken atomically before touching Grantex, and only when bound to
      // the authenticated client record (not the raw client_id parameter):
      // a token presented by the wrong client is neither rotated nor
      // consumed, an unknown token is refused, and two concurrent refreshes
      // of one token cannot both proceed.
      const binding = await storage.takeRefreshTokenBinding(refresh_token, client.clientId);
      if (!binding) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Refresh token was not issued to this client',
        });
      }

      let tokenResponse;
      try {
        tokenResponse = await config.grantex.tokens.refresh({
          refreshToken: refresh_token,
          agentId: config.agentId,
        });
      } catch (err) {
        // Nothing was issued, so restore the binding: a transient upstream
        // failure must not strand a refresh token the client still holds.
        // Grantex remains the authority on whether the token is still valid.
        await storage.putRefreshTokenBinding(refresh_token, binding);
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Rotation: the old binding is already spent; the new token inherits it.
      await bindRefreshToken(tokenResponse.refreshToken, client.clientId, binding.resource);

      return reply.send({
        access_token: tokenResponse.grantToken,
        token_type: 'bearer',
        expires_in: Math.floor(
          (new Date(tokenResponse.expiresAt).getTime() - Date.now()) / 1000,
        ),
        scope: tokenResponse.scopes.join(' '),
        ...(tokenResponse.refreshToken !== undefined
          ? { refresh_token: tokenResponse.refreshToken }
          : {}),
      });
    }

    return reply.status(400).send({
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token grant types are supported',
    });
  });
}

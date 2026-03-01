import type { FastifyInstance } from 'fastify';
import type { McpAuthConfig, ClientStore, CodeStore } from '../types.js';
import { verifyCodeChallenge } from '../lib/pkce.js';

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
  clientStore: ClientStore,
  codeStore: CodeStore,
): void {
  app.post<{ Body: TokenBody }>('/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier, refresh_token } = request.body ?? {};

    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'code, redirect_uri, client_id, and code_verifier are required',
        });
      }

      // Validate client
      const client = await clientStore.get(client_id);
      if (!client) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id',
        });
      }

      // Look up authorization code
      const authCode = await codeStore.get(code);
      if (!authCode) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Invalid or expired authorization code',
        });
      }

      // Delete code immediately (single-use)
      await codeStore.delete(code);

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

      const client = await clientStore.get(client_id);
      if (!client) {
        return reply.status(401).send({
          error: 'invalid_client',
          error_description: 'Unknown client_id',
        });
      }

      if (!client.grantTypes.includes('refresh_token')) {
        return reply.status(400).send({
          error: 'unauthorized_client',
          error_description: 'Client is not authorized for refresh_token grant type',
        });
      }

      let tokenResponse;
      try {
        tokenResponse = await config.grantex.tokens.refresh({
          refreshToken: refresh_token,
          agentId: config.agentId,
        });
      } catch (err) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

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

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { Grantex, verifyGrantToken, GrantexTokenError } from '@grantex/sdk';
import type { GatewayConfig } from './types.js';
import { matchRoute, isSafeRequestPath } from './matcher.js';
import { proxyRequest } from './proxy.js';
import { GatewayError } from './errors.js';
import { log } from './logger.js';
import { audienceDenial, checkAudienceCheck, checkExpectedAudience, readTokenAudience } from './audience.js';
import { checkDataRegionCheck, checkExpectedDataRegion, readTokenDataRegions, regionDenial } from './region.js';
import { checkCredentialReference, readCredentialRef, resolveCredentialReference } from './credentials.js';

export function createGatewayServer(config: GatewayConfig): FastifyInstance {
  // Checked here as well as in validateConfig, for a config built in code: an
  // invalid audience setting must stop the gateway, not be read as "no audience".
  const audienceCheck = checkAudienceCheck(config.audienceCheck === undefined ? 'on' : config.audienceCheck);
  const audience = checkExpectedAudience(config.audience, audienceCheck);
  for (const route of config.routes) checkExpectedAudience(route.audience, audienceCheck);
  const dataRegionCheck = checkDataRegionCheck(config.dataRegionCheck === undefined ? 'off' : config.dataRegionCheck);
  const dataRegion = checkExpectedDataRegion(config.dataRegion, dataRegionCheck);
  for (const route of config.routes) checkExpectedDataRegion(route.dataRegion, dataRegionCheck);
  if (config.currentAuthorityCheck !== undefined && typeof config.currentAuthorityCheck !== 'boolean') {
    throw new Error('currentAuthorityCheck must be a boolean');
  }
  let currentAuthority = config.currentAuthority;
  if (config.currentAuthorityCheck === true && currentAuthority === undefined) {
    const apiKey = config.grantexApiKey ?? process.env['GRANTEX_API_KEY'];
    if (!apiKey) throw new Error('Current authority verification requires GRANTEX_API_KEY');
    const issuer = new Grantex({ apiKey, maxRetries: 0,
      ...(config.grantexBaseUrl !== undefined ? { baseUrl: config.grantexBaseUrl } : {}) });
    currentAuthority = (token) => issuer.grants.verify(token);
  }
  if (currentAuthority !== undefined && (typeof currentAuthority !== 'function' || audienceCheck !== 'on'
    || config.routes.some((route) => !(route.audience ?? audience)))) {
    throw new Error('Current authority verification requires a callback and an audience for every route, with audienceCheck on');
  }
  // Credentials by reference: the gateway redeems a presented reference with its
  // own key, so turning it on without the key or the auth service stops the gateway.
  const credentialReference = checkCredentialReference(config.credentialReference ?? 'off');
  const resolveOptions = credentialReference === 'on' && config.grantexApiKey && config.grantexBaseUrl
    ? { grantexApiKey: config.grantexApiKey, grantexBaseUrl: config.grantexBaseUrl }
    : undefined;
  if (credentialReference === 'on' && resolveOptions === undefined) {
    throw new Error('credentialReference: on needs grantexApiKey and grantexBaseUrl');
  }

  /**
   * Sends the audience denial for a verified grant token and returns true, or
   * returns false when the audience is accepted (or the check is off).
   */
  const denyByAudience = (
    token: string,
    routeAudience: string | undefined,
    method: string,
    path: string,
    grantId: string | undefined,
    reply: FastifyReply,
  ): boolean => {
    if (audienceCheck === 'off') return false;
    let tokenAudience: string[] | undefined;
    try {
      tokenAudience = readTokenAudience(token);
    } catch (err) {
      // Fail closed: a token whose audience cannot be read may be meant for
      // another relying party.
      const message = err instanceof Error ? err.message : 'grant token payload cannot be read';
      log('info', 'Request denied: grant token audience unreadable', { method, path, error: message, grantId });
      reply.status(401).send({ error: 'TOKEN_INVALID', message });
      return true;
    }
    const denial = audienceDenial(tokenAudience, routeAudience ?? audience);
    if (denial === undefined) return false;
    log('info', 'Request denied: grant token audience', { method, path, error: denial, grantId });
    reply.status(401).send({
      error: denial,
      message: denial === 'AUDIENCE_UNCONFIGURED'
        ? 'The grant token is for a specific audience and the gateway has no audience configured'
        : 'The grant token audience does not include the audience this gateway expects',
    });
    return true;
  };

  /**
   * Sends the data region denial for a verified grant token and returns true, or
   * returns false when the region is accepted (or the check is off).
   */
  const denyByRegion = (
    token: string,
    routeRegion: string | undefined,
    method: string,
    path: string,
    grantId: string | undefined,
    reply: FastifyReply,
  ): boolean => {
    if (dataRegionCheck === 'off') return false;
    let regions: Map<string, string>;
    try {
      regions = readTokenDataRegions(token);
    } catch (err) {
      // Fail closed: a token whose region binding cannot be read may be bound elsewhere.
      const message = err instanceof Error ? err.message : 'grant token payload cannot be read';
      log('info', 'Request denied: grant token data region unreadable', { method, path, error: message, grantId });
      reply.status(401).send({ error: 'TOKEN_INVALID', message });
      return true;
    }
    const denial = regionDenial(regions, routeRegion ?? dataRegion);
    if (denial === undefined) return false;
    log('info', 'Request denied: grant data region', { method, path, error: denial.code, grantId, details: denial.details });
    reply.status(403).send({ error: denial.code, message: denial.message, details: denial.details });
    return true;
  };

  const app = Fastify({ logger: false });

  // Capture the raw body so it can be relayed byte for byte.
  //
  // Parsing as a string decoded every request as UTF-8, which silently destroys
  // any body that is not valid UTF-8 — a gzipped payload, an image, protobuf.
  // Those bytes cannot be recovered afterwards, so the upstream received
  // mojibake. A buffer keeps the payload intact, and the gateway never needs to
  // look inside it: routing decisions use only the method and path.
  //
  // The built-in application/json and text/plain parsers are removed first;
  // they take precedence over a '*' catch-all, so leaving them in place would
  // let JSON be parsed and re-serialized — reordering keys, dropping the
  // client's exact bytes, and rejecting payloads a proxy has no business
  // validating.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Catch-all route
  app.all('/*', async (req, reply) => {
    const method = req.method;
    const path = req.url.split('?')[0]!;

    // 0. Refuse paths whose authorized form can differ from the forwarded form
    if (!isSafeRequestPath(path)) {
      reply.status(400).send({
        error: 'PATH_INVALID',
        message: 'Request path contains traversal or unsupported characters',
      });
      return;
    }

    // 1. Match route
    const match = matchRoute(method, path, config.routes);
    if (!match) {
      reply.status(404).send({
        error: 'ROUTE_NOT_FOUND',
        message: `No route matches ${method} ${path}`,
      });
      return;
    }

    // 2. Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({
        error: 'TOKEN_MISSING',
        message: 'Authorization header with Bearer token is required',
      });
      return;
    }
    const token = authHeader.slice(7);

    // 3. Verify grant token
    try {
      const grant = await verifyGrantToken(token, {
        jwksUri: config.jwksUri,
        requiredScopes: match.route.requiredScopes,
        ...(currentAuthority !== undefined ? {
          currentAuthority,
          ...((match.route.audience ?? audience) !== undefined ? { audience: (match.route.audience ?? audience)! } : {}),
        } : {}),
        ...(config.expectedPrincipalId !== undefined ? { expectedPrincipalId: config.expectedPrincipalId } : {}),
        ...(config.expectedAgentDid !== undefined ? { expectedAgentDid: config.expectedAgentDid } : {}),
      });

      // 3a. Audience (RFC 7519 section 4.1.3), with the same semantics as the
      //     SDKs' enforce(): the route's audience overrides the gateway's.
      if (denyByAudience(token, match.route.audience, method, path, grant.grantId, reply)) return;

      // 3b. Data region, with the same semantics as the SDKs' enforce(): a grant
      //     bound to a region may only be used by an upstream in that region.
      if (denyByRegion(token, match.route.dataRegion, method, path, grant.grantId, reply)) return;

      log('info', 'Request authorized', {
        method,
        path,
        principal: grant.principalId,
        agent: grant.agentDid,
        grantId: grant.grantId,
      });

      // 3c. Credential by reference: the client presented a reference instead
      //     of a credential; the gateway redeems it for this grant with its own
      //     key and injects the credential upstream. Off, the header is ignored
      //     (and never forwarded, see proxy.ts). A reference the auth service
      //     refuses denies the request; the gateway never forwards a request
      //     without the credential the client asked to be injected.
      let upstreamHeaders = config.upstreamHeaders;
      if (resolveOptions !== undefined) {
        const credentialRef = readCredentialRef(req.headers);
        if (credentialRef !== undefined) {
          const resolved = await resolveCredentialReference(credentialRef, grant.grantId, resolveOptions);
          upstreamHeaders = { ...(config.upstreamHeaders ?? {}), Authorization: `Bearer ${resolved.accessToken}` };
          log('info', 'Credential injected by reference', {
            method,
            path,
            grantId: grant.grantId,
            service: resolved.service,
          });
        }
      }

      // 4. Proxy to upstream
      await proxyRequest(req, reply, grant, {
        upstream: config.upstream,
        upstreamHeaders,
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        reply.status(err.statusCode).send({
          error: err.code,
          message: err.message,
        });
        return;
      }

      if (err instanceof GrantexTokenError) {
        const isExpired = /expired|expiration|\bexp\b["']? claim/i.test(err.message);
        const code = isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
        const isScopeError = err.message.toLowerCase().includes('scope');

        if (isScopeError) {
          // The SDKs' enforce() checks the audience before the scopes, so a
          // token for another relying party is refused as such even when it
          // also lacks the route's scopes. The scope check runs only after the
          // signature and claims are verified, so the payload read here is the
          // verified one. Either reply is a denial.
          if (denyByAudience(token, match.route.audience, method, path, undefined, reply)) return;
          reply.status(403).send({
            error: 'SCOPE_INSUFFICIENT',
            message: err.message,
          });
          return;
        }

        reply.status(401).send({
          error: code,
          message: err.message,
        });
        return;
      }

      log('error', 'Unexpected error', { error: String(err) });
      reply.status(500).send({
        error: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      });
    }
  });

  return app;
}

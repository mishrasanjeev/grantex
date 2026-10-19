import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { buildProtectedResourceMetadata, protectedResourceMetadataPath } from '../resource/metadata.js';
import { ACP_DELEGATED_AUTHENTICATION_SCOPES, UCP_IDENTITY_LINKING_SCOPES } from '../lib/commerce-scopes.js';

/**
 * `grantex_extensions.commerce`: the UCP release and identity-linking scopes,
 * and the Grantex ACP extension scopes, this server offers. A merchant copies
 * the UCP scopes into its profile's `dev.ucp.common.identity_linking`
 * `config.scopes`.
 */
function commerceExtension(ctx: ServerContext): Record<string, unknown> | undefined {
  const commerce = ctx.config.commerce;
  if (commerce === undefined) return undefined;
  const offered = (registry: Readonly<Record<string, unknown>>) =>
    ctx.scopesSupported.filter((scope) => Object.hasOwn(registry, scope));
  return {
    ...(commerce.ucpIdentityLinking !== undefined
      ? { ucp_identity_linking: { version: commerce.ucpIdentityLinking.version, scopes: offered(UCP_IDENTITY_LINKING_SCOPES) } }
      : {}),
    ...(commerce.acpDelegatedAuthentication !== undefined
      ? { acp_delegated_authentication: { scopes: offered(ACP_DELEGATED_AUTHENTICATION_SCOPES), defined_by: 'grantex' } }
      : {}),
  };
}

/** RFC 8414 authorization server metadata for this server. */
export function authorizationServerMetadata(ctx: ServerContext): Record<string, unknown> {
  const { issuer, config } = ctx;
  const consentUi = config.consentUi;
  const commerce = commerceExtension(ctx);
  const extensions = {
    ...(consentUi !== undefined ? { consent_ui_config: consentUi } : {}),
    ...(commerce !== undefined ? { commerce } : {}),
  };
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    introspection_endpoint: `${issuer}/introspect`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE S256 only; `plain` is refused (MCP authorization, Authorization
    // Code Protection: clients refuse to proceed without this field).
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ctx.scopesSupported,
    // RFC 9207: every authorization response carries `iss`.
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: ctx.clientMetadata.enabled,
    resource_indicators_supported: true,
    ...(Object.keys(extensions).length > 0 ? { grantex_extensions: extensions } : {}),
  };
}

export function registerMetadataEndpoint(app: FastifyInstance, ctx: ServerContext): void {
  const asMetadata = authorizationServerMetadata(ctx);
  const sendAs = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(asMetadata);
  };

  app.get('/.well-known/oauth-authorization-server', sendAs);
  // RFC 8414 §3.1: for an issuer with a path, the well-known suffix is
  // inserted between the host and that path.
  const issuerPath = new URL(ctx.issuer).pathname.replace(/\/$/, '');
  if (issuerPath !== '') {
    app.get(`/.well-known/oauth-authorization-server${issuerPath}`, sendAs);
  }

  // RFC 9728 protected-resource metadata for every accepted resource, at the
  // path-inserted well-known location, plus the root location when there is
  // exactly one resource. Useful when the MCP server shares this host;
  // otherwise serve the same document from the MCP server (see
  // protectedResourceMetadataHandler in the Express and Hono entry points).
  const registered = new Set<string>();
  for (const resource of ctx.resources) {
    const document = buildProtectedResourceMetadata({
      resource,
      authorizationServers: [ctx.issuer],
      scopesSupported: ctx.scopesSupported,
      ...(ctx.config.resourceName !== undefined ? { resourceName: ctx.config.resourceName } : {}),
      ...(ctx.config.resourceDocumentation !== undefined ? { resourceDocumentation: ctx.config.resourceDocumentation } : {}),
    });
    const paths = [protectedResourceMetadataPath(resource)];
    if (ctx.resources.length === 1) paths.push('/.well-known/oauth-protected-resource');
    for (const path of paths) {
      if (registered.has(path)) continue;
      registered.add(path);
      app.get(path, async (_request, reply) => {
        reply.header('cache-control', 'public, max-age=300');
        return reply.send(document);
      });
    }
  }
}

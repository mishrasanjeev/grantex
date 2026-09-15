export { createMcpAuthServer } from './server.js';
export { verifyCodeChallenge } from './lib/pkce.js';
export { hashClientSecret } from './lib/verify.js';
export { registerIntrospectEndpoint } from './endpoints/introspect.js';
export { registerRevokeEndpoint } from './endpoints/revoke.js';
export type { McpAuthStorage, RevocationChecker } from './storage/types.js';
export type {
  McpAuthConfig,
  ClientRegistration,
  RegisterClientRequest,
  AuthorizationCode,
  TokenIssuedEvent,
  TokenEndpointAuthMethod,
  PendingAuthorization,
  RefreshTokenBinding,
  ConsentRecord,
  RevocationRecord,
} from './types.js';

// Re-export middleware types (actual middleware in subpath exports)
export type {
  McpGrant as ExpressMcpGrant,
  McpAuthRequest,
  RequireMcpAuthOptions as ExpressAuthOptions,
} from './middleware/express.js';
export type {
  McpGrant as HonoMcpGrant,
  RequireMcpAuthOptions as HonoAuthOptions,
} from './middleware/hono.js';

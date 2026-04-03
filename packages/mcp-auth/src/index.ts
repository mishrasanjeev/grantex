export { createMcpAuthServer } from './server.js';
export { InMemoryClientStore } from './lib/clients.js';
export { InMemoryCodeStore } from './lib/codes.js';
export { verifyCodeChallenge } from './lib/pkce.js';
export { registerIntrospectEndpoint } from './endpoints/introspect.js';
export { registerRevokeEndpoint } from './endpoints/revoke.js';
export type {
  McpAuthConfig,
  ClientRegistration,
  RegisterClientRequest,
  AuthorizationCode,
  ClientStore,
  CodeStore,
  TokenIssuedEvent,
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

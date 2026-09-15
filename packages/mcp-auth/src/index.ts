export { createMcpAuthServer } from './server.js';
export { verifyCodeChallenge } from './lib/pkce.js';
export { hashClientSecret } from './lib/verify.js';
export { registerIntrospectEndpoint } from './endpoints/introspect.js';
export { registerRevokeEndpoint } from './endpoints/revoke.js';
export { canonicalResource, protectedResourceMetadataUrl, protectedResourceMetadataPath } from './lib/resource.js';
export { isClientIdMetadataUrl, ClientMetadataError } from './lib/client-metadata.js';
export type { ClientIdMetadataDocumentOptions, ClientMetadataFailure } from './lib/client-metadata.js';
export { buildProtectedResourceMetadata } from './resource/metadata.js';
export type { ProtectedResourceMetadataOptions } from './resource/metadata.js';
export { createMcpResourceGuard, filterToolsForGrant } from './resource/guard.js';
export type {
  McpGrant,
  McpResourceGuardOptions,
  GuardRequest,
  GuardResult,
  GuardDenialReason,
  DecisionVerifier,
  DecisionCheck,
  DecisionOutcome,
} from './resource/guard.js';
export {
  toolPolicyFromManifests,
  toolPolicyFromScopes,
  manifestScope,
  grantedPermission,
} from './resource/tool-policy.js';
export type {
  LoadedManifest,
  ManifestToolObject,
  ManifestPolicyOptions,
  Permission,
  ToolPolicy,
  ToolRequirement,
} from './resource/tool-policy.js';
export {
  formatBearerChallenge,
  missingTokenChallenge,
  invalidTokenChallenge,
  insufficientScopeChallenge,
  decisionRequiredChallenge,
} from './resource/challenge.js';
export type { ChallengeParams } from './resource/challenge.js';
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

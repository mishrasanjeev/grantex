// Main client
export { Grantex } from './client.js';

// Standalone token verification (no Grantex account needed)
export { verifyGrantToken } from './verify.js';

// Error classes
export {
  GrantexError,
  GrantexApiError,
  GrantexAuthError,
  GrantexTokenError,
  GrantexNetworkError,
} from './errors.js';

// Types
export type {
  GrantexClientOptions,
  // Agents
  Agent,
  RegisterAgentParams,
  UpdateAgentParams,
  ListAgentsResponse,
  // Authorization
  AuthorizeParams,
  AuthorizationRequest,
  // Grants
  Grant,
  ListGrantsParams,
  ListGrantsResponse,
  VerifiedGrant,
  // Tokens
  IntrospectTokenResponse,
  RevokeTokenResponse,
  // Audit
  LogAuditParams,
  AuditEntry,
  ListAuditParams,
  ListAuditResponse,
  // Verify
  VerifyGrantTokenOptions,
} from './types.js';

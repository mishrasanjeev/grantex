// Middleware
export { requireGrantToken, requireScopes, createGrantex } from './middleware.js';

// Error class
export { GrantexMiddlewareError } from './errors.js';

// Types
export type {
  GrantexMiddlewareOptions,
  GrantexRequest,
  GrantexExpressError,
  GrantexExpressErrorCode,
} from './types.js';

// Re-export VerifiedGrant from SDK for convenience
export type { VerifiedGrant } from '@grantex/sdk';

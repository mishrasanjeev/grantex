// Public API
export { A2AGrantexClient } from './client.js';
export { createA2AAuthMiddleware, A2AAuthError, type A2ARequestContext } from './server.js';
export { buildGrantexAgentCard } from './agent-card.js';
export { decodeJwtPayload, isTokenExpired } from './_jwt.js';

// Types
export type {
  A2AGrantexClientOptions,
  A2AAuthMiddlewareOptions,
  GrantexAgentCardOptions,
  VerifiedGrant,
  A2AAgentCard,
  A2AAuthentication,
  A2AAuthScheme,
  GrantexAuthConfig,
  A2ASkill,
  A2ATask,
  A2ATaskStatus,
  A2AMessage,
  A2APart,
  A2AArtifact,
  TaskSendParams,
  TaskGetParams,
  TaskCancelParams,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
} from './types.js';

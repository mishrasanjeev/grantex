/**
 * A2A (Agent-to-Agent) protocol types with Grantex extensions.
 *
 * Based on the Google A2A JSON-RPC 2.0 specification.
 */

// ─── JSON-RPC 2.0 Base ──────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── A2A Task Types ──────────────────────────────────────────────────────────

export interface A2ATask {
  id: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
}

export interface A2ATaskStatus {
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed';
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export type A2APart =
  | { type: 'text'; text: string }
  | { type: 'data'; data: Record<string, unknown>; mimeType?: string }
  | { type: 'file'; file: { uri: string; mimeType?: string } };

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

// ─── A2A Methods ─────────────────────────────────────────────────────────────

export interface TaskSendParams {
  id?: string;
  message: A2AMessage;
  metadata?: Record<string, unknown>;
}

export interface TaskGetParams {
  id: string;
  historyLength?: number;
}

export interface TaskCancelParams {
  id: string;
}

// ─── Agent Card ──────────────────────────────────────────────────────────────

export interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version?: string;
  provider?: {
    organization: string;
    url?: string;
  };
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  authentication?: A2AAuthentication;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills?: A2ASkill[];
}

export interface A2AAuthentication {
  schemes: A2AAuthScheme[];
}

export interface A2AAuthScheme {
  scheme: string;
  grantexConfig?: GrantexAuthConfig;
}

export interface GrantexAuthConfig {
  jwksUri: string;
  issuer: string;
  requiredScopes?: string[];
  delegationAllowed?: boolean;
}

export interface A2ASkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

// ─── Grantex Extensions ─────────────────────────────────────────────────────

export interface VerifiedGrant {
  grantId: string;
  agentDid: string;
  principalId: string;
  developerId: string;
  scopes: string[];
  expiresAt: string;
  delegationDepth?: number;
}

export interface A2AGrantexClientOptions {
  agentUrl: string;
  grantToken: string;
  requiredScope?: string;
}

export interface A2AAuthMiddlewareOptions {
  jwksUri: string;
  issuer?: string;
  requiredScopes?: string[];
}

export interface GrantexAgentCardOptions {
  name: string;
  description: string;
  url: string;
  jwksUri: string;
  issuer: string;
  requiredScopes?: string[];
  delegationAllowed?: boolean;
  version?: string;
  provider?: { organization: string; url?: string };
  capabilities?: A2AAgentCard['capabilities'];
  skills?: A2ASkill[];
}

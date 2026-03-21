/**
 * @grantex/x402 — Agent Spend Authorization for x402 Payment Flows
 *
 * Grantex Delegation Tokens (GDTs) for authorizing AI agent spending
 * via the x402 HTTP Payment Required protocol on Base L2.
 *
 * @packageDocumentation
 */

// Core GDT operations
export { issueGDT, parseExpiry } from './gdt.js';
export { verifyGDT, decodeGDT } from './verify.js';

// Cryptographic utilities
export { generateKeyPair, derivePublicKey } from './crypto.js';

// DID utilities
export { publicKeyToDID, didToPublicKey, isValidDID } from './did.js';

// x402 adapter
export { createX402Agent, x402AgentFetch, HEADERS } from './agent.js';

// Middleware
export { x402Middleware } from './middleware.js';
export type { GDTRequestInfo } from './middleware.js';

// Revocation
export {
  InMemoryRevocationRegistry,
  getRevocationRegistry,
  setRevocationRegistry,
} from './revocation.js';

// Audit
export { InMemoryAuditLog, getAuditLog, setAuditLog } from './audit.js';

// Types
export type {
  Currency,
  SpendPeriod,
  SpendLimit,
  IssueGDTParams,
  GDTToken,
  VerifyContext,
  VerifyResult,
  GDTCredentialSubject,
  VCPayload,
  GDTJWTPayload,
  X402PaymentDetails,
  X402AgentConfig,
  X402FetchOptions,
  X402MiddlewareOptions,
  RevocationRegistry,
  RevokedEntry,
  AuditEventType,
  AuditEntry,
  AuditLog,
  Ed25519KeyPair,
} from './types.js';

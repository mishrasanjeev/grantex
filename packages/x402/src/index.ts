/**
 * @grantex/x402 — Agent Spend Authorization for x402 Payment Flows
 *
 * Official x402 v2 prepaid-wallet authorization plus legacy standalone GDT
 * authorization-context utilities.
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
export {
  createX402Agent,
  x402AgentFetch,
  HEADERS,
  GRANTEX_PREPAID_NETWORK,
  GRANTEX_PREPAID_SCHEME,
  PrepaidPaymentApprovalRequiredError,
} from './agent.js';
export type {
  PrepaidAuthorizationRequest,
  PrepaidAuthorizationResponse,
  PrepaidAuthorization,
  PrepaidApprovalRequired,
} from './agent.js';

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

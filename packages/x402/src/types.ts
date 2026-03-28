/**
 * @grantex/x402 — Type definitions for Grantex Delegation Tokens in x402 payment flows.
 */

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/** Supported stablecoin currencies. */
export type Currency = 'USDC' | 'USDT';

/** Spend-limit period: rolling window in which the limit resets. */
export type SpendPeriod = '1h' | '24h' | '7d' | '30d';

/** Spend-limit configuration attached to a GDT. */
export interface SpendLimit {
  /** Maximum amount allowed in the period. */
  amount: number;
  /** Stablecoin currency. */
  currency: Currency;
  /** Rolling period for the spend limit. */
  period: SpendPeriod;
}

// ---------------------------------------------------------------------------
// GDT issuance
// ---------------------------------------------------------------------------

/** Parameters for issuing a Grantex Delegation Token. */
export interface IssueGDTParams {
  /** DID of the agent being delegated to. */
  agentDID: string;
  /** Scopes the agent is authorised to use (resource:action format). */
  scope: string[];
  /** Maximum spend allowed within the period. */
  spendLimit: SpendLimit;
  /** ISO 8601 duration (e.g. "PT24H") or ISO 8601 datetime for absolute expiry. */
  expiry: string;
  /** Optional parent DIDs for sub-delegation chains. */
  delegationChain?: string[];
  /** Blockchain the payment is authorized on. */
  paymentChain?: string;
  /** Ed25519 private key (raw 32-byte seed) of the issuing principal. */
  signingKey: Uint8Array;
  /** Optional explicit principal DID. Derived from signingKey if omitted. */
  principalDID?: string;
}

/** Result of GDT issuance — a compact JWT string. */
export type GDTToken = string;

// ---------------------------------------------------------------------------
// GDT verification
// ---------------------------------------------------------------------------

/** Context provided when verifying a GDT against a specific request. */
export interface VerifyContext {
  /** The resource:action scope being requested. */
  resource: string;
  /** Spend amount for this single request. */
  amount: number;
  /** Currency of the spend. */
  currency: Currency;
}

/** Result of GDT verification. */
export interface VerifyResult {
  /** Whether the GDT is valid for the given context. */
  valid: boolean;
  /** DID of the agent. */
  agentDID: string;
  /** DID of the issuing principal. */
  principalDID: string;
  /** Remaining spend limit after this request would be deducted. */
  remainingLimit: number;
  /** Error message when valid is false. */
  error?: string;
  /** The unique token ID (jti). */
  tokenId: string;
  /** Scopes granted. */
  scopes: string[];
  /** Expiry timestamp. */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// W3C VC 2.0 structures (JWT payload)
// ---------------------------------------------------------------------------

/** The credentialSubject within a GDT Verifiable Credential. */
export interface GDTCredentialSubject {
  /** Agent DID. */
  id: string;
  /** Authorized scopes. */
  scope: string[];
  /** Spend limit parameters. */
  spendLimit: SpendLimit;
  /** Blockchain for payment (default: "base"). */
  paymentChain: string;
  /** Delegation chain: array of parent DIDs. */
  delegationChain: string[];
}

/** The `vc` claim inside the JWT payload (W3C VC 2.0 JWT encoding). */
export interface VCPayload {
  '@context': string[];
  type: string[];
  credentialSubject: GDTCredentialSubject;
}

/** Full JWT payload for a GDT token. */
export interface GDTJWTPayload {
  /** Issuer — principal DID. */
  iss: string;
  /** Subject — agent DID. */
  sub: string;
  /** VC claim. */
  vc: VCPayload;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Unique token ID (UUID). */
  jti: string;
}

// ---------------------------------------------------------------------------
// x402 adapter
// ---------------------------------------------------------------------------

/** Payment details returned by an x402-gated API in a 402 response. */
export interface X402PaymentDetails {
  /** Amount to pay. */
  amount: number;
  /** Currency (USDC / USDT). */
  currency: Currency;
  /** Recipient wallet address on-chain. */
  recipientAddress: string;
  /** Chain identifier (e.g. "base"). */
  chain: string;
  /** Optional payment memo / reference. */
  memo?: string;
}

/** Configuration for the x402 agent fetch wrapper. */
export interface X402AgentConfig {
  /** Base L2 wallet private key for signing payment transactions. */
  walletPrivateKey?: string;
  /** GDT JWT to attach to all requests. */
  gdt?: string;
  /** Custom payment handler (replaces default stub). */
  paymentHandler?: (details: X402PaymentDetails) => Promise<string>;
}

/** Options for a single x402Agent.fetch() call. */
export interface X402FetchOptions extends RequestInit {
  /** GDT JWT for this specific request (overrides config-level GDT). */
  gdt?: string;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/** Options for the x402 GDT verification middleware. */
export interface X402MiddlewareOptions {
  /** Expected scope(s) the request must match. If not set, any scope passes. */
  requiredScopes?: string[];
  /** Extract the spend amount from the request. Default: reads X-Payment-Amount header. */
  extractAmount?: (req: unknown) => number;
  /** Currency to use for verification. Default: 'USDC'. */
  currency?: Currency;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** Interface for a revocation registry. */
export interface RevocationRegistry {
  /** Revoke a token by its jti. */
  revoke(tokenId: string, reason?: string): Promise<void>;
  /** Check if a token is revoked. */
  isRevoked(tokenId: string): Promise<boolean>;
  /** List all revoked token IDs. */
  listRevoked(): Promise<RevokedEntry[]>;
}

/** Entry in the revocation registry. */
export interface RevokedEntry {
  tokenId: string;
  revokedAt: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Types of auditable events. */
export type AuditEventType = 'issuance' | 'verification' | 'revocation' | 'payment' | 'rejection';

/** A single audit log entry. */
export interface AuditEntry {
  id: string;
  timestamp: string;
  eventType: AuditEventType;
  agentDID: string;
  principalDID: string;
  scope: string[];
  tokenId: string;
  details?: Record<string, unknown>;
}

/** Interface for an audit logger. */
export interface AuditLog {
  /** Append an event to the log. */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry>;
  /** Query entries, newest first. */
  query(opts?: { eventType?: AuditEventType; agentDID?: string; limit?: number }): Promise<AuditEntry[]>;
  /** Export all entries. */
  export(): Promise<AuditEntry[]>;
}

// ---------------------------------------------------------------------------
// Key pair
// ---------------------------------------------------------------------------

/** An Ed25519 key pair for issuance and verification. */
export interface Ed25519KeyPair {
  /** 32-byte private key seed. */
  privateKey: Uint8Array;
  /** 32-byte public key. */
  publicKey: Uint8Array;
  /** did:key identifier derived from the public key. */
  did: string;
}

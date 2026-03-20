// ─── MPP Categories ──────────────────────────────────────────────────────────

export type MPPCategory =
  | 'inference'
  | 'compute'
  | 'data'
  | 'storage'
  | 'search'
  | 'media'
  | 'delivery'
  | 'browser'
  | 'general';

// ─── AgentPassportCredential (W3C VC 2.0) ────────────────────────────────────

export interface AgentPassportCredentialSubject {
  id: string;
  type: 'AIAgent';
  humanPrincipal: string;
  organizationDID: string;
  grantId: string;
  allowedMPPCategories: MPPCategory[];
  maxTransactionAmount: {
    amount: number;
    currency: string;
  };
  paymentRails: string[];
  delegationDepth: number;
  parentPassportId?: string;
}

export interface StatusList2021Entry {
  id: string;
  type: 'StatusList2021Entry';
  statusPurpose: 'revocation';
  statusListIndex: string;
  statusListCredential: string;
}

export interface Ed25519Proof {
  type: 'Ed25519Signature2020';
  created: string;
  verificationMethod: string;
  proofPurpose: 'assertionMethod';
  proofValue: string;
}

export interface AgentPassportCredential {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://grantex.dev/contexts/mpp/v1',
  ];
  type: ['VerifiableCredential', 'AgentPassportCredential'];
  id: string;
  issuer: string;
  validFrom: string;
  validUntil: string;
  credentialSubject: AgentPassportCredentialSubject;
  credentialStatus: StatusList2021Entry;
  proof: Ed25519Proof;
}

// ─── Passport Issuance ───────────────────────────────────────────────────────

export interface IssuePassportOptions {
  agentId: string;
  grantId: string;
  allowedMPPCategories: MPPCategory[];
  maxTransactionAmount: { amount: number; currency: 'USDC' };
  paymentRails?: string[];
  expiresIn?: string;
  parentPassportId?: string;
}

export interface IssuedPassport {
  passportId: string;
  credential: AgentPassportCredential;
  encodedCredential: string;
  expiresAt: Date;
}

// ─── Passport Verification ───────────────────────────────────────────────────

export interface VerifyPassportOptions {
  jwksUri?: string;
  trustedIssuers?: string[];
  requiredCategories?: MPPCategory[];
  maxAmount?: number;
  checkRevocation?: boolean;
  revocationEndpoint?: string;
}

export interface VerifiedPassport {
  valid: true;
  passportId: string;
  agentDID: string;
  humanDID: string;
  organizationDID: string;
  grantId: string;
  allowedCategories: MPPCategory[];
  maxTransactionAmount: { amount: number; currency: string };
  delegationDepth: number;
  expiresAt: Date;
  issuer: string;
}

// ─── MPP Middleware ──────────────────────────────────────────────────────────

export interface MppPassportMiddlewareOptions {
  passport: IssuedPassport;
  autoRefreshThreshold?: number;
}

// ─── Trust Registry ──────────────────────────────────────────────────────────

export interface TrustRegistryOptions {
  endpoint?: string;
  cacheMaxAge?: number;
}

export interface OrgTrustRecord {
  organizationDID: string;
  verifiedAt: Date;
  verificationMethod: 'dns-txt' | 'manual' | 'soc2';
  trustLevel: 'basic' | 'verified' | 'soc2';
  domains: string[];
}

// ─── Server-side types (auth service responses) ──────────────────────────────

export interface IssuePassportResponse {
  passportId: string;
  credential: AgentPassportCredential;
  encodedCredential: string;
  expiresAt: string;
}

export interface GetPassportResponse extends AgentPassportCredential {
  status: 'active' | 'revoked' | 'expired';
}

export interface RevokePassportResponse {
  revoked: boolean;
  revokedAt: string;
}

export interface ListTrustRegistryResponse {
  records: OrgTrustRecord[];
}

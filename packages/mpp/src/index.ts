// ── Passport issuance (agent-side) ──────────────────────────────────────────
export { issuePassport } from './passport.js';

// ── MPP client middleware (agent-side) ──────────────────────────────────────
export { createMppPassportMiddleware, encodePassport } from './middleware.js';

// ── Merchant-side verifier ──────────────────────────────────────────────────
export { verifyPassport, requireAgentPassport, clearJwksCache } from './verifier.js';

// ── Trust Registry ──────────────────────────────────────────────────────────
export { lookupOrgTrust, clearTrustRegistryCache } from './trust-registry.js';

// ── Category mapping ────────────────────────────────────────────────────────
export {
  MPP_CATEGORY_TO_GRANTEX_SCOPE,
  GRANTEX_SCOPE_TO_MPP_CATEGORY,
  ALL_MPP_CATEGORIES,
  categoriesToScopes,
  scopesToCategories,
} from './category-mapping.js';

// ── Errors ──────────────────────────────────────────────────────────────────
export { PassportVerificationError } from './errors.js';
export type { PassportErrorCode } from './errors.js';

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  MPPCategory,
  AgentPassportCredential,
  AgentPassportCredentialSubject,
  StatusList2021Entry,
  Ed25519Proof,
  IssuePassportOptions,
  IssuedPassport,
  VerifyPassportOptions,
  VerifiedPassport,
  MppPassportMiddlewareOptions,
  TrustRegistryOptions,
  OrgTrustRecord,
  IssuePassportResponse,
  GetPassportResponse,
  RevokePassportResponse,
  ListTrustRegistryResponse,
} from './types.js';

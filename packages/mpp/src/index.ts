// ── Passport issuance (agent-side) ──────────────────────────────────────────
export { issuePassport } from './passport.js';

// ── MPP client middleware (agent-side) ──────────────────────────────────────
export { createMppPassportMiddleware, encodePassport } from './middleware.js';

// ── Merchant-side verifier ──────────────────────────────────────────────────
export { verifyPassport, requireAgentPassport, clearJwksCache } from './verifier.js';

// ── "Payment" HTTP authentication scheme (402 flow) ───────────────────────────
export {
  PAYMENT_AUTH_SCHEME,
  PAYMENT_PROBLEMS,
  PAYMENT_PROBLEM_BASE,
  PAYMENT_RECEIPT_HEADER,
  PaymentAuthError,
  bodyDigest,
  createPaymentChallenge,
  decodeChallengeRequest,
  formatPaymentChallenge,
  formatPaymentCredential,
  formatPaymentReceipt,
  parsePaymentChallenges,
  parsePaymentCredential,
  parsePaymentReceipt,
  paymentChallengeId,
  paymentProblem,
  requirePayment,
  verifyPaymentCredential,
} from './payment-auth.js';
export type {
  CreateChallengeOptions,
  PaymentChallenge,
  PaymentCredential,
  PaymentOffer,
  PaymentProblem,
  PaymentProblemCode,
  PaymentReceipt,
  RequirePaymentOptions,
  VerifiedPayment,
  VerifyCredentialOptions,
} from './payment-auth.js';

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
  KyaTierClaim,
} from './types.js';

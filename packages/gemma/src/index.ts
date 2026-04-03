/* ------------------------------------------------------------------ */
/*  Verifier                                                           */
/* ------------------------------------------------------------------ */
export {
  createOfflineVerifier,
  type OfflineVerifierOptions,
  type OfflineVerifier,
  type VerifiedGrant,
} from './verifier/offline-verifier.js';

export {
  type JWKSSnapshot,
  importKeyByKid,
  isSnapshotExpired,
} from './verifier/jwks-cache.js';

export {
  enforceScopes,
  hasScope,
} from './verifier/scope-enforcer.js';

/* ------------------------------------------------------------------ */
/*  Consent bundles                                                    */
/* ------------------------------------------------------------------ */
export {
  createConsentBundle,
  type CreateConsentBundleOptions,
  type ConsentBundle,
} from './consent/consent-bundle.js';

export {
  storeBundle,
  loadBundle,
} from './consent/bundle-storage.js';

export {
  refreshBundle,
  shouldRefresh,
} from './consent/bundle-refresh.js';

/* ------------------------------------------------------------------ */
/*  Audit log                                                          */
/* ------------------------------------------------------------------ */
export {
  createOfflineAuditLog,
  verifyEntrySignature,
  type OfflineAuditLogOptions,
  type OfflineAuditLog,
  type AuditEntry,
} from './audit/offline-audit-log.js';

export {
  computeEntryHash,
  verifyChain,
  GENESIS_HASH,
  type SignedAuditEntry,
} from './audit/hash-chain.js';

export {
  syncAuditLog,
  type SyncOptions,
  type SyncResult,
} from './audit/audit-sync.js';

/* ------------------------------------------------------------------ */
/*  Adapters                                                           */
/* ------------------------------------------------------------------ */
export {
  withGrantexAuth as withGrantexAuthADK,
  type GoogleADKAuthOptions,
} from './adapters/google-adk.js';

export {
  withGrantexAuth as withGrantexAuthLangChain,
  type LangChainAuthOptions,
} from './adapters/langchain.js';

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */
export {
  GrantexAuthError,
  OfflineVerificationError,
  ScopeViolationError,
  TokenExpiredError,
  BundleTamperedError,
  HashChainError,
} from './errors.js';

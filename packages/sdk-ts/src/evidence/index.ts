/**
 * Evidence packages: build, canonicalise and verify (PRD G-5).
 *
 * One JSON document per case: the grant chain root to leaf with purposes and
 * caps, every tool call with input and output hashes and the upstream records
 * it returned, run context (model, prompt, policy and schema versions), policy
 * evaluations with inputs, recommendations with citations, human decisions and
 * revocations - in a hash chain whose root is recorded in the auth service's
 * audit chain. Specified in `spec/evidence-package.md`; the Python SDK
 * (`grantex.evidence`) implements the same rules, and both are tested against
 * `spec/examples/evidence/`.
 */
export {
  buildPackage,
  anchorAuditEntry,
  attachAnchor,
  attachSignature,
  serializePackage,
  type BuiltPackage,
  type EvidenceRecord,
  type PrivacySettings,
} from './build.js';
export { CanonicalizationError, canonicalize } from './canonical.js';
export { DEFAULT_MAX_BYTES } from './document.js';
export {
  IDENTIFIER_CLASSES,
  auditEntryHash,
  chainRoot,
  decisionActionHash,
  digest,
  digestBytes,
  entryHash,
  headerHash,
  isPseudonym,
  pseudonymise,
  type IdentifierClass,
} from './hashing.js';
export {
  EvidenceBuildError,
  VerificationCode,
  VerificationFailure,
  verificationResultToJson,
  type VerificationCodeValue,
  type VerificationResult,
} from './result.js';
export { SIGNATURE_TYPE, signRoot, verifySignature, type EvidenceSignature } from './signature.js';
export { upstreamRecordsFor, type UpstreamRecordTrace } from './trace.js';
export { FORMAT, SUPPORTED_VERSIONS, checkDocument, verifyPackage, type VerifyOptions } from './verify.js';

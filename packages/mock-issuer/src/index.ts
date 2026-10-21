// SPDX-License-Identifier: Apache-2.0
//
// @grantex/mock-issuer: a mock accredited issuer for local runs and CI.
// Not published. See README.md and docs/issuers/running-the-mock-issuer.md.

export { MockIssuerError, type MockIssuerErrorCode } from './errors.ts';
export { ulid } from './ids.ts';
export { ISSUER_KEY_FILE } from './keys.ts';
export {
  ATTESTATION_TYP,
  CI_STATUS_TTL_SECONDS,
  DEFAULT_PASSPORT_LIFETIME_SECONDS,
  MOCK_ISSUER_ENTITY_ID,
  MOCK_ISSUER_STATUS_LIST_BASE,
  MockIssuer,
  STANDARD_STATUS_TTL_SECONDS,
  STATE_FILE,
  STATUS_LIST_LIFETIME_SECONDS,
  TRUST_MARK_AGENT_IDENTITY,
  TRUST_MARK_PROVIDER_ENTITY,
  type BitstringStatusPurpose,
  type IssuePassportRequest,
  type IssuedAgentPassport,
  type MockAttestationType,
  type MockIssuerOptions,
  type PassportStatus,
} from './issuer.ts';
export {
  POSSESSION_CHALLENGE_TTL_SECONDS,
  POSSESSION_PROOF_TYP,
  signPossessionProof,
  type PossessionChallenge,
} from './possession.ts';
export {
  ATTESTATION_MEDIA_TYPE,
  DEFAULT_ATTESTATION_PATH,
  MAX_REGISTRY_RESPONSE_BYTES,
  REGISTRY_TIMEOUT_MS,
  postAttestation,
  type PostAttestationParams,
  type PostAttestationResult,
} from './registry-client.ts';
export {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  JWK_SET_MEDIA_TYPE,
  LOOPBACK_HOST,
  TOKEN_STATUS_LIST_MEDIA_TYPE,
  VC_JWT_MEDIA_TYPE,
  startMockIssuerServer,
  type MockIssuerServer,
  type MockIssuerServerOptions,
} from './server.ts';
export {
  BITSTRING_MIN_ENTRIES,
  StatusListCodecError,
  TOKEN_STATUS,
  decodeBitstringStatusList,
  decodeTokenStatusList,
  encodeBitstringStatusList,
  encodeTokenStatusList,
  type DecodedBitstringStatusList,
  type DecodedTokenStatusList,
  type StatusEntry,
  type TokenStatusBits,
} from './status-list-codec.ts';
export { PassportStatusStore, STATUS_LIST_CAPACITY, type StatusSlot } from './status-store.ts';

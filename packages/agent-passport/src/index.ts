// SPDX-License-Identifier: Apache-2.0
//
// @grantex/agent-passport: the Agent Passport SD-JWT VC profile
// (spec/agent-passport-1.0.md). The Python package grantex-agent-passport
// implements the same rules and passes the same vectors.

export { PassportError, type PassportErrorCode } from './errors.ts';
export { jwkThumbprint, keysEqual, type Jwk } from './jwk.ts';
export {
  SD_ALG,
  disclosureDigest,
  encodeDisclosure,
  externalCredentialHash,
  selectDisclosures,
} from './sd-jwt.ts';
export {
  DEFAULT_KB_MAX_AGE_SECONDS,
  KB_JWT_TYP,
  createKeyBindingJwt,
  type CreateKeyBindingParams,
  type KeyBindingRequirement,
  type KeyBindingResult,
} from './key-binding.ts';
export {
  DISCLOSABLE_CLAIMS,
  MAX_PASSPORT_LIFETIME_SECONDS,
  PASSPORT_TYP,
  PASSPORT_VCT,
  issuePassport,
  verifyPassport,
  type AgentClaim,
  type IssuePassportParams,
  type IssuedDisclosure,
  type IssuedPassport,
  type IssuerKeyResolver,
  type PassportClaims,
  type ProviderClaim,
  type StatusReference,
  type VerificationClaim,
  type VerifiedDisclosure,
  type VerifiedPassport,
  type VerifyPassportOptions,
} from './passport.ts';

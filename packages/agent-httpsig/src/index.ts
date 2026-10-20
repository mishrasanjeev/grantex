// SPDX-License-Identifier: Apache-2.0
export { AgentHttpSigError } from './errors.js';
export {
  AGENT_PAYER_AUTH_TAG,
  COVERED_COMPONENTS,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_SIGNATURE_LABEL,
  DEFAULT_SIGNATURE_WINDOW_SECONDS,
  INLINE_PRESENTATION_MAX_OCTETS,
  InMemoryNonceStore,
  MAX_CLOCK_SKEW_SECONDS,
  MAX_CONTENT_NESTING_DEPTH,
  MAX_SIGNATURE_WINDOW_SECONDS,
  SIGNATURE_PARAMETERS,
  contentDigest,
  sign,
  verify,
} from './profile.js';
export type {
  DenialCode,
  DenialReason,
  NonceStore,
  SignOptions,
  SignResult,
  VerifyFailure,
  VerifyOptions,
  VerifyResult,
  VerifySuccess,
} from './profile.js';
export {
  SIGNATURE_AGENT_FIELD,
  SIGNATURE_AGENT_TYPES,
  SIGNATURE_PROFILES,
  TAP_BROWSER_TAG,
  TAP_MAX_WINDOW_SECONDS,
  TAP_NONCE_REPLAY_WINDOW_SECONDS,
  TAP_PAYER_TAG,
  WEB_BOT_AUTH_MAX_WINDOW_SECONDS,
  WEB_BOT_AUTH_TAG,
  combineSignatures,
  parseSignatureAgent,
  serializeSignatureAgent,
  signWithProfile,
  verifyWithProfile,
} from './profiles.js';
export type {
  GrantexProfileSignOptions,
  GrantexProfileVerifyOptions,
  KeyReference,
  ProfileDefinition,
  ProfileDenialReason,
  ProfileName,
  ProfileSignOptions,
  ProfileSignResult,
  ProfileVerifyFailure,
  ProfileVerifyOptions,
  ProfileVerifyResult,
  ProfileVerifySuccess,
  SignatureAgent,
  SignatureAgentType,
  TapSignOptions,
  TapVerifyOptions,
  WebBotAuthSignOptions,
  WebBotAuthVerifyOptions,
} from './profiles.js';
export {
  DEFAULT_TAP_BODY_MEMBERS,
  GRANTEX_CONSENT_RECORD_TYPE,
  buildAgenticConsumer,
  buildAgenticPaymentContainer,
  buildGrantexConsentRecord,
  jcsCanonicalizer,
  signTapObject,
  verifyTapBodyObjects,
  withTapBodyObjects,
} from './tap.js';
export type {
  AgenticConsumerInput,
  AgenticPaymentContainerInput,
  GrantexConsentSource,
  TapBodyMembers,
  TapBodyVerification,
  TapCanonicalizer,
  TapObjectCheck,
  TapObjectProblem,
  VerifyTapBodyOptions,
} from './tap.js';
export { canonicalJson } from './canonical.js';
export {
  DIRECTORY_SIGNATURE_WINDOW_SECONDS,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  SIGNATURE_DIRECTORY_PATH,
  SIGNATURE_DIRECTORY_TAG,
  buildSignatureDirectory,
  signDirectoryResponse,
  verifyDirectoryResponse,
} from './directory.js';
export type { DirectoryKey, SignDirectoryOptions, SignatureDirectory, VerifiedDirectory, VerifyDirectoryOptions } from './directory.js';
export { jwkThumbprint, publicJwk, verifySignatureValue } from './keys.js';
export type { AgentJwk, SignatureAlgorithm } from './keys.js';
export { createSignatureBase, signatureBaseFor } from './message.js';
export type { AgentRequest, AgentResponse, HeaderValue, HeadersInit, HttpMessage } from './message.js';
export {
  parseDictionary,
  parseItem,
  parseList,
  serializeDictionary,
  serializeInnerList,
  serializeItem,
  serializeList,
  serializeMember,
} from './structured-fields.js';
export type { BareItem, Dictionary, InnerList, Item, List, Member, Parameters } from './structured-fields.js';

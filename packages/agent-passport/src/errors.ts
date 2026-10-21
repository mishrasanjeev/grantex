// SPDX-License-Identifier: Apache-2.0
//
// Every refusal is a PassportError with a code and a reason. The codes that
// have a counterpart in the registry denial codes (passport_invalid_signature,
// passport_expired, key_binding_mismatch, key_unproven, audience_mismatch) use
// it; passport_revoked and status_stale are the status refusals of
// spec/agent-passport-1.0.md section 4; passport_malformed and passport_not_accepted cover a credential that is
// not a well-formed Agent Passport and one this relying party's options refuse.
// The reason says which rule failed; spec/agent-passport-1.0.md lists them.

export type PassportErrorCode =
  | 'passport_malformed'
  | 'passport_not_accepted'
  | 'passport_invalid_signature'
  | 'passport_expired'
  | 'key_unproven'
  | 'key_binding_mismatch'
  | 'audience_mismatch'
  | 'passport_revoked'
  | 'status_stale';

export class PassportError extends Error {
  readonly code: PassportErrorCode;
  readonly reason: string;

  constructor(code: PassportErrorCode, reason: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PassportError';
    this.code = code;
    this.reason = reason;
  }
}

export function malformed(reason: string, message: string): PassportError {
  return new PassportError('passport_malformed', reason, message);
}

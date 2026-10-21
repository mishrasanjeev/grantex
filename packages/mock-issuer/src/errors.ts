// SPDX-License-Identifier: Apache-2.0
//
// Every refusal is a MockIssuerError with a code. Where the refusal has a
// counterpart among the registry denial codes (PRD Appendix C:
// key_unproven, key_binding_mismatch, audience_mismatch, passport_revoked,
// attestation_not_registered) the mock uses it; the other codes describe a
// caller mistake (invalid_request), a list or state the mock does not have,
// or a registry that refused or could not be reached.

export type MockIssuerErrorCode =
  | 'key_unproven'
  | 'key_binding_mismatch'
  | 'audience_mismatch'
  | 'passport_revoked'
  | 'attestation_not_registered'
  | 'status_list_not_found'
  | 'allocation_exhausted'
  | 'invalid_request'
  | 'state_unreadable'
  | 'registry_refused'
  | 'registry_unreachable';

export class MockIssuerError extends Error {
  readonly code: MockIssuerErrorCode;
  /** The registry's HTTP status, for registry_refused. */
  readonly httpStatus: number | undefined;
  /** The registry's answer, for registry_refused. */
  readonly body: unknown;

  constructor(
    code: MockIssuerErrorCode,
    message: string,
    options: { cause?: unknown; httpStatus?: number; body?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MockIssuerError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.body = options.body;
  }
}

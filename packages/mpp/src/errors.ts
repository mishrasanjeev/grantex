export type PassportErrorCode =
  | 'PASSPORT_EXPIRED'
  | 'PASSPORT_REVOKED'
  | 'INVALID_SIGNATURE'
  | 'UNTRUSTED_ISSUER'
  | 'CATEGORY_MISMATCH'
  | 'AMOUNT_EXCEEDED'
  | 'MISSING_PASSPORT'
  | 'MALFORMED_CREDENTIAL';

export class PassportVerificationError extends Error {
  readonly code: PassportErrorCode;

  constructor(code: PassportErrorCode, message: string) {
    super(message);
    this.name = 'PassportVerificationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

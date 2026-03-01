export type AdapterErrorCode =
  | 'SCOPE_MISSING'
  | 'CONSTRAINT_VIOLATED'
  | 'TOKEN_INVALID'
  | 'UPSTREAM_ERROR'
  | 'CREDENTIAL_ERROR';

export class GrantexAdapterError extends Error {
  readonly code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, GrantexAdapterError.prototype);
  }
}

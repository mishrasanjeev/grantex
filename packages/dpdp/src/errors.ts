/**
 * Error classes for the @grantex/dpdp module.
 *
 * When an error comes from the Grantex auth service, `statusCode` is the HTTP
 * status, `code` is the server's error code (for example `ALREADY_WITHDRAWN`,
 * `CONFLICT`, `GONE`) and `requestId` is the server's request id, all taken from
 * the error body `{ message, code, requestId }`. When the body carries no code,
 * `code` is the class's own code. Errors raised by client-side validation carry
 * the class's own code and status 400.
 */

/** Details of a failed call, as the server reported them. */
export interface DpdpErrorDetails {
  /** The server's error code; the class default is used when absent. */
  code?: string;
  /** HTTP status of the failed response. */
  statusCode?: number;
  /** The server's request id, for support and log correlation. */
  requestId?: string;
}

export class DpdpError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;
  public readonly requestId?: string;

  constructor(message: string, code: string, statusCode?: number, requestId?: string) {
    super(message);
    this.name = 'DpdpError';
    this.code = code;
    this.statusCode = statusCode;
    if (requestId !== undefined) this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConsentRequiredError extends DpdpError {
  constructor(message = 'Consent record is required before processing data') {
    super(message, 'CONSENT_REQUIRED', 403);
    this.name = 'ConsentRequiredError';
  }
}

export class PurposeViolationError extends DpdpError {
  public readonly missingScopes: string[];

  constructor(purposeId: string, missingScopes: string[]) {
    super(
      `Purpose "${purposeId}" requires scopes [${missingScopes.join(', ')}] that are not granted`,
      'PURPOSE_VIOLATION',
      403,
    );
    this.name = 'PurposeViolationError';
    this.missingScopes = missingScopes;
  }
}

export class WithdrawalError extends DpdpError {
  constructor(message: string, details: DpdpErrorDetails = {}) {
    super(message, details.code ?? 'WITHDRAWAL_ERROR', details.statusCode ?? 400, details.requestId);
    this.name = 'WithdrawalError';
  }
}

export class GrievanceError extends DpdpError {
  constructor(message: string, details: DpdpErrorDetails = {}) {
    super(message, details.code ?? 'GRIEVANCE_ERROR', details.statusCode ?? 400, details.requestId);
    this.name = 'GrievanceError';
  }
}

export class ExportError extends DpdpError {
  constructor(message: string, details: DpdpErrorDetails = {}) {
    super(message, details.code ?? 'EXPORT_ERROR', details.statusCode ?? 400, details.requestId);
    this.name = 'ExportError';
  }
}

/**
 * The export has expired and its data was purged (HTTP 410, code `GONE`).
 * Request a new export.
 */
export class ExportExpiredError extends ExportError {
  constructor(message: string, details: DpdpErrorDetails = {}) {
    super(message, { code: 'GONE', statusCode: 410, ...details });
    this.name = 'ExportExpiredError';
  }
}

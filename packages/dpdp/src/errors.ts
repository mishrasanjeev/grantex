/**
 * Error classes for the @grantex/dpdp module.
 */

export class DpdpError extends Error {
  public readonly code: string;
  public readonly statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'DpdpError';
    this.code = code;
    this.statusCode = statusCode;
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
  constructor(message: string) {
    super(message, 'WITHDRAWAL_ERROR', 400);
    this.name = 'WithdrawalError';
  }
}

export class GrievanceError extends DpdpError {
  constructor(message: string) {
    super(message, 'GRIEVANCE_ERROR', 400);
    this.name = 'GrievanceError';
  }
}

export class ExportError extends DpdpError {
  constructor(message: string) {
    super(message, 'EXPORT_ERROR', 400);
    this.name = 'ExportError';
  }
}
